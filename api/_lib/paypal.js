/**
 * PayPal order verification — SERVER SIDE ONLY.
 *
 * Why this exists
 * ---------------
 * The instant-checkout flow captures the order in the browser with the PayPal
 * JS SDK and then POSTs only `orderID` to /api/generate-license. Before this
 * module, the API accepted any string of 5+ characters as "payment proof",
 * which meant anyone could mint a free key with a made-up ID. That is a total
 * licensing bypass, so verification is now mandatory whenever a paid order is
 * claimed.
 *
 * What it checks
 * --------------
 *   1. The order exists on PayPal (GET /v2/checkout/orders/{id}).
 *   2. Its status is COMPLETED (the browser already captured it).
 *   3. The captured amount is at least the price the server expects.
 *   4. Currency matches (USD).
 *
 * Env
 * ---
 *   PAYPAL_CLIENT_ID       REST app client id   (required in production)
 *   PAYPAL_CLIENT_SECRET   REST app secret      (required in production)
 *   PAYPAL_ENV             "live" (default) or "sandbox"
 *   PFX_ALLOW_UNVERIFIED   "1" disables verification. LOCAL DEV / CI ONLY —
 *                          never set this on a public deployment. It is an
 *                          explicit opt-in so a missing PayPal config fails
 *                          closed instead of silently trusting order IDs.
 */

const LIVE_BASE = "https://api-m.paypal.com";
const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";

function apiBase() {
  return String(process.env.PAYPAL_ENV || "").toLowerCase() === "sandbox" ? SANDBOX_BASE : LIVE_BASE;
}

let tokenCache = { token: "", at: 0, base: "" };

async function accessToken() {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) return null;

  const base = apiBase();
  const now = Date.now();
  // Tokens live ~9h; refresh well before that.
  if (tokenCache.token && tokenCache.base === base && now - tokenCache.at < 50 * 60 * 1000) {
    return tokenCache.token;
  }

  const auth = Buffer.from(`${id}:${secret}`).toString("base64");
  let r;
  try {
    r = await fetch(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
  } catch {
    return null;
  }
  if (!r.ok) {
    console.warn("[pfx-paypal] token request failed:", r.status);
    return null;
  }
  const d = await r.json().catch(() => null);
  if (!d || !d.access_token) return null;
  tokenCache = { token: d.access_token, at: now, base };
  return d.access_token;
}

/** Test hook: forget the cached OAuth token. */
export function resetPaypalTokenCache() {
  tokenCache = { token: "", at: 0, base: "" };
}

/**
 * @param {string} orderID  PayPal order id from the browser
 * @param {{ minAmount?: number, currency?: string }} opts
 * @returns {Promise<{ok:true, orderID:string, amount:number|null, currency:string, email:string, status:string}
 *                 | {ok:false, error:string}>}
 */
export async function verifyOrder(orderID, opts = {}) {
  const id = String(orderID || "").trim();
  // Real PayPal order ids look like "5O190127TN364715T" (17 alnum chars).
  if (!/^[A-Za-z0-9-]{5,64}$/.test(id)) return { ok: false, error: "unverified" };

  if (process.env.PFX_ALLOW_UNVERIFIED === "1") {
    return { ok: true, orderID: id, amount: null, currency: "", email: "", status: "bypass" };
  }

  const token = await accessToken();
  if (!token) return { ok: false, error: "verifier-unconfigured" };

  let r;
  try {
    r = await fetch(`${apiBase()}/v2/checkout/orders/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { ok: false, error: "verifier-unreachable" };
  }
  if (!r.ok) {
    // Unknown order id, or someone else's order. Treat as invalid payment.
    return { ok: false, error: "unverified" };
  }

  let order;
  try {
    order = await r.json();
  } catch {
    return { ok: false, error: "unverified" };
  }
  if (!order || String(order.status || "").toUpperCase() !== "COMPLETED") {
    return { ok: false, error: "not-completed" };
  }

  const unit = (Array.isArray(order.purchase_units) && order.purchase_units[0]) || {};
  const amountObj = unit.amount || {};
  const amount = Number(amountObj.value);
  const currency = String(amountObj.currency_code || "").toUpperCase();
  const wantCurrency = String(opts.currency || "USD").toUpperCase();

  if (!Number.isFinite(amount)) return { ok: false, error: "unverified" };
  if (currency && currency !== wantCurrency) return { ok: false, error: "wrong-currency" };

  const min = Number(opts.minAmount || 0);
  if (Number.isFinite(min) && min > 0 && amount + 0.009 < min) {
    return { ok: false, error: "underpaid", amount, currency };
  }

  const payerEmail = String(order.payer?.email_address || "").trim();
  return { ok: true, orderID: id, amount, currency: currency || wantCurrency, email: payerEmail, status: "COMPLETED" };
}
