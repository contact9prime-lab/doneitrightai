// One Recoil instance protecting two unrelated domains at once: a filesystem
// and a knowledge-graph memory server. Run from the repo root after build:
//
//   node examples/demo-multi.mjs
//
// Shows the universal coverage model: reads pass everywhere, writes are
// audited (and snapshotted where an adapter exists), destructive calls are
// held everywhere — no per-domain code required for audit and hold.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const ROOT = "/tmp/recoil-multi";
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(`${ROOT}/ws`, { recursive: true });
writeFileSync(`${ROOT}/ws/notes.txt`, "precious data");
writeFileSync(
  `${ROOT}/config.json`,
  JSON.stringify({
    servers: {
      fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", `${ROOT}/ws`] },
      memory: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
        env: { MEMORY_FILE_PATH: `${ROOT}/memory.json` },
      },
    },
    dataDir: `${ROOT}/.recoil`,
  }),
);

const client = new Client({ name: "demo-multi", version: "0.0.1" });
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: ["dist/index.js", `${ROOT}/config.json`],
    stderr: "inherit",
    env: { ...process.env },
  }),
);

const { tools } = await client.listTools();
console.log(`\n${tools.length} tools from two servers behind one ledger\n`);

console.log("1. Agent stores a memory (undoable tier: runs, audited) ...");
await client.callTool({
  name: "create_entities",
  arguments: { entities: [{ name: "Piyush", entityType: "person", observations: ["building the delegation layer"] }] },
});

console.log("2. Agent reads the graph (pass tier) ...");
const graph = JSON.parse((await client.callTool({ name: "read_graph", arguments: {} })).content[0].text);
console.log("   entities in memory:", graph.entities.map((entity) => entity.name).join(", "));

console.log("3. Agent overwrites notes.txt, then we recoil it ...");
await client.callTool({ name: "write_file", arguments: { path: `${ROOT}/ws/notes.txt`, content: "clobbered" } });
const ledger1 = JSON.parse((await client.callTool({ name: "recoil_ledger", arguments: {} })).content[0].text);
await client.callTool({ name: "recoil_undo", arguments: { id: ledger1.find((entry) => entry.tool === "write_file").id } });
console.log("   notes.txt:", readFileSync(`${ROOT}/ws/notes.txt`, "utf8"));

console.log("4. Agent tries to erase its memory of Piyush (hold tier) ...");
const held = JSON.parse(
  (await client.callTool({ name: "delete_entities", arguments: { entityNames: ["Piyush"] } })).content[0].text,
);
const after = JSON.parse((await client.callTool({ name: "read_graph", arguments: {} })).content[0].text);
console.log(`   held as ${held.id} — entity still in graph: ${after.entities.length === 1}`);

console.log("5. One audit trail across both domains:");
const ledger2 = JSON.parse((await client.callTool({ name: "recoil_ledger", arguments: {} })).content[0].text);
for (const entry of ledger2.reverse()) {
  console.log(`   ${entry.id}  ${entry.status.padEnd(8)}  ${entry.server}/${entry.tool}`);
}
console.log();
await client.close();
