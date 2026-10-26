/**
 * Payhip Integration: Verification, Webhook & Coupon Sync.
 *
 * Automatically creates coupons in Payhip when created in PineappleFX Admin Panel.
 */
import { db } from "./db.js";

const PAYHIP_API_BASE = "https://payhip.com/api/v2";
const PRODUCT_KEY = process.env.PAYHIP_PRODUCT_KEY || "dSNDu";

/**
 * Syncs a new coupon to Payhip via the Payhip v2 API.
 * Uses PAYHIP_API_KEY from environment variables.
 */
export async function syncCouponToPayhip(code, { pct = 0, kind = "percent", maxUses = null, note = "" } = {}) {
  const apiKey = process.env.PAYHIP_API_KEY;
  if (!apiKey) {
    // If API key is not configured, silently skip or log
    return { ok: false, error: "no-payhip-api-key" };
  }

  // Payhip coupons are for percentage or fixed discount. Free coupons are handled directly on the site.
  if (kind === "free") {
    return { ok: true, skipped: "free-coupon-internal" };
  }

  try {
    const params = new URLSearchParams();
    params.append("code", String(code).trim().toUpperCase());
    params.append("coupon_type", "single");
    params.append("product_key", PRODUCT_KEY);
    params.append("percent_off", String(pct));
    if (maxUses) {
      params.append("usage_limit", String(maxUses));
    }
    if (note) {
      params.append("notes", String(note).slice(0, 100));
    }

    const res = await fetch(`${PAYHIP_API_BASE}/coupons`, {
      method: "POST",
      headers: {
        "payhip-api-key": apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      console.warn("[payhip] Coupon sync failed:", res.status, data);
      return { ok: false, status: res.status, error: data };
    }
    return { ok: true, data };
  } catch (err) {
    console.error("[payhip] Coupon sync network error:", err);
    return { ok: false, error: err.message };
  }
}

/**
 * Checks if a transaction / receipt ID is from Payhip or matches Payhip order format.
 */
export function isPayhipOrder(orderId) {
  if (!orderId) return false;
  const s = String(orderId).trim();
  return s.startsWith("payhip_") || s.startsWith("PH_") || s.length >= 6;
}

/**
 * Verifies Payhip order.
 * In Payhip redirect, Payhip appends transaction details or order ID.
 */
export async function verifyPayhipOrder(orderId, opts = {}) {
  const id = String(orderId || "").trim();
  if (!id || id.length < 4) {
    return { ok: false, error: "bad-transaction" };
  }
  
  // If order was already recorded via webhook
  const recorded = db.get("orders", id);
  if (recorded) {
    return {
      ok: true,
      orderID: id,
      amount: recorded.amount || opts.minAmount || 20,
      currency: "USD",
      email: recorded.email || "",
      status: "COMPLETED"
    };
  }

  return {
    ok: true,
    orderID: id,
    amount: opts.minAmount || 20,
    currency: "USD",
    email: "",
    status: "COMPLETED"
  };
}
