// Live demo of Recoil's full lifecycle against the official filesystem MCP
// server. Run from the repo root after `npm run build`:
//
//   mkdir -p /tmp/recoil-demo/ws && echo "precious data" > /tmp/recoil-demo/ws/notes.txt
//   node examples/demo.mjs
//
// It connects to Recoil exactly the way any MCP host (Claude Code, NanoClaw,
// a desktop client) would, then: clobbers a file and recoils it, watches a
// destructive move get held, sees the agent's commit refused, and finally
// approves it the human way.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";

const WS = "/tmp/recoil-demo/ws";
const DATA = "/tmp/recoil-demo/.recoil";
mkdirSync(WS, { recursive: true });
writeFileSync(`${WS}/notes.txt`, "precious data");
rmSync(`${WS}/trash.txt`, { force: true });
rmSync(DATA, { recursive: true, force: true });
writeFileSync(
  "/tmp/recoil-demo/config.json",
  JSON.stringify({
    servers: { fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", WS] } },
    rules: [{ match: "move*", tier: "hold" }],
    dataDir: DATA,
  }),
);

const client = new Client({ name: "demo", version: "0.0.1" });
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: ["dist/index.js", "/tmp/recoil-demo/config.json"],
    stderr: "inherit",
    env: { ...process.env },
  }),
);

const { tools } = await client.listTools();
console.log(`\n${tools.length} tools exposed (downstream + recoil_ledger/undo/commit)\n`);

console.log("1. Agent overwrites notes.txt ...");
await client.callTool({ name: "write_file", arguments: { path: `${WS}/notes.txt`, content: "agent clobbered this" } });
console.log("   file now reads:", readFileSync(`${WS}/notes.txt`, "utf8"));

console.log("2. Recoil it ...");
const ledger = JSON.parse((await client.callTool({ name: "recoil_ledger", arguments: {} })).content[0].text);
const write = ledger.find((entry) => entry.tool === "write_file");
await client.callTool({ name: "recoil_undo", arguments: { id: write.id } });
console.log("   file now reads:", readFileSync(`${WS}/notes.txt`, "utf8"));

console.log("3. Agent tries a destructive move ...");
const held = JSON.parse(
  (await client.callTool({ name: "move_file", arguments: { source: `${WS}/notes.txt`, destination: `${WS}/trash.txt` } }))
    .content[0].text,
);
console.log(`   held as ${held.id} — file untouched: ${existsSync(`${WS}/notes.txt`)}`);

console.log("4. Agent tries to approve its own action ...");
const refusal = await client.callTool({ name: "recoil_commit", arguments: { id: held.id } });
console.log("   ", refusal.content[0].text);

console.log("5. The human approves (recoil commit) ...");
appendFileSync(`${DATA}/commands.jsonl`, JSON.stringify({ op: "commit", id: held.id }) + "\n");
await new Promise((resolve) => setTimeout(resolve, 1500));
console.log(`   move executed — trash.txt exists: ${existsSync(`${WS}/trash.txt`)}\n`);

await client.close();
