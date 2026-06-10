#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { RecoilCore } from "./core.js";
import { startControlServer } from "./control.js";

const configPath = process.argv[2] ?? "recoil.config.json";
const config = loadConfig(configPath);
const core = new RecoilCore(config);
await core.start();

if (config.controlPort > 0) startControlServer(core, config.controlPort, config.controlHost);

const server = new Server({ name: "recoil", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: core.listTools() }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  // If the client supplied a progress token, keep the call alive while a held
  // action waits for approval (block mode) by emitting progress notifications.
  const progressToken = request.params._meta?.progressToken;
  let progress = 0;
  const sendProgress =
    progressToken === undefined
      ? undefined
      : () => {
          void extra
            .sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress: ++progress, message: "awaiting human approval" },
            })
            .catch(() => {});
        };
  return core.callTool(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>, { sendProgress });
});

setInterval(() => {
  core.sweep();
  void core.pollCommands();
}, 1000).unref();

await server.connect(new StdioServerTransport());
console.error(`[recoil] proxying ${Object.keys(config.servers).join(", ")} — ledger at ${config.dataDir}`);
