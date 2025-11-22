// metatrader/accounts.js
const axios = require("axios");
const crypto = require('crypto');
const { setMetaTraderId } = require('../salesforce/accounts');
const { sfLogin } = require('../middleware/auth')

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

/**
 * Create a MetaApi trading account.
 * Docs: POST /users/current/accounts
 *
 * Required headers:
 *  - auth-token: <METAAPI_TOKEN>
 *  - transaction-id: 32-char unique id (reuse for polling if 202)
 *
 * Options:
 *  - pollSeconds: how long to poll if 202 is returned (default 12s)
 */
async function createTradingAccount({
	
  // minimal common fields — add others you need from the swagger
  server,               // e.g. "mt5-broker.com:443" or broker label (per MetaApi spec)
  platform,             // "mt4" | "mt5"
  type,                 // usually "cloud-g1"
  baseCurrency,         // "USD" | "EUR"...
  //provisioningProfileId,// created earlier
  login,                // trading login
  password,             // trading password
  copyFactoryRoles = [],// e.g. ["PROVIDER"] or []
  // optional pass-through to write back to Salesforce
  sfTradingAccountId,
  sfAccountName
}, {
  baseUrl,
  token,
  pollSeconds = 12
} = {}) {
  baseUrl = (baseUrl || process.env.META_API_PROVISIONING || '').replace(/\/+$/, '');
  token   = token   || process.env.METATRADER_TOKEN;
  // ---- Null guards ----
  const required = { server, platform, type, baseCurrency, login, password, sfAccountName };
  for (const [k, v] of Object.entries(required)) {
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
      throw new Error(`Missing required field: ${k}`);
    }
  }
  if (!baseUrl) throw new Error('MetaApi baseUrl is required');
  if (!token)   throw new Error('MetaApi token is required');

  // Build request body exactly as MetaApi expects
  const account = {
    server,
    platform,
    type,
    baseCurrency,
    //provisioningProfileId,
    login: String(login),
    password,
    copyFactoryRoles,
    magic: 0,
    name: sfAccountName
    // add other fields from the model as needed: region, reliability, magic, tags, etc.
  };

  // 32-char transaction id (no dashes)
  const txId = crypto.randomUUID().replace(/-/g, '');

  // ---- POST create ----
  let res;
  try {
    res = await axios.post(`${baseUrl}/users/current/accounts`, account, {
      headers: {
        'auth-token': token,                 // MetaApi requires this header
        'transaction-id': txId,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
  } catch (err) {
    const msg = err?.response?.data || err?.message || err;
    console.error('createTradingAccount error:', msg);
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  // 201 → { id, state }, 202 → need to poll with same transaction-id
  let id = res?.data?.id;
  let state = res?.data?.state;

  if (res?.status === 202 || (!id && res?.status >= 200 && res?.status < 300)) {
    // Poll result using the same tx id. Endpoint is the same; server will return cached result.
    const deadline = Date.now() + pollSeconds * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const pollRes = await axios.post(`${baseUrl}/users/current/accounts`, account, {
          headers: {
            'auth-token': token,
            'transaction-id': txId,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        });
        if (pollRes?.data?.id) {
          id = pollRes.data.id;
          state = pollRes.data.state;
          break;
        }
      } catch {
        // swallow transient poll errors; keep looping until deadline
      }
    }
  }

  if (!id) {
    throw new Error(`MetaApi did not return an id. Raw: ${JSON.stringify(res?.data)}`);
  }

  // Optional: write back to Salesforce
  if (sfTradingAccountId) {
    try {
      const { instanceUrl, accessToken } = await sfLogin();
      await setMetaTraderId(
        { tradingAccountId: sfTradingAccountId, metaTraderId: id },
        { instanceUrl, accessToken }
      );
    } catch (e) {
      // Do not fail the main flow if SF update fails
      console.error('Failed to update Salesforce MetaTrader_Id__c:', e?.message || e);
    }
  }

  // Minimal response as you wanted
  return { id, state };
}

/**
 * Fetch MetaTrader account info by MetaApi account UUID.
 * Returns subset needed for Salesforce: { username, balance, currency }
 * - username maps to MT login (string), but you can change this mapping if you prefer 'name'
 *
 * Null handling:
 * - If response missing fields, returns nulls for those fields (never throws NPE).
 */
async function getEquityInfo(metaAccountId, { userToken } = {}) {
  if (!metaAccountId) {
    throw new Error("metaAccountId is required");
  }

  const url = `https://risk-management-api-v1.london.agiliumtrade.ai/users/current/accounts/${encodeURIComponent(metaAccountId)}/equity-chart`
  //const url =`${METAAPI_BASE}/users/current/accounts/${encodeURIComponent(metaAccountId)}/account-information`;
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

    return {
      raw: data
    };
  } catch (err) {
    // Keep the error informative but safe
    const message = err?.message || "Unknown MetaApi error";
    throw new Error(`Failed to fetch MetaTrader account info: ${message}`);
  }
}

async function deploy(metaAccountId, { userToken } = {}) {
  if (!metaAccountId) {
    throw new Error("metaAccountId is required");
  }

  const url = `https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${encodeURIComponent(metaAccountId)}/deploy`
  //const url =`${METAAPI_BASE}/users/current/accounts/${encodeURIComponent(metaAccountId)}/account-information`;
  try {
    const res = await axios.post(url, {}, {
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

    return {
      raw: data
    };
  } catch (err) {
    // Keep the error informative but safe
    const message = err?.message || "Unknown MetaApi error";
    throw new Error(`Failed to deploy metatrader account: ${message}`);
  }
}

async function undeploy(metaAccountId, { userToken } = {}) {
  if (!metaAccountId) {
    throw new Error("metaAccountId is required");
  }

  const url = `https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${encodeURIComponent(metaAccountId)}/undeploy`
  //const url =`${METAAPI_BASE}/users/current/accounts/${encodeURIComponent(metaAccountId)}/account-information`;
  try {
    const res = await axios.post(url, {}, {
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

    return {
      raw: data
    };
  } catch (err) {
    // Keep the error informative but safe
    const message = err?.message || "Unknown MetaApi error";
    throw new Error(`Failed to deploy metatrader account: ${message}`);
  }
}

module.exports = {
  fetchAccountInfo,  createTradingAccount, getEquityInfo, deploy, undeploy
};
