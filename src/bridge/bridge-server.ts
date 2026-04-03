/**
 * Bridge Server — HTTP API for IDE and remote client integration.
 * Runs alongside the REPL on a configurable port.
 */

export interface BridgeConfig {
  port: number;
  authToken: string;
  onSubmit: (prompt: string) => Promise<string>;
  getStatus: () => { mode: string; contextPercent: number; isProcessing: boolean; sessionId: string };
  getHistory: () => Array<{ role: string; content: string }>;
}

let _server: ReturnType<typeof Bun.serve> | null = null;
let _config: BridgeConfig | null = null;

export function startBridgeServer(config: BridgeConfig): void {
  _config = config;

  _server = Bun.serve({
    port: config.port,
    fetch: async (req) => {
      // Auth check
      const auth = req.headers.get("Authorization");
      if (auth !== `Bearer ${config.authToken}`) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      const url = new URL(req.url);

      // Routes
      switch (url.pathname) {
        case "/api/status": {
          const status = config.getStatus();
          return Response.json(status);
        }

        case "/api/submit": {
          if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
          const body = (await req.json()) as { prompt: string };
          if (!body.prompt) return Response.json({ error: "prompt required" }, { status: 400 });

          try {
            const result = await config.onSubmit(body.prompt);
            return Response.json({ result });
          } catch (err) {
            return Response.json({ error: String(err) }, { status: 500 });
          }
        }

        case "/api/history": {
          const history = config.getHistory();
          return Response.json({ messages: history.slice(-50) });
        }

        case "/api/health": {
          return Response.json({ status: "ok", uptime: process.uptime() });
        }

        default:
          return new Response("Not found", { status: 404 });
      }
    },
  });

  console.log(`  Bridge server listening on http://localhost:${config.port}`);
}

export function stopBridgeServer(): void {
  if (_server) {
    _server.stop();
    _server = null;
  }
}

export function getBridgePort(): number | null {
  return _config?.port ?? null;
}
