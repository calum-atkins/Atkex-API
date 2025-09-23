// routes/subscriber.js
const express = require("express");
const axios = require("axios");

// Reuse your existing auth stack
const { auth, authState, sfLogin } = require("../middleware/auth");

// Helper: deep-remove null/undefined/empty
function stripNulls(obj) {
  if (obj == null || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    const vv = stripNulls(v);
    if (
      vv !== null &&
      vv !== undefined &&
      !(Array.isArray(vv) && vv.length === 0) &&
      !(typeof vv === "object" && !Array.isArray(vv) && Object.keys(vv).length === 0)
    ) {
      out[k] = vv;
    }
  }
  return out;
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// Pull Subscriber__c + related Trading_Account + child Strategy_Subscriptions in one go
async function loadSfSubscriber({ instanceUrl, accessToken, sfSubscriberId }) {
  if (!instanceUrl || !accessToken || !sfSubscriberId) return null; // null-guard
  const soql =
    `SELECT Id, Name, Trading_Account__c, ` +
    `       Trading_Account__r.MetaTrader_ID__c, ` +
    `       (SELECT Id, Name, Multiplier__c, Active__c, Strategy__r.External_Id__c ` +
    `          FROM Strategy_Subscriptions__r) ` +
    `  FROM Subscriber__c ` +
    ` WHERE Id = '${sfSubscriberId.replace(/'/g, "\\'")}'`;

  const url = `${instanceUrl}/services/data/v59.0/query`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: { q: soql },
    timeout: 15000
  });
  return res?.data ?? null; // null-guard
}

/** -------- Router factory (so you can inject your auth middleware) -------- */
module.exports = (authMw) => {
  const router = express.Router();

  /**
   * POST /api/meta/subscribers/apply/:sfSubscriberId
   * Header:
   *  - meta-auth-token: CopyFactory token (or use env METATRADER_TOKEN)
   *
   * Flow:
   *  - Loads SF Subscriber__c, its Trading_Account__r.MetaApi_Account_Id__c, and child Strategy_Subscriptions__r
   *  - Builds { name, subscriptions[] }
   *  - PUT https://.../users/current/configuration/subscribers/{MetaApi_Account_Id__c}
   */
  router.put("/apply/:sfSubscriberId", authMw, async (req, res) => {
    const sfSubscriberId = req.params?.sfSubscriberId;
    if (!isNonEmptyString(sfSubscriberId)) {
      return res.status(400).json({ error: "Missing sfSubscriberId path param" });
    }

    try {
      // Ensure we have SF creds in memory
      if (!authState.instanceUrl || !authState.accessToken) {
        await sfLogin();
      }

      // Load from Salesforce
      const queryResult = await loadSfSubscriber({
        instanceUrl: authState.instanceUrl,
        accessToken: authState.accessToken,
        sfSubscriberId
      });

      const recs = queryResult?.records || [];
      if (!Array.isArray(recs) || recs.length === 0) {
        return res.status(404).json({ error: "Subscriber__c not found in Salesforce", sfSubscriberId });
      }

      const sub = recs[0] || null;
      const subscriberName = sub?.Name || null;
      const metaApiAccountId = sub?.Trading_Account__r?.MetaTrader_ID__c || null;

      if (!isNonEmptyString(subscriberName)) {
        return res.status(400).json({ error: "Subscriber__c.Name is blank/null in Salesforce" });
      }
      if (!isNonEmptyString(metaApiAccountId)) {
        return res.status(400).json({
          error: "Missing MetaApi Account Id",
          message: "Populate Trading_Account__r.MetaApi_Account_Id__c on the related Trading_Account__c"
        });
      }

      // Build subscriptions array from child Strategy_Subscriptions__r (filter Active__c = true)
      const children = (sub?.Strategy_Subscriptions__r?.records || []).filter(c => c?.Active__c === true);

      const subscriptions = [];
      for (const c of children) {
        const strategyId = c?.Strategy__r.External_Id__c;
        const multiplier = (typeof c?.Multiplier__c === "number" && isFinite(c.Multiplier__c))
          ? c.Multiplier__c
          : 1;
        if (!isNonEmptyString(strategyId)) continue; // skip incomplete child rows

        subscriptions.push(stripNulls({
          strategyId,
          multiplier
          // If you store scaling fields on the child later, map them here:
          // tradeSizeScaling: { mode: "none" }
        }));
      }

      if (subscriptions.length === 0) {
        return res.status(400).json({
          error: "No active Strategy_Subscription__c rows with StrategyId__c found",
          note: "Set Active__c=true and StrategyId__c on child rows"
        });
      }

      // Compose CopyFactory payload
      const payload = stripNulls({
        name: subscriberName,
        subscriptions
      });

      const META_API_URL = process.env.META_API_COPYFACTORY ?? "https://copyfactory-api-v1.new-york.agiliumtrade.ai";
      const authToken = req.get("meta-auth-token") || process.env.METATRADER_TOKEN;
      if (!authToken) return res.status(401).json({ error: "Missing meta-auth-token" });

      const url = `${META_API_URL}/users/current/configuration/subscribers/${encodeURIComponent(metaApiAccountId)}`;

      // PUT to CopyFactory
      const putRes = await axios.put(url, payload, {
        headers: {
          "auth-token": authToken,
          "content-type": "application/json"
        },
        timeout: 20000
      });

      return res.status(putRes.status).json({
        status: putRes.status,
        statusText: putRes.statusText,
        body: putRes.data,
        metaApiAccountId,
        appliedSubscriptions: subscriptions.length
      });
    } catch (err) {
      const status = err.response?.status ?? 500;
      return res.status(status).json({
        error: "CopyFactory subscriber apply failed",
        status,
        details: err.response?.data ?? err.message
      });
    }
  });


  return router;
};
