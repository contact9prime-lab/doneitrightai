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
  {
    name: "recoil_status",
    description:
      "Check a held action and, once a human has approved it, retrieve the real result of running it. Call this after asking the user to approve a held action so you can continue the task with the outcome.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Action id from recoil_ledger" } },
      required: ["id"],
    },
  },
];

/** Resolves a blocked tool call once its held action is committed or discarded. */
type Waiter = (result: ToolResult) => void;

export interface CallOptions {
  /** Emit a progress keepalive while a blocked call waits for approval. */
  sendProgress?: () => void;
}

export class RecoilCore {
  private clients = new Map<string, Client>();
  private tools = new Map<string, Routed>();
  private heldByFingerprint = new Map<string, string>();
  private pending = new Map<string, Waiter[]>();
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

  async callTool(name: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<ToolResult> {
    if (name === "recoil_ledger") return this.handleLedger(args);
    if (name === "recoil_undo") return this.handleUndo(String(args.id ?? ""));
    if (name === "recoil_commit") return this.handleCommit(String(args.id ?? ""));
    if (name === "recoil_status") return this.handleStatus(String(args.id ?? ""));

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

    if (tier === "hold") return this.hold(base, opts);
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
        return this.hold({ ...base, note: "escalated: snapshot exceeds maxSnapshotBytes" }, opts);
      }
      base.undo = manifest;
    }
    base.status = "applied";
    this.ledger.record(base);
    return this.forward(routed, args, id);
  }

  /** Surface a log line (used by the control server). */
  note(message: string): void {
    this.log(message);
  }

  /** Read model for the web console: recent actions, richest fields included. */
  snapshotLedger(limit = 200): Array<Record<string, unknown>> {
    return this.ledger
      .all()
      .reverse()
      .slice(0, limit)
      .map(({ id, ts, server, tool, args, tier, status, note, delivered }) => {
        const result = this.ledger.get(id)?.result as ToolResult | undefined;
        return {
          id,
          ts,
          server,
          tool,
          tier,
          status,
          note,
          delivered,
          args,
          result: result?.content?.map((part) => part.text).join("\n"),
          recoilable: status === "applied" || status === "committed",
          actionable: status === "held",
        };
      });
  }

  /** Human commit/undo from the control UI — same path as the CLI command file. */
  async applyCommand(op: "commit" | "undo", id: string): Promise<ToolResult> {
    return op === "commit" ? this.commitHeld(id) : this.handleUndo(id);
  }

  /** Finalize applied actions whose recoil window has elapsed. */
  sweep(now = Date.now()): void {
    for (const action of this.ledger.all()) {
      if (action.status === "applied" && now - Date.parse(action.ts) > this.config.commitWindowMs) {
        this.ledger.transition(action.id, "final", { note: "recoil window elapsed" });
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
      if (result.isError) this.ledger.transition(id, "failed", { note: "downstream returned error" });
      return result;
    } catch (error) {
      this.ledger.transition(id, "failed", { note: String(error) });
      return errorText(`Downstream ${routed.server}/${routed.tool} failed: ${String(error)}`);
    }
  }

  private hold(action: ActionRecord, opts: CallOptions): Promise<ToolResult> | ToolResult {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([action.server, action.tool, action.args]))
      .digest("hex");
    const existing = this.heldByFingerprint.get(fingerprint);
    if (existing && this.ledger.get(existing)?.status === "held") {
      // Identical retry: attach to the already-staged action rather than stack.
      if (this.config.holdMode === "block") return this.waitForResolution(existing, action, opts);
      return this.heldNotice(existing, action, "duplicate");
    }
    this.ledger.record({ ...action, status: "held" });
    this.heldByFingerprint.set(fingerprint, action.id);
    if (this.config.holdMode === "block") return this.waitForResolution(action.id, action, opts);
    return this.heldNotice(action.id, action);
  }

  /**
   * Block the tool call until the held action is committed (resolving to the
   * real downstream result) or discarded (resolving to a decline notice), so
   * the outcome flows back into the LLM call. Falls back to an async notice if
   * the optional hold timeout elapses first.
   */
  private waitForResolution(id: string, action: ActionRecord, opts: CallOptions): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve) => {
      const ping = opts.sendProgress ? setInterval(opts.sendProgress, this.config.holdProgressMs) : undefined;
      ping?.unref?.();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle: Waiter = (result) => {
        if (ping) clearInterval(ping);
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      const waiters = this.pending.get(id) ?? [];
      waiters.push(settle);
      this.pending.set(id, waiters);
      if (this.config.holdTimeoutMs > 0) {
        timer = setTimeout(() => {
          const remaining = (this.pending.get(id) ?? []).filter((w) => w !== settle);
          if (remaining.length) this.pending.set(id, remaining);
          else this.pending.delete(id);
          if (ping) clearInterval(ping);
          resolve(this.heldNotice(id, action, "timeout"));
        }, this.config.holdTimeoutMs);
        timer.unref?.();
      }
    });
  }

  /** Deliver a result to any tool calls blocked on this action. */
  private resolvePending(id: string, result: ToolResult): boolean {
    const waiters = this.pending.get(id);
    if (!waiters?.length) return false;
    this.pending.delete(id);
    for (const settle of waiters) settle(result);
    return true;
  }

  private heldNotice(id: string, action: ActionRecord, reason?: "duplicate" | "timeout"): ToolResult {
    const lead =
      reason === "duplicate"
        ? `Identical action is already staged as ${id}.`
        : reason === "timeout"
          ? `Action ${id} is still awaiting human approval.`
          : `This action is consequential and was NOT executed. It is staged as ${id}.`;
    return text({
      recoil: "held",
      id,
      tool: `${action.server}/${action.tool}`,
      message:
        `${lead} Ask the user to approve it by running: recoil commit ${id} ` +
        `(or discard with: recoil undo ${id}). Do NOT retry this call. ` +
        `After the user approves, call recoil_status with id "${id}" to get the result and continue.`,
    });
  }

  private async commitHeld(id: string): Promise<ToolResult> {
    const action = this.ledger.get(id);
    if (!action) return errorText(`No action ${id}`);
    if (action.status !== "held") return errorText(`Action ${id} is ${action.status}, not held`);
    const routed = [...this.tools.values()].find((r) => r.server === action.server && r.tool === action.tool);
    if (!routed) return errorText(`Tool ${action.server}/${action.tool} no longer available`);
    this.ledger.transition(id, "committed");
    const result = await this.forward(routed, action.args as Record<string, unknown>, id);
    // Capture the real result and hand it to any blocked call; status records
    // it for async retrieval too. delivered=true means it already went inline.
    const status = this.ledger.get(id)?.status === "failed" ? "failed" : "committed";
    const delivered = this.resolvePending(id, result);
    this.ledger.transition(id, status, { result, delivered });
    return result;
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
      const declined = text(
        `The user declined action ${id} (${action.server}/${action.tool}); it was not executed. ` +
          `Do not retry; continue the task without it.`,
      );
      const delivered = this.resolvePending(id, declined);
      this.ledger.transition(id, "discarded", { delivered });
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

  /** Async feedback path: hand the committed action's real result to the agent. */
  private handleStatus(id: string): ToolResult {
    const action = this.ledger.get(id);
    if (!action) return errorText(`No action ${id}`);
    if (action.status === "held") {
      return text({ recoil: "pending", id, message: `Action ${id} is still awaiting human approval. Check again shortly.` });
    }
    if (action.status === "discarded") {
      return text({ recoil: "discarded", id, message: `The user declined action ${id}; it was not executed. Do not retry.` });
    }
    if ((action.status === "committed" || action.status === "failed") && action.result !== undefined) {
      return action.result as ToolResult; // the real downstream outcome, fed back to the LLM
    }
    return text({ recoil: action.status, id, message: `Action ${id} is ${action.status}.` });
  }
}
