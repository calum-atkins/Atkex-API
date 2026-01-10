// middleware/auth.js
const crypto = require("crypto");
const axios = require("axios");

class SalesforceAuthManager {
  constructor() {
    this.authState = {
      instanceUrl: null,
      accessToken: null,
      issuedAt: 0,
    };

    // Start a daily scheduled refresh when this module is loaded
    this.startDailyRefresh();
  }

  /**
   * Logs in to Salesforce and caches token.
   * - If force = true, always fetches a new token.
   * - Otherwise, reuses token while within ttlMs.
   */
  async sfLogin({ force = false, ttlMs = 55 * 60 * 1000 } = {}) {
    // Reuse cached token if still fresh and not forced
    if (
      !force &&
      this.authState.accessToken &&
      Date.now() - this.authState.issuedAt < ttlMs
    ) {
      return this.authState;
    }

    const {
      SF_GRANT_TYPE,
      SF_CLIENT_ID,
      SF_CLIENT_SECRET,
      SF_USERNAME,
      SF_PASSWORD,
      SF_LOGIN_URL,
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
        validateStatus: (s) => s >= 200 && s < 500,
      });

      if (res.status >= 400) {
        throw new Error(
          `Salesforce auth failed ${res.status}: ${JSON.stringify(res.data)}`
        );
      }

      const instanceUrl = res?.data?.instance_url || null;
      const accessToken = res?.data?.access_token || null;

      if (!instanceUrl || !accessToken) {
        throw new Error(
          "Salesforce auth response missing instance_url or access_token"
        );
      }

      // Update shared auth state in place
      this.authState.instanceUrl = instanceUrl;
      this.authState.accessToken = accessToken;
      this.authState.issuedAt = Date.now();

      return this.authState;
    } catch (e) {
      const msg = e?.message || "Unknown Salesforce auth error";
      throw new Error(`sfLogin() exception: ${msg}`);
    }
  }

  /**
   * Schedule a daily forced refresh of the Salesforce token.
   * For now: runs every day at 02:00 server time.
   */
  startDailyRefresh() {
    const runHour = 2; // 02:00 server local time
    
    console.log("[SF AUTH] Daily refresh: Starting daily refresh...");
    
    // 🔹 RUN ONCE IMMEDIATELY (TEST / STARTUP CONFIRMATION)
    (async () => {
      try {
        console.log("[SF AUTH] Immediate refresh for startup test...");
        await this.sfLogin({ force: true });
        console.log("[SF AUTH] Immediate refresh successful.");
      } catch (e) {
        console.error("[SF AUTH] Immediate refresh failed:", e.message);
      }
    })();

    const scheduleNext = () => {
      const now = new Date();
      const target = new Date(now);

      // Schedule for "tomorrow" at 02:00
      target.setDate(now.getDate() + 1);
      target.setHours(runHour, 0, 0, 0);

      const delayMs = target.getTime() - now.getTime();

      setTimeout(async () => {
        try {
          console.log("[SF AUTH] Daily refresh: requesting new Salesforce token...");
          const state = await this.sfLogin({ force: true });

          // ⚠️ This logs the raw access token. Be careful in real prod logs.
          console.log("[SF AUTH] Daily refresh complete. New access token:");
        } catch (e) {
          console.error("[SF AUTH] Daily refresh failed:", e.message);
        } finally {
          // Schedule the next daily refresh
          scheduleNext();
        }
      }, delayMs);
    };

    scheduleNext();
  }
}

/**
 * Simple API auth middleware (unrelated to Salesforce token).
 */
function auth(req, res, next) {
  const header = req.get("Authorization") || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res
      .status(401)
      .json({ error: "Missing or invalid Authorization header" });
  }

  const expected = process.env.API_TOKEN || "";
  const a = Buffer.from(token);
  const b = Buffer.from(expected);

  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return next();
}

// Single shared instance for the whole app
const sfAuthManager = new SalesforceAuthManager();

module.exports = {
  auth,
  // Keep the same exports you already use
  authState: sfAuthManager.authState,
  sfLogin: sfAuthManager.sfLogin.bind(sfAuthManager),
  // Also export the manager if you ever want more control
  sfAuthManager,
};
