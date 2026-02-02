// routes/importMetatrader.js
const express = require("express");
const axios = require("axios");
const { sfLogin, authState } = require("../middleware/auth");
const { sfBatchUpsertHedgesByUUID } = require("../salesforce/upsert");
const { consolidateDealsToHedges } = require("../logic/consolidate");

/**
 * Helper: parse ISO date safely; returns null on bad input
 */
function parseIsoOrNull(s) {
  if (!s || typeof s !== "string") return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Null/empty guards
function isNonEmptyString(v){ return typeof v === "string" && v.trim().length>0; }
function isNum(n){ return typeof n === "number" && Number.isFinite(n); }

// Only overwrite if incoming has a value; otherwise keep existing
function mergePreservingOpen(existing = {}, incoming = {}) {
  const out = { ...existing, ...incoming };

  // Fields you said were being wiped:
  const preserveIfMissing = [ 
    "Side__c",                  // BUY/SELL
    "X1st_Trade_Open_Price__c",   // or whatever your API name is
    "X1st_Trade_Units__c",
    "Open_Date_Time__c",
    "Open_Comments__c",
    "Open_Screenshot__c",
    "Balance_On_Open__c",
    "Fees__c"
  ];// Side from your computed net; fixes the ternary that referenced entryType wrongly
  

  for (const f of preserveIfMissing) {
    const newHasValue =
      incoming.hasOwnProperty(f) &&
      incoming[f] !== null &&
      incoming[f] !== undefined &&
      !(typeof incoming[f] === "string" && incoming[f].trim() === "");

    if (!newHasValue && existing[f] != null) {
      out[f] = existing[f];
    }
  }

  // SL -> BE rule: only if we actually have a positive final profit
  // (adjust field API name if yours differs)
  if (out.Outcome__c === "SL" && isNum(out.Final_Profit__c) && out.Final_Profit__c > 0) {
    out.Outcome__c = "BE";
  }

  return out;
}

// Bulk fetch existing Hedge__c by UUID_Text__c for merge
async function fetchExistingHedgesByUUID({ instanceUrl, accessToken, uuids = [] }) {
  const map = new Map();
  if (!instanceUrl || !accessToken || !uuids || uuids.length === 0) return map;

  // SOQL IN clause chunking (<= 1000 items per chunk is safe)
  const chunks = [];
  for (let i = 0; i < uuids.length; i += 500) chunks.push(uuids.slice(i, i + 500));

  for (const ch of chunks) {
    const quoted = ch.map(u => `'${String(u).replace(/'/g, "\\'")}'`).join(",");
    const soql =
      `SELECT Id, UUID_Text__c, Side__c,X1st_Trade_Open_Price__c, X1st_Trade_Units__c,Open_Date_Time__c,Open_Comments__c,Open_Screenshot__c, Fees__c 
         FROM SR_Hedge__c
        WHERE UUID_Text__c IN (${quoted})`;

    const url = `${instanceUrl}/services/data/v59.0/query`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { q: soql },
      timeout: 15000
    });

    const recs = Array.isArray(resp?.data?.records) ? resp.data.records : [];
    for (const r of recs) {
      if (isNonEmptyString(r.UUID_Text__c)) map.set(r.UUID_Text__c, r);
    }
  }

  return map;
}

/**
 * Build the MetaTrader history URL for an account and time range.
 */
function buildMtDealsUrl({ mtAccountId, fromIso, toIso }) {
  const base = (process.env.METATRADER_BASE || "https://mt-client-api-v1.london.agiliumtrade.ai").replace(/\/+$/, "");
  return `${base}/users/current/accounts/${mtAccountId}/history-deals/time/${fromIso}/${toIso}`;
}

module.exports = (auth, deps = {}) => {
  const router = express.Router();
  const { symbolCatalog } = deps; 

  /**
   * GET /api/trades/import/metatrader
   * Required: sfAccountId, mtAccountId
   * Optional: from, to (ISO strings). Defaults: last 30 days to now (UTC).
   *
   * Example:
   * /api/trades/import/metatrader?sfAccountId=001XXXX...&mtAccountId=ddd6cbbc-...&from=2025-09-01T00:00:00Z&to=2025-09-30T23:59:59Z
   */
  router.get("/import/metatrader", auth, async (req, res) => {
    try {
      // --- 1) Validate inputs
      const sfAccountId = (req.query.sfAccountId || req.body?.sfAccountId || "").trim();
      const mtAccountId = (req.query.mtAccountId || req.body?.mtAccountId || "").trim();
      const accountCode = (req.query.accountCode || req.body?.accountCode || "").trim();
      const openBalance = (req.query.openBalance || req.body?.openBalance || "").trim();
      const parsedRValue = (req.query.rValue || req.body?.rValue || "").trim();

      if (!sfAccountId) {
        return res.status(400).json({ error: "Missing required parameter: sfAccountId" });
      }
      if (!mtAccountId) {
        return res.status(400).json({ error: "Missing required parameter: mtAccountId" });
      }

      // Dates (defaults: last 30 days to now, UTC)
      const now = new Date();
      const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const fromDate = parseIsoOrNull(req.query.from) || parseIsoOrNull(req.body?.from) || defaultFrom;
      const toDate = parseIsoOrNull(req.query.to) || parseIsoOrNull(req.body?.to) || now;

      // Guard: ensure from <= to
      if (fromDate.getTime() > toDate.getTime()) {
        return res.status(400).json({ error: "Invalid range: 'from' must be <= 'to'." });
      }

      const fromIso = fromDate.toISOString();
      const toIso = toDate.toISOString();

      // --- 2) Call MetaTrader API
      const url = buildMtDealsUrl({ mtAccountId, fromIso, toIso });
      const mtToken = process.env.METATRADER_TOKEN;
      if (!mtToken) {
        return res.status(500).json({ error: "Server misconfigured: METATRADER_TOKEN is not set." });
      }

      const response = await axios.get(url, {
        headers: { "auth-token": `${mtToken}` },
        timeout: 60_000,
      });

      const deals = Array.isArray(response?.data) ? response.data : [];
      if (!deals.length) {
        return res.json({
          message: "No deals returned from MetaTrader for the requested range.",
          mtAccountId,
          from: fromIso,
          to: toIso,
          count: 0,
        });
      }

      // --- 3) Consolidate -> Hedges (domain logic)
      const consolidated = consolidateDealsToHedges(deals, {deps: { symbolCatalog }} ) || [];
      // Attach the owning Account__c to each row prior to upsert
      // (null-safe map; do not mutate original if consolidate returns frozen objects)
      const hedgesForUpsert = consolidated.map(h => {
        const copy = { ...(h || {}) };
        // Ensure Account__c is always present for Salesforce side
        copy.Actual_Trading_Account__c = sfAccountId;
        copy.UUID_Text__c = accountCode + "-" + copy.UUID_Text__c;
        const parsedBalance = parseFloat(openBalance);
        copy.Balance_on_Open__c = isNaN(parsedBalance) ? 0 : parsedBalance;

        const grossProfit = Number(copy.X1st_Trade_Profit__c) || 0;
        const fees = Number(copy.Fees__c) || 0; // Fees__c will be negative typically
        const netProfit = grossProfit + fees;

        copy.Realised_RR__c = parsedRValue ? (netProfit / parsedRValue) : 0;

        return copy;
      });

      // --- 4) Login to Salesforce (if your helper needs it)
      // await sfLogin();

      // --- 4.5) Load existing hedges (to avoid wiping open data)
      //await sfLogin(); // ensure authState is set
      const uuids = hedgesForUpsert.map(h => h?.UUID_Text__c).filter(isNonEmptyString);

      // Pull once (mass retrieval before any loop)
      let existingByUUID = new Map();
      try {
        existingByUUID = await fetchExistingHedgesByUUID({
          instanceUrl: authState.instanceUrl,
          accessToken: authState.accessToken,
          uuids
        });
      } catch (e) {
        console.error("Failed to prefetch existing Hedge__c:", e?.response?.data || e?.message || e);
        // Non-fatal: we can proceed without merge, but open info might be overwritten
      }

      // Merge each incoming row with existing (non-destructive)
      const mergedForUpsert = hedgesForUpsert.map(incoming => {
        const key = incoming?.UUID_Text__c;
        
        const existing = key ? existingByUUID.get(key) : null;
        return existing ? mergePreservingOpen(existing, incoming) : mergePreservingOpen({}, incoming);
      });

      // --- 5) Batch upsert in a single call (no DML in loops)
      let sfResults = [];
      try {
        sfResults = await sfBatchUpsertHedgesByUUID(mergedForUpsert);
      } catch (e) {
        console.error("sfBatchUpsertHedgesByUUID failed:", e?.response?.data || e?.message || e);
        return res.status(502).json({ error: "Salesforce upsert failed", details: e?.message || "Unknown error" });
      }

      // --- 6) Build summary
      const successCount = sfResults.filter(r => r && r.success).length;
      const createdCount = sfResults.filter(r => r && r.created === true).length;
      const updatedCount = sfResults.filter(r => r && r.success && !r.created).length;
      const errors = sfResults
        .map((r, i) => ({ index: i, id: r?.id || null, errors: r?.errors || [] }))
        .filter(x => Array.isArray(x.errors) && x.errors.length > 0);

      const summary = {
        mtAccountId,
        sfAccountId,
        accountCode,
        timeRange: { from: fromIso, to: toIso },
        totalDealsInApiCall: deals.length,
        consolidatedPositions: consolidated.length,
        sentToSalesforce: hedgesForUpsert.length,
        success: successCount,
        created: createdCount,
        updated: updatedCount,
        errorCount: errors.length,
      };

      return res.json({
        summary,
        consolidatedPreview: hedgesForUpsert.slice(0, 5),
        rawResults: sfResults,
      });
    } catch (error) {
      // Defensive logging (no secrets)
      const errMsg = error?.response?.data || error?.message || String(error);
      console.error("Import/metatrader error:", errMsg);
      return res.status(500).json({ error: "Failed to import MetaTrader trades into Salesforce" });
    }
  });

  return router;
};

