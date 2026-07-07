import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RecoilConfig } from "./config.js";
import { classify } from "./policy.js";
import { ActionRecord, Ledger } from "./ledger.js";
import { extractPaths, restoreSnapshot, takeSnapshot } from "./snapshot.js";

interface Routed {
  server: string;
  tool: string;
  definition: Tool;
}

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

const text = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const errorText = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

export const CONTROL_TOOLS: Tool[] = [
  {
    name: "recoil_ledger",
    description:
      "Audit trail of every tool call Recoil has seen, with status (passed/applied/held/committed/recoiled/discarded/final/failed).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max entries, newest first (default 20)" } },
    },
  },
  {
    name: "recoil_undo",
    description:
      "Recoil an action: restores the pre-action snapshot of an applied action, or cancels a held action before it ever runs.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Action id from recoil_ledger" } },
      required: ["id"],
    },
  },
  {
    name: "recoil_commit",
    description:
      "Approve a HELD action so it actually executes. By default only a human may commit (via `recoil commit <id>` on the host).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Action id from recoil_ledger" } },
      required: ["id"],
    },
  },
];

export class RecoilCore {
  private clients = new Map<string, Client>();
  private tools = new Map<string, Routed>();
  private heldByFingerprint = new Map<string, string>();
  readonly ledger: Ledger;
  private commandCursor = 0;

  constructor(
    private config: RecoilConfig,
    private log: (message: string) => void = (m) => console.error(`[recoil] ${m}`),
  ) {
    this.ledger = new Ledger(join(config.dataDir, "ledger.jsonl"));
  }

  /** Production path: spawn and connect every configured downstream server. */
  async start(): Promise<void> {
    for (const [name, spec] of Object.entries(this.config.servers)) {
      const client = new Client({ name: `recoil-proxy-${name}`, version: "0.1.0" });
      await client.connect(
        new StdioClientTransport({
          command: spec.command,
          args: spec.args ?? [],
          env: { ...(process.env as Record<string, string>), ...(spec.env ?? {}) },
          stderr: "inherit",
        }),
      );
      await this.attach(name, client);
    }
  }

  /** Test/embedding path: attach an already-connected MCP client. */
  async attach(name: string, client: Client): Promise<void> {
    this.clients.set(name, client);
    const { tools } = await client.listTools();
    for (const definition of tools) {
      // Flat names while unique; on collision the later server gets a prefix.
      const exposed = this.tools.has(definition.name) ? `${name}__${definition.name}` : definition.name;
      // Drop outputSchema: Recoil may answer any call with a hold notice, so
      // it cannot promise the downstream's structured output contract.
      const { outputSchema: _outputSchema, ...passthrough } = definition;
      this.tools.set(exposed, { server: name, tool: definition.name, definition: { ...passthrough, name: exposed } });
    }
    this.log(`attached ${name} (${tools.length} tools)`);
  }

  listTools(): Tool[] {
    return [...[...this.tools.values()].map((r) => r.definition), ...CONTROL_TOOLS];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (name === "recoil_ledger") return this.handleLedger(args);
    if (name === "recoil_undo") return this.handleUndo(String(args.id ?? ""));
    if (name === "recoil_commit") return this.handleCommit(String(args.id ?? ""));

    const routed = this.tools.get(name);
    if (!routed) return errorText(`Unknown tool: ${name}`);

    const tier = classify(routed.server, routed.tool, this.config);
    const id = this.ledger.newId();
    const base: ActionRecord = {
      id,
      ts: new Date().toISOString(),
      server: routed.server,
      tool: routed.tool,
      args,
      tier,
      status: "passed",
    };

    if (tier === "hold") return this.hold(base);
    if (tier === "pass") {
      this.ledger.record(base);
      return this.forward(routed, args, id);
    }

    // undoable: snapshot what we can, then act. An oversized snapshot means
    // we cannot promise recovery, so the action escalates to a hold.
    const paths = extractPaths(args);
    if (paths.length > 0) {
      const manifest = takeSnapshot(id, paths, join(this.config.dataDir, "snapshots"), this.config.maxSnapshotBytes);
      if (manifest === null) {
        return this.hold({ ...base, note: "escalated: snapshot exceeds maxSnapshotBytes" });
      }
      base.undo = manifest;
    }
    base.status = "applied";
    this.ledger.record(base);
    return this.forward(routed, args, id);
  }

  /** Finalize applied actions whose recoil window has elapsed. */
  sweep(now = Date.now()): void {
    for (const action of this.ledger.all()) {
      if (action.status === "applied" && now - Date.parse(action.ts) > this.config.commitWindowMs) {
        this.ledger.transition(action.id, "final", "recoil window elapsed");
      }
    }
  }

  /** Apply human commands written by the CLI (file-based, NanoClaw-style IPC). */
  async pollCommands(): Promise<void> {
    const file = join(this.config.dataDir, "commands.jsonl");
    if (!existsSync(file)) return;
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    while (this.commandCursor < lines.length) {
      const command = JSON.parse(lines[this.commandCursor++]) as { op: "commit" | "undo"; id: string };
      const result =
        command.op === "commit" ? await this.commitHeld(command.id) : await this.handleUndo(command.id);
      this.log(`${command.op} ${command.id}: ${result.content[0].text.slice(0, 120)}`);
    }
  }

  private async forward(routed: Routed, args: Record<string, unknown>, id: string): Promise<ToolResult> {
    const client = this.clients.get(routed.server)!;
    try {
      const result = (await client.callTool({ name: routed.tool, arguments: args })) as ToolResult;
      if (result.isError) this.ledger.transition(id, "failed", "downstream returned error");
      return result;
    } catch (error) {
      this.ledger.transition(id, "failed", String(error));
      return errorText(`Downstream ${routed.server}/${routed.tool} failed: ${String(error)}`);
    }
  }

  private hold(action: ActionRecord): ToolResult {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([action.server, action.tool, action.args]))
      .digest("hex");
    const existing = this.heldByFingerprint.get(fingerprint);
    if (existing && this.ledger.get(existing)?.status === "held") {
      return text({
        recoil: "held",
        id: existing,
        message: `Identical action is already held as ${existing}. Do not retry; a human must approve it.`,
      });
    }
    this.ledger.record({ ...action, status: "held" });
    this.heldByFingerprint.set(fingerprint, action.id);
    return text({
      recoil: "held",
      id: action.id,
      tool: `${action.server}/${action.tool}`,
      message:
        `This action is consequential and was NOT executed. It is staged as ${action.id}. ` +
        `Ask the user to approve it by running: recoil commit ${action.id} (or discard with: recoil undo ${action.id}). ` +
        `Continue with the rest of the task; do not retry this call.`,
    });
  }

  private async commitHeld(id: string): Promise<ToolResult> {
    const action = this.ledger.get(id);
    if (!action) return errorText(`No action ${id}`);
    if (action.status !== "held") return errorText(`Action ${id} is ${action.status}, not held`);
    const routed = [...this.tools.values()].find((r) => r.server === action.server && r.tool === action.tool);
    if (!routed) return errorText(`Tool ${action.server}/${action.tool} no longer available`);
    this.ledger.transition(id, "committed");
    return this.forward(routed, action.args as Record<string, unknown>, id);
  }

  private handleLedger(args: Record<string, unknown>): ToolResult {
    const limit = Number(args.limit ?? 20);
    const entries = this.ledger
      .all()
      .reverse()
      .slice(0, limit)
      .map(({ id, ts, server, tool, tier, status, note }) => ({ id, ts, server, tool, tier, status, note }));
    return text(entries);
  }

  private async handleUndo(id: string): Promise<ToolResult> {
    const action = this.ledger.get(id);
    if (!action) return errorText(`No action ${id}`);
    if (action.status === "held") {
      this.ledger.transition(id, "discarded");
      return text(`Held action ${id} discarded — it never ran.`);
    }
    if (action.status !== "applied" && action.status !== "committed") {
      return errorText(`Action ${id} is ${action.status} and cannot be recoiled.`);
    }
    if (!action.undo) {
      return errorText(`Action ${id} has no snapshot to restore (nothing recoverable was captured).`);
    }
    restoreSnapshot(action.undo);
    this.ledger.transition(id, "recoiled");
    return text(`Action ${id} recoiled: ${action.undo.entries.length} path(s) restored to their pre-action state.`);
  }

  private handleCommit(id: string): ToolResult | Promise<ToolResult> {
    if (!this.config.allowAgentCommit) {
      return errorText(
        `Agents may not commit held actions (allowAgentCommit=false). A human must run: recoil commit ${id}`,
      );
    }
    return this.commitHeld(id);
  }
}
