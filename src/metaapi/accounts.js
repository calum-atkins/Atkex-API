// metatrader/accounts.js
const axios = require("axios");

const METAAPI_BASE = process.env.METAAPI_BASE_URL
  || "https://mt-client-api-v1.london.agiliumtrade.ai";

/**
 * Fetch MetaTrader account info by MetaApi account UUID.
 * Returns subset needed for Salesforce: { username, balance, currency }
 * - username maps to MT login (string), but you can change this mapping if you prefer 'name'
 *
 * Null handling:
 * - If response missing fields, returns nulls for those fields (never throws NPE).
 */
async function fetchAccountInfo(metaAccountId, { userToken } = {}) {
  if (!metaAccountId) {
    throw new Error("metaAccountId is required");
  }
  if (!userToken) {
    throw new Error("MetaApi userToken (bearer) is required");
  }

  const url =
    `${METAAPI_BASE}/users/current/accounts/${encodeURIComponent(metaAccountId)}/account-information`;
  try {
    const res = await axios.get(url, {
      headers: {
        "auth-token": `${userToken}`,
        "Content-Type": "application/json",
      },
      timeout: 15_000,
      validateStatus: (s) => s >= 200 && s < 500, // handle 4xx in code
    });

    if (res.status >= 400) {
      throw new Error(`MetaApi error ${res.status}: ${JSON.stringify(res.data)}`);
    }

    const data = res?.data ?? {};
    // Null-pointer expectation handling (explicit defaults)
    const login = data?.login != null ? String(data.login) : null;
    const name = data?.name != null ? String(data.name) : null;
    const balance = typeof data?.balance === "number" ? data.balance : null;
    const currency = data?.currency != null ? String(data.currency) : null;

    // Decide which to use for Username__c (default: login)
    const usernamePref = process.env.MT_USERNAME_SOURCE || "login"; // "login" or "name"
    const username = usernamePref === "name" ? name : login;

    return {
      raw: data, // handy for logs/debug, don’t push to SF directly
      username,
      balance,
      currency,
    };
  } catch (err) {
    // Keep the error informative but safe
    const message = err?.message || "Unknown MetaApi error";
    throw new Error(`Failed to fetch MetaTrader account info: ${message}`);
  }
}

module.exports = {
  fetchAccountInfo,
};
