#!/usr/bin/env node
/**
 * Human-side CLI. The proxy process owns the downstream connections, so
 * commit/undo are delivered through the data dir (commands.jsonl), which the
 * proxy polls every second. `ledger` reads the audit trail directly.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Ledger } from "./ledger.js";

const [op, id] = process.argv.slice(2);
const dataDir = resolve(process.env.RECOIL_DATA_DIR ?? ".recoil");

function usage(): never {
  console.log(
    [
      "recoil — audit and recoil agent tool calls",
      "",
      "  recoil ledger          show the audit trail",
      "  recoil commit <id>     approve a held action so it executes",
      "  recoil undo <id>       recoil an applied action / discard a held one",
      "",
      `data dir: ${dataDir} (override with RECOIL_DATA_DIR)`,
    ].join("\n"),
  );
  process.exit(op ? 1 : 0);
}

if (op === "ledger") {
  const entries = new Ledger(join(dataDir, "ledger.jsonl")).all().reverse();
  if (entries.length === 0) {
    console.log("Ledger is empty.");
  }
  for (const entry of entries) {
    const flag = entry.status === "held" ? "  <-- awaiting `recoil commit " + entry.id + "`" : "";
    console.log(`${entry.id}  ${entry.ts}  ${entry.status.padEnd(9)}  ${entry.server}/${entry.tool}${flag}`);
  }
} else if ((op === "commit" || op === "undo") && id) {
  mkdirSync(dataDir, { recursive: true });
  appendFileSync(join(dataDir, "commands.jsonl"), JSON.stringify({ op, id }) + "\n");
  console.log(`${op} ${id} queued — the proxy applies it within a second. Check with: recoil ledger`);
} else {
  usage();
}
