import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { Tier } from "./config.js";
import type { SnapshotManifest } from "./snapshot.js";

export type ActionStatus =
  | "passed" // forwarded immediately (read-tier), audit only
  | "applied" // forwarded with undo info captured; recoilable until window closes
  | "held" // NOT forwarded; awaiting commit or discard
  | "committed" // held action approved and forwarded
  | "recoiled" // undone (applied → restored, held → never ran)
  | "discarded" // held action dropped without running
  | "final" // recoil window elapsed; undo info no longer guaranteed
  | "failed"; // downstream call errored

export interface ActionRecord {
  id: string;
  ts: string;
  server: string;
  tool: string;
  args: unknown;
  tier: Tier;
  status: ActionStatus;
  undo?: SnapshotManifest;
  note?: string;
  /** Downstream result captured once the action runs (for status retrieval). */
  result?: unknown;
  /** Whether that result was already returned inline to a blocked tool call. */
  delivered?: boolean;
}

interface TransitionExtra {
  note?: string;
  result?: unknown;
  delivered?: boolean;
}

type Event =
  | ({ kind: "action" } & ActionRecord)
  | ({ kind: "transition"; id: string; ts: string; status: ActionStatus } & TransitionExtra);

/** Append-only JSONL ledger; state is reconstructed by replay. */
export class Ledger {
  constructor(private file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  newId(): string {
    return randomBytes(4).toString("hex");
  }

  record(action: ActionRecord): void {
    this.append({ kind: "action", ...action });
  }

  transition(id: string, status: ActionStatus, extra: TransitionExtra = {}): void {
    this.append({ kind: "transition", id, ts: new Date().toISOString(), status, ...extra });
  }

  all(): ActionRecord[] {
    if (!existsSync(this.file)) return [];
    const actions = new Map<string, ActionRecord>();
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as Event;
      if (event.kind === "action") {
        const { kind: _kind, ...action } = event;
        actions.set(action.id, action);
      } else {
        const action = actions.get(event.id);
        if (action) {
          action.status = event.status;
          if (event.note !== undefined) action.note = event.note;
          if (event.result !== undefined) action.result = event.result;
          if (event.delivered !== undefined) action.delivered = event.delivered;
        }
      }
    }
    return [...actions.values()];
  }

  get(id: string): ActionRecord | undefined {
    return this.all().find((a) => a.id === id);
  }

  private append(event: Event): void {
    appendFileSync(this.file, JSON.stringify(event) + "\n");
  }
}
