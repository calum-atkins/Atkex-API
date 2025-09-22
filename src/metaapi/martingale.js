const express = require("express");
const axios = require("axios");

/**
 * POST /api/trades/place/martingale
 * Body: { symbol, lotSize, stopLoss, entry, side }
 * side: "BUY" | "SELL"
 *
 * NOTE: This file includes placeholder Meta API calls.
 * Replace META_API_URL, login payload/headers, and order payloads
 * to match your actual Meta Cloud provider.
 */

function isNumber(n) {
  return typeof n === "number" && !Number.isNaN(n) && Number.isFinite(n);
}

function normalizeSide(side) {
  if (!side) return null;
  const s = String(side).trim().toUpperCase();
  if (s === "BUY" || s === "SELL") return s;
  return null;
}

/** -------- Meta API integration (placeholders to replace) -------- */

async function metaLogin(accountId) {
  // Replace this with your real login flow for Meta Cloud
  // e.g. exchange api key/secret for a bearer token, or simply reuse an existing token
  const META_API_URL = process.env.META_API_URL; // e.g. https://mt-client-api-v1.london.agiliumtrade.ai or your provider base
  const META_API_TOKEN = process.env.METATRADER_TOKEN; // if your provider uses 'auth-token' header

  if (!META_API_URL || !META_API_TOKEN) {
    throw new Error("META_API_URL or METATRADER_TOKEN not configured in .env");
  }

  // If your provider doesn’t require a separate login call, just return what you need:
  return {
    baseUrl: META_API_URL,
    token: META_API_TOKEN
  };
}

async function placeMarketOrder({ baseUrl, token, accountId, symbol, lotSize, side, stopLoss, takeProfit }) {
  // Replace endpoint + payload with your Meta provider spec
  const url = `${baseUrl}/users/current/accounts/${accountId}/trade`;
  const headers = {
    // Example: Agilium uses 'auth-token' header
    "auth-token": token,
    "Content-Type": "application/json"
  };
  
  const actionType = side == 'SELL' ? 'ORDER_TYPE_SELL' : 'ORDER_TYPE_BUY';

  // Example payload — adapt to your provider:
  const payload = {
    //accountId,           // optional if provider infers from token
    symbol,
    volume: lotSize,
    actionType,                // "BUY" | "SELL"
    stopLoss,             // numeric SL price
    takeProfit
  };
  const resp = await axios.post(url, payload, { headers });
  return resp.data;
}

async function placeLimitOrder({ baseUrl, token, accountId, symbol, lotSize, side, openPrice, stopLoss, takeProfit }) {
  // Replace endpoint + payload with your Meta provider spec
  const url = `${baseUrl}/users/current/accounts/${accountId}/trade`;
  const headers = {
    "auth-token": token,
    "Content-Type": "application/json"
  };

  // Convert side -> order type for limit:
  // BUY -> BUY_LIMIT, SELL -> SELL_LIMIT (provider-specific strings)
  const actionType = side === "BUY" ? "ORDER_TYPE_BUY_LIMIT" : "ORDER_TYPE_SELL_LIMIT";

  const payload = {
    //accountId,           // optional if provider infers from token
    symbol,
    volume: lotSize,
    actionType,                // keep side for clarity
    openPrice,
    stopLoss,
    takeProfit
  };
  console.log(payload);

  const resp = await axios.post(url, payload, { headers });
  return resp.data;
}

/** -------- Price ladder helper --------
 * Evenly space 3 prices between entry and stopLoss (exclusive of entry, inclusive of SL?).
 * We'll create 3 internal levels strictly between entry and stopLoss:
 *   L1 = entry + 1/4*(SL-entry)
 *   L2 = entry + 2/4*(SL-entry)
 *   L3 = entry + 3/4*(SL-entry)
 * This ensures 3 equal gaps from entry towards SL.
 */
function computeThreeLevels(entry, stopLoss) {
  const delta = stopLoss - entry;                // could be negative or positive
  const step = delta / 8;
  const l1 = entry + step;                       // 25% toward SL
  const l2 = entry + 2 * step;                   // 50% toward SL
  const l3 = entry + 3 * step;                   // 75% toward SL
  const l4 = entry + 4 * step;                   // 75% toward SL
  const l5 = entry + 5 * step;                   // 75% toward SL
  const l6 = entry + 6 * step;                   // 75% toward SL
  const l7 = entry + 7 * step;                   // 75% toward SL
  return [l1, l2, l3, l4, l5, l6, l7];
}

/** -------- Router factory (so you can inject your auth middleware) -------- */
module.exports = (auth) => {
  const router = express.Router();

  /**
   * POST /api/trades/place/martingale
   * Body: { symbol, lotSize, stopLoss, entry, side }
   */
  router.post("/place/martingale", auth, async (req, res) => {
    try {
      const { symbol, lotSize, stopLoss, entry, side, accountId, takeProfit } = req.body || {};

      // Basic validation
      const normSide = normalizeSide(side);
      if (!symbol || !normSide || !isNumber(lotSize) || !isNumber(stopLoss) || !isNumber(entry) || !isNumber(takeProfit)) {
        return res.status(400).json({
          error: "Required fields: symbol (string), lotSize (number), stopLoss (number), takeProfit (number), entry (number), side ('BUY'|'SELL')"
        });
      }

      // Login / prepare Meta API
      const { baseUrl, token } = await metaLogin();

      // 1) Place the market order now (execution at current price) with SL
      const marketResp = await placeMarketOrder({
        baseUrl,
        token,
        accountId,
        symbol,
        lotSize,
        side: normSide,
        stopLoss,
        takeProfit
      });

      // 2) Compute the three equal levels between entry and SL
      const levels = computeThreeLevels(entry, stopLoss);

      // 3) Place 3 limit orders at those levels (all with same SL)
      const limitResults = [];
      for (const openPrice of levels) {
        // For true “martingale”, you might want to multiply lot size on each step.
        // You asked to keep lot size as given, so we use the same lotSize for all.
        // If you want x2, x3 scaling later, we can adjust here.
        // BUY => BUY_LIMIT below current ask; SELL => SELL_LIMIT above current bid.
        // We assume the provider enforces correct price/side semantics.
        // If needed, add guards to ensure the limit is properly placed wrt current market.
        const r = await placeLimitOrder({
          baseUrl,
          token,
          accountId,
          symbol,
          lotSize,
          side: normSide,
          openPrice,
          stopLoss,
          takeProfit
        });
        limitResults.push({ openPrice, response: r });
      }

      return res.json({
        ok: true,
        requested: { symbol, lotSize, stopLoss, entry, side: normSide },
        marketOrder: marketResp,
        limitOrders: limitResults
      });
    } catch (err) {
      console.error("[MARTINGALE ERROR]", err.response?.data || err.message);
      return res.status(500).json({ error: "Failed to place martingale orders" });
    }
  });

  return router;
};
