import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { classify } from "../src/policy.js";
import { Ledger } from "../src/ledger.js";
import { extractPaths, restoreSnapshot, takeSnapshot } from "../src/snapshot.js";
import { RecoilCore } from "../src/core.js";
import type { RecoilConfig } from "../src/config.js";

let workDir: string;

const config = (overrides: Partial<RecoilConfig> = {}): RecoilConfig => ({
  servers: { mock: { command: "unused" } },
  rules: [],
  defaultTier: "undoable",
  commitWindowMs: 30 * 60 * 1000,
  allowAgentCommit: false,
  maxSnapshotBytes: 1024 * 1024,
  dataDir: join(workDir, ".recoil"),
  ...overrides,
});

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "recoil-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("policy", () => {
  it("passes read-shaped tools, holds destructive ones, defaults the rest", () => {
    const c = config();
    expect(classify("fs", "read_file", c)).toBe("pass");
    expect(classify("fs", "list_directory", c)).toBe("pass");
    expect(classify("fs", "delete_file", c)).toBe("hold");
    expect(classify("mail", "send_email", c)).toBe("hold");
    expect(classify("gh", "merge_pull_request", c)).toBe("hold");
    expect(classify("fs", "write_file", c)).toBe("undoable");
  });

  it("user rules win over built-ins, and can be server-scoped", () => {
    const c = config({
      rules: [
        { match: "delete_scratch*", tier: "pass" },
        { match: "write*", server: "prod", tier: "hold" },
      ],
    });
    expect(classify("fs", "delete_scratch_file", c)).toBe("pass");
    expect(classify("prod", "write_file", c)).toBe("hold");
    expect(classify("fs", "write_file", c)).toBe("undoable");
  });
});

describe("ledger", () => {
  it("replays actions and transitions from JSONL", () => {
    const ledger = new Ledger(join(workDir, "ledger.jsonl"));
    ledger.record({ id: "aa", ts: "t", server: "s", tool: "x", args: {}, tier: "hold", status: "held" });
    ledger.transition("aa", "committed");
    expect(ledger.get("aa")?.status).toBe("committed");
    expect(ledger.all()).toHaveLength(1);
  });
});

describe("snapshot", () => {
  it("extracts only absolute paths under path-shaped keys", () => {
    const paths = extractPaths({
      path: "/a/b.txt",
      target_file: "/c.txt",
      content: "/looks/like/a/path/but/wrong-key",
      nested: { paths: ["/d.txt", "relative.txt"] },
    });
    expect(paths.sort()).toEqual(["/a/b.txt", "/c.txt", "/d.txt"]);
  });

  it("round-trips overwrite and creation", () => {
    const file = join(workDir, "f.txt");
    const created = join(workDir, "new.txt");
    writeFileSync(file, "before");
    const manifest = takeSnapshot("id1", [file, created], join(workDir, "snaps"), 1024)!;
    writeFileSync(file, "after");
    writeFileSync(created, "i am new");
    restoreSnapshot(manifest);
    expect(readFileSync(file, "utf8")).toBe("before");
    expect(existsSync(created)).toBe(false);
  });

  it("refuses snapshots over budget", () => {
    const big = join(workDir, "big.bin");
    writeFileSync(big, Buffer.alloc(2048));
    expect(takeSnapshot("id2", [big], join(workDir, "snaps"), 1024)).toBeNull();
  });
});

/** A downstream MCP server with real file side effects, connected in-memory. */
async function mockDownstream(): Promise<Client> {
  const server = new Server({ name: "mock", version: "0.0.1" }, { capabilities: { tools: {} } });
  const tool = (name: string, props: Record<string, unknown> = { path: { type: "string" } }) => ({
    name,
    inputSchema: { type: "object" as const, properties: props },
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [tool("read_file"), tool("write_file", { path: { type: "string" }, content: { type: "string" } }), tool("delete_file")],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = request.params.arguments as { path: string; content?: string };
    if (name === "read_file") return { content: [{ type: "text", text: readFileSync(args.path, "utf8") }] };
    if (name === "write_file") {
      writeFileSync(args.path, args.content ?? "");
      return { content: [{ type: "text", text: "written" }] };
    }
    rmSync(args.path, { force: true });
    return { content: [{ type: "text", text: "deleted" }] };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

describe("end-to-end", () => {
  it("audits reads, recoils writes, holds deletes until a human commits", async () => {
    const core = new RecoilCore(config(), () => {});
    await core.attach("mock", await mockDownstream());
    expect(core.listTools().map((t) => t.name)).toContain("recoil_undo");

    const file = join(workDir, "data.txt");
    writeFileSync(file, "original");

    // pass: read is forwarded and audited
    const read = await core.callTool("read_file", { path: file });
    expect(read.content[0].text).toBe("original");

    // undoable: write executes, then recoils back to the original
    await core.callTool("write_file", { path: file, content: "clobbered" });
    expect(readFileSync(file, "utf8")).toBe("clobbered");
    const applied = core.ledger.all().find((a) => a.tool === "write_file")!;
    expect(applied.status).toBe("applied");
    const undone = await core.callTool("recoil_undo", { id: applied.id });
    expect(undone.isError).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe("original");

    // hold: delete does NOT run; identical retry dedupes; agent cannot commit
    const heldResult = await core.callTool("delete_file", { path: file });
    expect(existsSync(file)).toBe(true);
    const held = core.ledger.all().find((a) => a.tool === "delete_file")!;
    expect(held.status).toBe("held");
    const retry = await core.callTool("delete_file", { path: file });
    expect(retry.content[0].text).toContain(held.id);
    expect(core.ledger.all().filter((a) => a.tool === "delete_file")).toHaveLength(1);
    const agentCommit = await core.callTool("recoil_commit", { id: held.id });
    expect(agentCommit.isError).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(heldResult.content[0].text).toContain("recoil commit");

    // human commits via the command file; the delete finally runs
    mkdirSync(config().dataDir, { recursive: true });
    appendFileSync(join(config().dataDir, "commands.jsonl"), JSON.stringify({ op: "commit", id: held.id }) + "\n");
    await core.pollCommands();
    expect(existsSync(file)).toBe(false);
    expect(core.ledger.get(held.id)?.status).toBe("committed");
  });

  it("discards a held action on undo, and finalizes expired actions on sweep", async () => {
    const core = new RecoilCore(config({ commitWindowMs: 0 }), () => {});
    await core.attach("mock", await mockDownstream());

    const file = join(workDir, "keep.txt");
    writeFileSync(file, "safe");
    const heldMessage = await core.callTool("delete_file", { path: file });
    const id = JSON.parse(heldMessage.content[0].text).id as string;
    await core.callTool("recoil_undo", { id });
    expect(core.ledger.get(id)?.status).toBe("discarded");
    expect(existsSync(file)).toBe(true);

    await core.callTool("write_file", { path: file, content: "v2" });
    const write = core.ledger.all().find((a) => a.tool === "write_file")!;
    core.sweep(Date.now() + 1);
    expect(core.ledger.get(write.id)?.status).toBe("final");
  });
});
