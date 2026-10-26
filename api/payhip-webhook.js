/**
 * Payhip Webhook endpoint: /api/payhip-webhook
 *
 * Automatically called by Payhip when a buyer finishes purchase.
 * Creates the order record in the database, generates a key if machine ID is present,
 * or registers the order so the user can claim their key instantly upon redirecting.
 */
import { db } from "./_lib/db.js";
import { cors, json, readBody } from "./_lib/auth.js";
import { generateLicenseKey } from "./generate-license.js";

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "method-not-allowed" });
  }

  const body = readBody(req);
  // Payhip webhook payload contains:
  // type: "paid", id: transaction_id, email, price, currency, items...
  const orderId = String(body.id || body.transaction_id || body.order_id || body.orderID || "").trim();
  const email = String(body.email || body.buyer_email || "").trim().toLowerCase();
  const amount = String(body.price || body.amount || "20.00").trim();

  if (!orderId) {
    return json(res, 400, { ok: false, error: "missing-order-id" });
  }

  const existing = db.get("orders", orderId);
  if (!existing) {
    db.set("orders", orderId, {
      orderID: orderId,
      email: email || "",
      amount: amount,
      kind: "payhip",
      at: new Date().toISOString(),
      verified: true
    });
    db.audit(email || "payhip", "payhip-order-received", `${orderId} ($${amount})`);
  }

  return json(res, 200, { ok: true, message: "Payhip order registered" });
}
