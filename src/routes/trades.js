// routes/importMetatrader.js
const express = require("express");
const axios = require("axios");
const { sfLogin } = require("../middleware/auth");
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
        copy.UUID_Text__c = accountCode + "-" + copy.UUID_Text__c
        return copy;
      });

      // --- 4) Login to Salesforce (if your helper needs it)
      // await sfLogin();

      // --- 5) Batch upsert in a single call (no DML in loops)
      let sfResults = [];
      try {
        sfResults = await sfBatchUpsertHedgesByUUID(hedgesForUpsert);
      } catch (e) {
        // Upsert failure handled distinctly so you can see MT vs SF failure
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

