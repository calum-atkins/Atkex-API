// utils/mt5.js
const axios = require("axios");

// Small concurrency limiter (no external deps)
async function limitedMap(items, limit, task) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await task(items[idx], idx);
      } catch (e) {
        results[idx] = e;
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Perform single POSITION_MODIFY
 */
async function modifyPosition({ accountId, positionId, stopLoss, takeProfit, agBaseUrl, agToken }) {
  const url = `${agBaseUrl}/users/current/accounts/${encodeURIComponent(accountId)}/trade`;
  
  const payload = {
    actionType: "POSITION_MODIFY",
    positionId: String(positionId)
  };
  if (stopLoss !== undefined && stopLoss !== 0) {
	  payload.stopLoss = stopLoss;
  }
  if (takeProfit !== undefined && takeProfit !== 0) {
	  payload.takeProfit = takeProfit;
  }
  console.log('modify');

  const resp = await axios.post(url, payload, {
    headers: {
      "auth-token": agToken,                 // using same header you used for GET
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    timeout: 15000,
    validateStatus: () => true,
  });

  const success = resp && resp.status >= 200 && resp.status < 300;
  const message = success ? "OK" : (resp?.statusText || "Non-2xx from MT client API");
  return {
    positionId: String(positionId),
    status: resp?.status ?? null,
    success,
    message,
    body: resp?.data ?? null,
  };
}

/**
 * Bulk POSITION_MODIFY with small concurrency
 */
async function bulkModifyPositions({ accountId, ids, stopLoss, takeProfit, agBaseUrl, agToken }) {
  const CONCURRENCY = Number(process.env.MT_BULK_CONCURRENCY || 5);

  const results = await limitedMap(ids, CONCURRENCY, (id) =>
    modifyPosition({ accountId, positionId: id, stopLoss, takeProfit, agBaseUrl, agToken })
  );

  const okCount = results.filter((r) => r?.success).length;
  const failCount = results.length - okCount;
  return { results, okCount, failCount };
}

module.exports = {
  bulkModifyPositions, modifyPosition
};
