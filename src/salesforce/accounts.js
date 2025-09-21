// salesforce/accounts.js
const axios = require("axios");

/**
 * Update Trading_Account__c in Salesforce.
 * Required: { instanceUrl, accessToken }
 *
 * Fields default to Username__c, Balance__c, Currency__c
 * but can be overridden by env vars:
 * - SF_FIELD_USERNAME (default: 'Username__c')
 * - SF_FIELD_BALANCE  (default: 'Balance__c')
 * - SF_FIELD_CURRENCY (default: 'Currency__c')
 *
 * Null handling:
 * - If any field is null/undefined, we send it as null to SF (explicit patch),
 *   or you can omit by toggling SF_OMIT_NULLS=true (then undefined fields are skipped).
 *
 * Try/catch around the "DML" equivalent (the REST PATCH call).
 */
async function updateTradingAccount({
  salesforceAccountId,
  username,
  balance,
  currency,
}, { instanceUrl, accessToken } = {}) {
  if (!salesforceAccountId) throw new Error("salesforceAccountId is required");
  if (!instanceUrl) throw new Error("Salesforce instanceUrl is required");
  if (!accessToken) throw new Error("Salesforce accessToken is required");

  const fieldUsername = process.env.SF_FIELD_USERNAME || "Username__c";
  const fieldBalance  = process.env.SF_FIELD_BALANCE  || "Balance__c";
  const fieldCurrency = process.env.SF_FIELD_CURRENCY || "Currency__c";


  // Build the payload with explicit nulls (or omit nulls if configured)
  const omitNulls = /^true$/i.test(process.env.SF_OMIT_NULLS || "");
  const body = {};

  const assign = (key, value) => {
    if (omitNulls) {
      if (value !== undefined) body[key] = value;
    } else {
      body[key] = value ?? null;
    }
  };

  assign(fieldUsername, username);
  assign(fieldBalance, balance);
  assign(fieldCurrency, currency);

  const url = `${instanceUrl.replace(/\/+$/, "")}/services/data/v59.0/sobjects/Trading_Account__c/${encodeURIComponent(salesforceAccountId)}`;

  try {

    const res = await axios.patch(url, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: 15_000,
      validateStatus: (s) => s >= 200 && s < 500,
    });

    if (res.status >= 400) {
      throw new Error(`Salesforce update failed ${res.status}: ${JSON.stringify(res.data)}`);
    }

    return { success: true, status: res.status };
  } catch (e) {
    // Try/catch around the REST "DML" to match your standards
    const msg = e?.message || "Unknown Salesforce error";
    // Provide informative debug-like output (without leaking secrets)
    throw new Error(`Exception during Trading_Account__c update: ${msg}`);
  }
}

module.exports = {
  updateTradingAccount,
};
