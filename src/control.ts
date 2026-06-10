import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { RecoilCore } from "./core.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Optional HTTP control surface for the web console. It exposes the ledger and
 * the same commit/undo operations the CLI uses — bound to loopback by default,
 * because approving an agent's destructive action is a privileged operation.
 */
export function startControlServer(core: RecoilCore, port: number, host = "127.0.0.1"): void {
  const ui = readFileSync(join(HERE, "ui.html"), "utf8");

  const send = (res: ServerResponse, code: number, body: string, type = "application/json") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    try {
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, ui, "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/api/ledger") {
        const limit = Number(url.searchParams.get("limit") ?? 200);
        return send(res, 200, JSON.stringify(core.snapshotLedger(limit)));
      }
      if (req.method === "POST" && (url.pathname === "/api/commit" || url.pathname === "/api/undo")) {
        const { id } = JSON.parse((await readBody(req)) || "{}");
        if (!id) return send(res, 400, JSON.stringify({ error: "id required" }));
        const op = url.pathname === "/api/commit" ? "commit" : "undo";
        const result = await core.applyCommand(op, String(id));
        return send(res, 200, JSON.stringify({ ok: !result.isError, message: result.content[0]?.text ?? "" }));
      }
      send(res, 404, JSON.stringify({ error: "not found" }));
    } catch (error) {
      send(res, 500, JSON.stringify({ error: String(error) }));
    }
  });

  server.listen(port, host, () => core.note(`control UI on http://${host}:${port}`));
  server.unref();
}
