// middleware/auth.js
const crypto = require("crypto");
const axios = require("axios");

let authState = {
  instanceUrl: null,
  accessToken: null,
  issuedAt: 0
};

function auth(req, res, next) {
  const header = req.get("Authorization") || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  const expected = process.env.API_TOKEN || "";
  const a = Buffer.from(token);
  const b = Buffer.from(expected);

  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return next();
}

/**
 * Logs in to Salesforce and caches token for TTL ms.
 * Defensive null handling + try/catch around the DML-equivalent callout.
 */
async function sfLogin({ ttlMs = 55 * 60 * 1000 } = {}) {
  // Reuse cached token if still fresh

  if (authState.accessToken && Date.now() - authState.issuedAt < ttlMs) {
    return authState;
  }

  const {
    SF_GRANT_TYPE,
    SF_CLIENT_ID,
    SF_CLIENT_SECRET,
    SF_USERNAME,
    SF_PASSWORD,
    SF_LOGIN_URL
  } = process.env;

  try {
    const body = new URLSearchParams();
    body.set("grant_type", SF_GRANT_TYPE || "password");
    body.set("client_id", SF_CLIENT_ID || "");
    body.set("client_secret", SF_CLIENT_SECRET || "");
    body.set("username", SF_USERNAME || "");
    body.set("password", SF_PASSWORD || "");

    const tokenUrl = `${(SF_LOGIN_URL || "https://login.salesforce.com")
      .replace(/\/+$/, "")}/services/oauth2/token`;

    const res = await axios.post(tokenUrl, body.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
      validateStatus: s => s >= 200 && s < 500
    });

    if (res.status >= 400) {
      throw new Error(`Salesforce auth failed ${res.status}: ${JSON.stringify(res.data)}`);
    }

    const instanceUrl = res?.data?.instance_url || null;
    const accessToken = res?.data?.access_token || null;

    if (!instanceUrl || !accessToken) {
      throw new Error("Salesforce auth response missing instance_url or access_token");
    }

    authState.instanceUrl = instanceUrl;
    authState.accessToken = accessToken;
    authState.issuedAt = Date.now();

    return authState;
  } catch (e) {
    // Informative, safe error
    const msg = e?.message || "Unknown Salesforce auth error";
    throw new Error(`sfLogin() exception: ${msg}`);
  }
}

module.exports = { auth, authState, sfLogin };
