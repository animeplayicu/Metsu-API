import "dotenv/config";
import http from "node:http";
import worker from "./index.js";
import { validateRequestOrigin } from "./core/auth-origins.js";
import { runAutoSync } from "./scripts/anikoto_auto_sync.js";

const PORT  = Number(process.env.PORT) || 4000;
const BASE  = process.env.BASE_PATH ?? "";

async function nodeToRequest(req) {
  const host     = req.headers["host"] ?? `localhost:${PORT}`;
  const proto    = req.headers["x-forwarded-proto"] || (req.socket?.encrypted ? "https" : "http");
  const stripped = BASE && req.url.startsWith(BASE) ? req.url.slice(BASE.length) || "/" : req.url;
  const url      = `${proto}://${host}${stripped}`;

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : null;

  return new Request(url, {
    method:  req.method,
    headers: req.headers,
    body:    body?.length ? body : undefined,
    duplex:  "half",
  });
}

const server = http.createServer(async (req, res) => {
  console.log(`→ ${req.method} ${req.url}`);

  const pathname = req.url.split("?")[0];
  if (pathname === "/sync/anikoto") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    try {
      const result = await runAutoSync(15);
      return res.end(JSON.stringify(result, null, 2));
    } catch (e) {
      return res.end(JSON.stringify({ status: "error", message: e.message }));
    }
  }

  if (pathname === "/" || pathname === "/docs" || pathname === "/index.html") {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Not found" }));
  }

  try {
    const request = await nodeToRequest(req);

    // Whitelist domain validation (Origin & Referer check)
    if (!validateRequestOrigin(request)) {
      res.writeHead(403, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "null",
      });
      return res.end(JSON.stringify({ error: "Forbidden: Unauthorized domain" }));
    }

    const response = await worker.fetch(request, {});

    res.statusCode = response.status;
    for (const [k, v] of response.headers) res.setHeader(k, v);

    if (response.body) {
      try {
        for await (const chunk of response.body) {
          res.write(chunk);
        }
        res.end();
      } catch (streamErr) {
        if (!res.destroyed) res.destroy(streamErr);
      }
    } else {
      res.end();
    }
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: err.message }));
    }
  }
});

process.on("uncaughtException", (err) => {
  if (err?.code === "ECONNRESET" || err?.code === "EPIPE") return;
  console.error("Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
setInterval(() => {
  console.log("[Scheduler] ⏰ Running 6-hour scheduled Anikoto Auto-Sync on VPS...");
  runAutoSync(25).catch((err) => console.error("[Scheduler] Sync error:", err.message));
}, SIX_HOURS_MS);

server.listen(PORT, () => {
  console.log(`Metsu dev server → http://localhost:${PORT}`);
  console.log(`[Scheduler] 6-hour Anikoto Auto-Sync is active.`);
});
