// app.js
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");

const { auth } = require("./middleware/auth");
const tradesRouter = require("./routes/trades");
const martingaleRouter = require("./metaapi/martingale");
const strategyRouter = require("./metaapi/strategy");
const accountsRouter = require("./routes/accounts");
const subscriberRouter = require("./metaapi/subscriber");
const positionsRouter = require("./routes/positions");

/**
 * Build the app with injected dependencies (so tests can stub them).
 * @param {object} opts
 * @param {Set<string>} opts.allowIps
 * @param {Set<string>} opts.allowHosts
 * @param {object} opts.deps - optional shared deps (e.g., symbolCatalog)
 */
function createApp({ allowIps = new Set(), allowHosts = new Set(), deps = {} } = {}) {
  const app = express();

  // Trust proxy must be set before using req.ip/req.hostname
  app.set("trust proxy", parseInt(process.env.TRUST_PROXY_HOPS || "0", 10));

  // Basic hardening
  app.use(helmet());
  app.use(express.json({ limit: "100kb" }));

  // Rate limit (declare allow lists BEFORE this middleware)
  
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: 60,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: ipKeyGenerator,
      skip: (req) =>
        allowIps.has(req.ip) ||
        allowHosts.has((req.hostname || "").toLowerCase()),
    })
  );
  

  // Block everyone else early
  app.use((req, res, next) => {
    const ipAllowed = allowIps.has(req.ip);
    const hostAllowed = allowHosts.has((req.hostname || "").toLowerCase());
    if (ipAllowed || hostAllowed) return next();
    
    return res.status(403).send("Forbidden");
  });

  // Routes (inject auth + deps if needed)
  app.use("/api/trades", tradesRouter(auth, deps));
  app.use("/api/trades", martingaleRouter(auth, deps));
  app.use("/api/accounts", accountsRouter(auth, deps));
  app.use("/api/strategy", strategyRouter(auth, deps));
  app.use("/api/subscriber", subscriberRouter (auth, deps));
  app.use("/api/position", positionsRouter (auth, deps));

  // Healthcheck
  app.get("/healthz", (_req, res) => res.send("ok"));

  return app;
}

module.exports = { createApp };
