
// server.js
require("dotenv").config();
const http = require("http");
const { createApp } = require("./app");
const { SymbolCatalog } = require("./salesforce/symbolCatalog"); // your Pi-side cache
const { auth, authState, sfLogin } = require("./middleware/auth");

(async () => {
  // Build allow lists from env (null-safe)
  const allowIps = new Set(
    (process.env.ALLOW_IPS || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
  );
   allowHosts = new Set(
    (process.env.ALLOW_HOSTS || "")
      .split(",")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  );
  
  await sfLogin();

  // Init dependencies (e.g., Salesforce symbol cache)
  let symbolCatalog = null;
  try {
    if (authState.instanceUrl && authState.accessToken) {
      symbolCatalog = new SymbolCatalog({
        instanceUrl: authState.instanceUrl,
        accessToken: authState.accessToken,
        ttlSeconds: 300,
      });
      await symbolCatalog.init(); // warm the cache BEFORE serving traffic
      console.log(`[DATA] SymbolCatalog ready with ~${symbolCatalog.cache?.size || 0} symbols`);
    } else {
      console.warn("SymbolCatalog skipped: missing SF_INSTANCE_URL or SF_ACCESS_TOKEN");
    }
  } catch (e) {
    console.error(`Failed to init SymbolCatalog: ${e?.message || e}`);
    // Decide your policy: exit hard or continue degraded.
    // process.exit(1);
  }

  const app = createApp({
    allowIps,
    allowHosts,
    deps: { symbolCatalog },
  });

  const PORT = parseInt(process.env.PORT || "4999", 10);
  const HOST = "0.0.0.0";
  const server = http.createServer(app);

  server.listen(PORT, HOST, () => {
    console.log(`[SERVER] Server running at http://${HOST}:${PORT}`);
  });

  // Graceful shutdown
  const shutdown = (signal) => {
    console.log(`\n${signal} received. Shutting down...`);
    server.close(err => {
      if (symbolCatalog && typeof symbolCatalog.dispose === "function") {
        try { symbolCatalog.dispose(); } catch (_) {}
      }
      if (err) {
        console.error("HTTP server close error:", err);
        process.exit(1);
      }
      process.exit(0);
    });
    // Force-exit after 10s
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
})();
