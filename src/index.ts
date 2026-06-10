#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { RecoilCore } from "./core.js";

const configPath = process.argv[2] ?? "recoil.config.json";
const config = loadConfig(configPath);
const core = new RecoilCore(config);
await core.start();

const server = new Server({ name: "recoil", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: core.listTools() }));
server.setRequestHandler(CallToolRequestSchema, async (request) =>
  core.callTool(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>),
);

setInterval(() => {
  core.sweep();
  void core.pollCommands();
}, 1000).unref();

await server.connect(new StdioServerTransport());
console.error(`[recoil] proxying ${Object.keys(config.servers).join(", ")} — ledger at ${config.dataDir}`);
