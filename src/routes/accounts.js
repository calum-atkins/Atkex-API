// routes/accounts.js
const express = require("express");
const { fetchAccountInfo, createTradingAccount, getEquityInfo } = require("../metaapi/accounts");
const { updateTradingAccount } = require("../salesforce/accounts");
const { authState, sfLogin } = require("../middleware/auth");

function accountsRouter(auth, deps = {}) {
  const router = express.Router();

  router.post("/update", auth, async (req, res) => {
    const salesforceAccountId =
      req?.body?.salesforceAccountId ?? req?.query?.salesforceAccountId ?? null;
    const metatraderAccountId =
      req?.body?.metatraderAccountId ?? req?.query?.metatraderAccountId ?? null;

    if (!salesforceAccountId || !metatraderAccountId) {
      return res.status(400).json({
        error: "Missing required fields",
        details: {
          salesforceAccountId: !!salesforceAccountId,
          metatraderAccountId: !!metatraderAccountId,
        },
      });
    }

    // Ensure SF tokens are available (cached with TTL)
    /*try {
      await sfLogin(); // refresh if needed
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }*/

    const METAAPI_TOKEN = process.env.METATRADER_TOKEN; // keep naming consistent
    const SF_INSTANCE_URL = authState?.instanceUrl ?? null;
    const SF_ACCESS_TOKEN = authState?.accessToken ?? null;

    if (!METAAPI_TOKEN || !SF_INSTANCE_URL || !SF_ACCESS_TOKEN) {
      return res.status(500).json({
        error: "Server not configured",
        details: {
          METAAPI_TOKEN: !!METAAPI_TOKEN,
          SF_INSTANCE_URL: !!SF_INSTANCE_URL,
          SF_ACCESS_TOKEN: !!SF_ACCESS_TOKEN,
        },
      });
    }

    try {
      // 1) Fetch MT account info
      const acct = await fetchAccountInfo(metatraderAccountId, {
        userToken: METAAPI_TOKEN,
      });
      

      const username = acct?.username ?? null;
      const balance  = acct?.balance ?? null;
      const currency = acct?.currency ?? null;

      // 2) Update SF Trading_Account__c
      const result = await updateTradingAccount(
        { salesforceAccountId, username, balance, currency },
        { instanceUrl: SF_INSTANCE_URL, accessToken: SF_ACCESS_TOKEN }
      );

      return res.status(200).json({
        ok: true,
        salesforceUpdate: result,
        mappedFields: { username, balance, currency },
        source: { metaAccountId: metatraderAccountId },
      });
    } catch (err) {
      const message = err?.message || "Unhandled error";
      return res.status(502).json({ ok: false, error: message });
    }
  });
  
  
  router.post('/create-account', auth, async (req, res) => {
    try {
      const result = await createTradingAccount(req.body);
      res.status(result.status || 200).json(result);
    } catch (e) {
      res.status(500).json({ error: e?.message || 'Unknown error' });
    }
  });
  
  router.get('/equity-information', auth, async (req, res) => {
    try {
      const mtAccountId = (req.query.mtAccountId || req.body?.mtAccountId || "").trim();


      if (!mtAccountId) {
        return res.status(400).json({
          error: "Missing required fields",
          details: {
            mtAccountId: !!mtAccountId,
          },
        });
      }
      const METAAPI_TOKEN = process.env.METATRADER_TOKEN;
      const result = await getEquityInfo(mtAccountId, {
        userToken: METAAPI_TOKEN,
      });
      res.status(result.status || 200).json(result);
    } catch (e) {
      res.status(500).json({ error: e?.message || 'Unknown error' });
    }
  });

  return router;
}

module.exports = accountsRouter;
