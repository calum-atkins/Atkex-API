// routes/strategies.js
const express = require("express");
const axios = require("axios");

// If you already have your auth() middleware, reuse it here
const { auth, authState, sfLogin } = require("../middleware/auth"); // or inline if you prefer

// Helper: deep-remove null/undefined
function stripNulls(obj) {
  if (obj == null || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    const vv = stripNulls(v);
    if (vv !== null && vv !== undefined &&
        !(Array.isArray(vv) && vv.length === 0) &&
        !(typeof vv === "object" && !Array.isArray(vv) && Object.keys(vv).length === 0)) {
      out[k] = vv;
    }
  }
  return out;
}

// OPTIONAL: pull fields from Salesforce by Strategy__c Id (if you’d rather send just the SF Id)
// Requires you to have instanceUrl/accessToken in memory (your existing sfLogin() flow)
async function loadSfStrategy({ instanceUrl, accessToken, strategyId }) {
  if (!instanceUrl || !accessToken || !strategyId) return null; // null-guard
  const fields = [
    "Id",
    "Name",                         // Strategy Name (Text(80))
    "Description__c",
    "Skip_Pending_Orders__c",
    "Trading_Account__c",
    "Reverse__c",
    "Copy_Stop_Loss__c",
    "Copy_Take_Profit__c",
    "Scale__c",                     // Picklist: e.g. Fixed, Risk, None
    "Fixed_Lot_Size__c",            // Number(4,2)
    "Risk_Percentage__c"            // Number(2,2) e.g. 2.00 => 2%
  ];

  const url = `${instanceUrl}/services/data/v59.0/sobjects/Strategy__c/${encodeURIComponent(strategyId)}?fields=${fields.join(",")}`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return res?.data ?? null; // null-guard
}

// Map SF fields -> CopyFactory payload
function mapToCopyFactoryPayload(sf) {
  if (!sf) return null; // null-guard

  // Trade size scaling mapping rules:
  // - Scale__c == 'Fixed'        -> fixed-volume using Fixed_Lot_Size__c
  // - Scale__c == 'Risk'         -> risk-fixed-fraction using Risk_Percentage__c / 100
  // - otherwise                  -> none
  let tradeSizeScaling = { mode: "none" };
  if (sf.Scale__c === "Fixed lot size" && sf.Fixed_Lot_Size__c != null) {
    tradeSizeScaling = {
      mode: "fixedVolume",
      tradeVolume: Number(sf.Fixed_Lot_Size__c)
    };
  } else if (sf.Scale__c === "Risk" && sf.Risk_Percentage__c != null) {
    // API expects a fraction (0.02 for 2%), while SF stores percent like 2.00
    tradeSizeScaling = {
      mode: "risk-fixed-fraction",
      riskFraction: Number(sf.Risk_Percentage__c) / 100
    };
  }

  const payload = {
    name: sf.Name ?? undefined,
    description: sf.Description__c ?? undefined,
    skipPendingOrders: !!sf.Skip_Pending_Orders__c,
    // You can pass accountId from the request (preferred),
    // or derive from Trading_Account__c via an extra lookup if you store the CopyFactory account id there.
    reverse: !!sf.Reverse__c,
    copyStopLoss: !!sf.Copy_Stop_Loss__c,
    copyTakeProfit: !!sf.Copy_Take_Profit__c,
    tradeSizeScaling
    // Add other sections (filters, limits, etc.) later as you add fields in SF
  };

  return stripNulls(payload);
}


/** -------- Router factory (so you can inject your auth middleware) -------- */
module.exports = (auth) => {
  const router = express.Router();
  
  /**
   * GET /api/meta/strategies/new-id
   * Calls CopyFactory unused-strategy-id endpoint and returns the id
   */
  router.get("/new-id", auth, async (req, res) => {
    try {
      const META_API_URL = process.env.META_API_COPYFACTORY ?? "https://copyfactory-api-v1.new-york.agiliumtrade.ai";
      const authToken = req.get("meta-auth-token") || process.env.METATRADER_TOKEN;
      if (!authToken) return res.status(401).json({ error: "Missing meta-auth-token" });

      const url = `${META_API_URL}/users/current/configuration/unused-strategy-id`;

      const getRes = await axios.get(url, {
        headers: {
          "auth-token": authToken,
          "content-type": "application/json"
        },
        timeout: 15000
      });

      // Return just the id from CopyFactory response
      return res.status(200).json({ id: getRes.data?.id });
    } catch (err) {
      const status = err.response?.status ?? 500;
      return res.status(status).json({
        error: "Failed to fetch unused strategy id",
        status,
        details: err.response?.data ?? err.message
      });
    }
  });
  

	/**
	 * PUT /api/meta/strategies/:strategyId
	 * Body options:
	 *  A) { accountId, sfStrategyId } – we fetch fields from SF
	 *  B) { raw }                     – you pass raw payload directly
	 *  C) { fieldsFromSalesforce }    – you pass the SF fields and we map
	 *
	 * Header:
	 *  - meta-auth-token: token for CopyFactory (or use env META_AUTH_TOKEN)
	 */
	router.put("/create/:strategyId", auth, async (req, res) => {
	  const strategyId = req.params?.strategyId;
	  if (!strategyId) return res.status(400).json({ error: "Missing strategyId path param" });

	  try {
		let payload;

		if (req.body?.raw && typeof req.body.raw === "object") {
		  // Full control (already CopyFactory shape)
		  payload = stripNulls(req.body.raw);
		} else if (req.body?.fieldsFromSalesforce) {
		  // Client posted SF fields; we map
		  payload = mapToCopyFactoryPayload(req.body.fieldsFromSalesforce);
		  if (req.body.accountId) payload.accountId = req.body.accountId;
		} else if (req.body?.sfStrategyId) {
		  // We’ll fetch the Strategy__c from SF and map it
		  // NOTE: assumes you’ve logged into SF already and keep these in memory
		  await sfLogin();//const { instanceUrl, accessToken } = require("../state/sfAuthState"); // wherever you store them

		  const sfRec = await loadSfStrategy({
			instanceUrl : authState.instanceUrl,
			accessToken: authState.accessToken,
			strategyId: req.body.sfStrategyId
		  });
		  if (!sfRec) return res.status(404).json({ error: "Salesforce Strategy__c not found" });
		  payload = mapToCopyFactoryPayload(sfRec);
		  if (req.body.accountId) payload.accountId = req.body.accountId;
		} else {
		  return res.status(400).json({ error: "Provide raw, fieldsFromSalesforce, or sfStrategyId" });
		}

		if (!payload) return res.status(400).json({ error: "Unable to build payload (null)" });

		const META_API_URL = process.env.META_API_COPYFACTORY ?? "https://copyfactory-api-v1.new-york.agiliumtrade.ai";//process.env.META_API_URL ?? "https://copyfactory.metaanalytics.ai";
		const authToken = req.get("meta-auth-token") || process.env.METATRADER_TOKEN;
		if (!authToken) return res.status(401).json({ error: "Missing meta-auth-token" });

		const url = `${META_API_URL}/users/current/configuration/strategies/${encodeURIComponent(strategyId)}`;

		const putRes = await axios.put(url, payload, {
		  headers: {
			"auth-token": authToken,
			"content-type": "application/json"
		  },
		  timeout: 15000
		});
		

		return res.status(putRes.status).json({
		  status: putRes.status,
		  statusText: putRes.statusText,
		  body: putRes.data
		});
	  } catch (err) {
		// Always return something informative
		const status = err.response?.status ?? 500;
		return res.status(status).json({
		  error: "CopyFactory update failed",
		  status,
		  details: err.response?.data ?? err.message
		});
	  }
	});

  return router;
};

