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

/** -------- Price ladder helpers -------- */

// 5 levels excluding 2 closest to target (SL or TP)
function computeFiveLevelsTowardTarget(entry, target) {
  if (
    entry == null || target == null ||
    Number.isNaN(entry) || Number.isNaN(target) ||
    !Number.isFinite(entry) || !Number.isFinite(target) ||
    entry === target
  ) return [];

  // N=5 desired, exclude E=2 near target → split into 7 equal segments
  const step = (target - entry) / 8;
  const levels = [];
  for (let i = 1; i <= 5; i++) {
    levels.push(entry + i * step);
  }
  return levels;
}

// Decide LIMIT vs STOP from side and level relative to entry
function actionTypeForPending(side, levelPrice, entry) {
  if (side === "BUY") {
    // BUY below entry = BUY_LIMIT; above entry = BUY_STOP
    return levelPrice < entry ? "ORDER_TYPE_BUY_LIMIT" : "ORDER_TYPE_BUY_STOP";
  } else {
    // SELL above entry = SELL_LIMIT; below entry = SELL_STOP
    return levelPrice > entry ? "ORDER_TYPE_SELL_LIMIT" : "ORDER_TYPE_SELL_STOP";
  }
}

async function placePending({ baseUrl, token, accountId, symbol, lotSize, actionType, openPrice, stopLoss, takeProfit }) {
  const url = `${baseUrl}/users/current/accounts/${accountId}/trade`;
  const headers = { "auth-token": token, "Content-Type": "application/json" };
  const payload = { symbol, volume: lotSize, actionType, openPrice, stopLoss, takeProfit };
  const resp = await axios.post(url, payload, { headers });
  return resp.data;
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
      const {
        symbol, lotSize, stopLoss, entry, side, accountId, takeProfit,
        ladderTowards = "SL" // "SL" (default) or "TP"
      } = req.body || {};

      const normSide = normalizeSide(side);
      if (!symbol || !normSide || !isNumber(lotSize) || !isNumber(stopLoss) || !isNumber(entry) || !isNumber(takeProfit)) {
        return res.status(400).json({ error: "Required fields: symbol, lotSize, stopLoss, takeProfit, entry, side" });
      }

      const { baseUrl, token } = await metaLogin();

      // 1) market order
      const marketResp = await placeMarketOrder({
        baseUrl, token, accountId, symbol, lotSize, side: normSide, stopLoss, takeProfit
      });

      // 2) pick the target we ladder toward
      const target = ladderTowards === "TP" ? takeProfit : stopLoss;

      // 3) compute 5 levels toward the chosen target, excluding 2 closest to it
      let levels = computeFiveLevelsTowardTarget(entry, target);

      // Optional: tick normalization + dedupe
      const TICK = Number(process.env.DEFAULT_TICK || "0.01");
      const toTick = p => Math.round(p / TICK) * TICK;
      levels = Array.from(new Set(levels.map(toTick))).filter(p => p !== entry);

      // 4) place pending orders; choose LIMIT vs STOP correctly
      const limitResults = [];
      for (const openPrice of levels) {
        const actionType = actionTypeForPending(normSide, openPrice, entry);
        const r = await placePending({
          baseUrl, token, accountId, symbol, lotSize, actionType, openPrice, stopLoss, takeProfit
        });
        limitResults.push({ openPrice, actionType, response: r });
      }

      return res.json({
        ok: true,
        requested: { symbol, lotSize, stopLoss, takeProfit, entry, side: normSide, ladderTowards },
        marketOrder: marketResp,
        pendingOrders: limitResults
      });
    } catch (err) {
      console.error("[MARTINGALE ERROR]", err.response?.data || err.message);
      return res.status(500).json({ error: "Failed to place martingale orders" });
    }
  });


  return router;
};
