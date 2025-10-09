// routes/positions.js
const express = require("express");
const axios = require("axios");
const { modifyPosition } = require("../utils/mt5");
//const router = express.Router();

/**
 * Configuration
 * - AG_BASE_URL: the AgiliumTrade MT client API base
 * - AG_TOKEN:    your bearer token (or however you auth that API)
 *
 * You can set these in your .env, or substitute your own auth middleware.
 */
const AG_BASE_URL = process.env.META_API_URL || "https://mt-client-api-v1.london.agiliumtrade.ai";
const AG_TOKEN = process.env.METATRADER_TOKEN || ""; // <-- set me via env

// Minimal UUID v4-ish check; keeps early failures friendly.
const UUIDish = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * GET /api/mt/accounts/:accountId/positions
 * Returns: [{ id, type, symbol, time }]
 *
 * Notes:
 * - Defensive null handling throughout (if the remote shape changes).
 * - No retries by default; you can add axios-retry if you like.
 * - Timeouts protect the route from hanging.
 */
module.exports = (auth) => {
  const router = express.Router();
  router.get("/accounts/:accountId/positions", auth, async (req, res) => {
    const { accountId } = req.params || {};

    // Basic input validation
    if (!accountId || !UUIDish.test(accountId)) {
      return res.status(400).json({
        error: "Invalid accountId",
        details: "Provide a valid account UUID in the URL path.",
      });
    }

    if (!AG_TOKEN) {
      return res.status(500).json({
        error: "Server configuration error",
        details: "Missing AG_TOKEN environment variable.",
      });
    }

    const url = `${AG_BASE_URL}/users/current/accounts/${encodeURIComponent(accountId)}/positions`;

    try {
      const response = await axios.get(url, {
        headers: {
          "auth-token": `${AG_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 12_000,
        validateStatus: () => true, // we'll handle non-2xx below
      });

      if (response == null) {
        return res.status(502).json({
          error: "UpstreamNoResponse",
          details: "No response from MT client API.",
        });
      }

      const { status, data } = response;

      if (status < 200 || status >= 300) {
        // Bubble up upstream error details without leaking sensitive headers
        return res.status(status).json({
          error: "UpstreamError",
          status,
          details:
            data && typeof data === "object"
              ? data
              : { message: "Non-2xx response from MT client API." },
        });
      }

      // Expecting an array; handle null/other types gracefully
      const positions = Array.isArray(data) ? data : [];

      // Project only the requested fields with null-safety
      const minimal = positions.map((p) => ({
        id: p && p.id != null ? String(p.id) : null,
        type: p && p.type != null ? String(p.type) : null,
        symbol: p && p.symbol != null ? String(p.symbol) : null,
        timeString:
          p && (p.time != null || (p.openTime != null)) // some APIs use openTime
            ? String(p.time ?? p.openTime)
            : null,
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
        openPrice: p.openPrice
      }));

      return res.status(200).json(minimal);
    } catch (err) {
      // Defensive error detail extraction
      const msg =
        err && err.message ? err.message : "Unknown error during callout.";
      const code = err && err.code ? err.code : "UNKNOWN";

      // Only include stack in non-prod to avoid leaking internals
      //const isProd = process.env.NODE_ENV === "production";

      return res.status(500).json({
        error: "CalloutException",
        code,
        message: msg//,
        //...(isProd ? {} : { stack: err && err.stack ? err.stack : undefined }),
      });
    }
  });
  
  /**
   * POST /accounts/:accountId/positions/modify
   * Supported bodies:
   * 1) Legacy single:
   * {
   *   "actionType": "POSITION_MODIFY",
   *   "positionId": "434570146",
   *   "stopLoss": 0.93180,
   *   "takeProfit": 0.94200
   * }
   *
   * 2) Legacy bulk (same SL/TP for all):
   * {
   *   "actionType": "POSITION_MODIFY",
   *   "positionIds": ["434570146","434570145"],
   *   "stopLoss": 0.93180
   * }
   *
   * 3) NEW per-position:
   * {
   *   "actionType": "POSITION_MODIFY",
   *   "updates": [
   *     { "positionId": "434570146", "stopLoss": 0.93180, "takeProfit": 0.94200 },
   *     { "positionId": "434570145", "stopLoss": 0.93225 }
   *   ]
   * }
   */
  router.post("/accounts/:accountId/positions/modify", auth, async (req, res) => {
    const { accountId } = req.params || {};
    const body = req.body || {};
    console.log(body);

    if (!accountId || !UUIDish.test(accountId)) {
      return res.status(400).json({ error: "Invalid accountId", details: "Provide a valid account UUID." });
    }
    if (!AG_TOKEN) {
      return res.status(500).json({ error: "Server configuration error", details: "Missing AG_TOKEN env var." });
    }

    const actionType = String(body?.actionType || "").trim().toUpperCase();
    if (actionType !== "POSITION_MODIFY") {
      return res.status(400).json({ error: "Invalid actionType", details: "actionType must be POSITION_MODIFY." });
    }

    // --- Normalize into unit updates -----------------------------------------
    // New shape first
    let updates = Array.isArray(body?.updates) ? body.updates : null;
  console.log('here');
    // Fallback to legacy shapes if no updates[]
    if (!updates) {
      const singleId = body?.positionId ? String(body.positionId) : null;
      let ids = Array.isArray(body?.positionIds) ? body.positionIds.map(String) : [];
      if (singleId) ids.push(singleId);
      ids = Array.from(new Set(ids.filter(v => v && v.trim() !== "")));

      if (ids.length === 0) {
        return res.status(400).json({ error: "NoPositionIds", details: "Provide updates[], positionId or positionIds." });
      }

      // Legacy: one SL/TP for all ids
      const stopLoss = body?.stopLoss;
      const takeProfit = body?.takeProfit;

      // (Optional) type checks if you want to enforce:
      // if (stopLoss !== undefined && stopLoss !== null && (typeof stopLoss !== "number" || !Number.isFinite(stopLoss))) ...
      // if (takeProfit !== undefined && takeProfit !== null && (typeof takeProfit !== "number" || !Number.isFinite(takeProfit))) ...

      updates = ids.map(id => ({
        positionId: String(id),
        // Only include fields that are provided
        ...(stopLoss !== undefined ? { stopLoss } : {}),
        ...(takeProfit !== undefined ? { takeProfit } : {})
      }));
    } else {
      // New shape: sanitize updates[]
      updates = updates
        .map(u => ({
          positionId: String(u?.positionId || "").trim(),
          stopLoss:   u?.stopLoss,
          takeProfit: u?.takeProfit
        }))
        .filter(u => u.positionId); // require id

      // Deduplicate by positionId keeping last occurrence
      const m = new Map();
      for (const u of updates) m.set(u.positionId, u);
      updates = Array.from(m.values());

      if (updates.length === 0) {
        return res.status(400).json({ error: "NoValidUpdates", details: "updates[] contained no valid positionId entries." });
      }
    }

    try {
      // Execute each update individually so SL/TP can differ per trade.
      const results = [];
      let okCount = 0, failCount = 0;
console.log('here2');
      for (const u of updates) {
        try {
          console.log('here2' + u );
          const r = await modifyPosition({
            accountId,
            positionId: u.positionId,
            stopLoss:   u.hasOwnProperty("stopLoss")   ? u.stopLoss   : undefined,
            takeProfit: u.hasOwnProperty("takeProfit") ? u.takeProfit : undefined,
            agBaseUrl:  AG_BASE_URL,
            agToken:    AG_TOKEN,
          });
          results.push({
            positionId: u.positionId,
            status: r?.status || 200,
            success: true,
            message: 'OK',
            body: r?.body ?? null
          });
          okCount++;
        } catch (err) {
          results.push({
            positionId: u.positionId,
            status: err?.status || 500,
            success: false,
            message: err?.message || 'Modify failed',
            body: err?.body ?? null
          });
          failCount++;
        }
      }
      console.log('updates: ' + JSON.stringify(results, null, 2));

      return res.status(200).json({ results, okCount, failCount });
    } catch (err) {
      const msg = err?.message || "Unknown error during modify.";
      const code = err?.code || "UNKNOWN";
      console.log(msg);
      return res.status(500).json({ error: "ModifyException", code, message: msg });
    }
  });


  return router;
};


//module.exports = router;
