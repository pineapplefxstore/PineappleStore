/**
 * PineappleFX extra-machine deal — one-time $7.90 second slot per account.
 *
 *   GET  /api/extra-slot?email=you@mail.com
 *     → { ok:true, claimed:false }
 *     → { ok:true, claimed:true, machine, key, amount, at }
 *
 *   POST /api/extra-slot  { email, machine_id, orderID }
 *     → { ok:true, key, downloadUrl } | { ok:false, error }
 *     errors: missing-fields | bad-email | bad-machine | bad-transaction | underpaid
 *             verifier-unreachable | order-already-used | already-claimed
 *             account-disabled | server-misconfigured
 *
 * The slot is keyed by account email (lower-cased): exactly one claim per
 * account, ever. The minted key is a standard device-bound PFX2 key for the
 * second machine and is recorded in licenses (source "extra-slot") so
 * /api/verify-license and the admin panel treat it like any other key.
 */
import { db } from "./_lib/db.js";
import { cors, json, readBody, isAccountDisabled, rateLimit, clientIp } from "./_lib/auth.js";
import {
  normalizeKey,
  normalizeMachineId,
  mintLicense,
} from "./_lib/license.js";
import { verifyOrder } from "./_lib/paypal.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MACHINE_RE = /^[A-Za-z0-9]{8}$/;
export const SLOT_AMOUNT = "7.90";

export function slotFor(email) {
  return db.get("slots", String(email || "").trim().toLowerCase());
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // ---- status ----
  if (req.method === "GET") {
    const email = String(
      (req.query && req.query.email) || ""
    ).trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      return json(res, 400, { ok: false, error: "bad-email" });
    }
    const slot = slotFor(email);
    if (!slot || !slot.claimed) return json(res, 200, { ok: true, claimed: false });
    return json(res, 200, {
      ok: true,
      claimed: true,
      machine: slot.machine,
      key: slot.key,
      amount: slot.amount || SLOT_AMOUNT,
      at: slot.at,
    });
  }

  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "method-not-allowed" });
  }

  const rl = rateLimit("slot:" + clientIp(req), 20, 3600 * 1000);
  if (!rl.ok)
    return json(res, 429, { ok: false, error: "too-many-requests" }, { "Retry-After": String(rl.retryAfter) });

  const body = readBody(req);
  const email = String(body.email || "").trim().toLowerCase();
  const machineId = normalizeMachineId(body.machine_id || body.machineId || body.device);
  const orderId = String(body.orderID || body.order_id || body.orderId || body.txn_id || "").trim();

  if (!email || !machineId || !orderId) {
    return json(res, 400, { ok: false, error: "missing-fields" });
  }
  if (!EMAIL_RE.test(email)) {
    return json(res, 400, { ok: false, error: "bad-email" });
  }
  if (isAccountDisabled(db.all("users"), email)) {
    db.audit(email, "extra-slot-blocked-disabled", machineId);
    return json(res, 403, { ok: false, error: "account-disabled" });
  }
  if (!MACHINE_RE.test(machineId)) {
    return json(res, 400, { ok: false, error: "bad-machine" });
  }
  if (!orderId) {
    return json(res, 400, { ok: false, error: "bad-transaction" });
  }
  // ---- one-time gate: exactly one claim per account ----
  if (slotFor(email)?.claimed) {
    return json(res, 409, { ok: false, error: "already-claimed" });
  }

  // ---- payment proof: verify the PayPal order SERVER SIDE ----
  // $7.90 is the only price this endpoint sells, so the amount is fixed and
  // the client never gets to name it.
  const payment = await verifyOrder(orderId, { minAmount: Number(SLOT_AMOUNT), currency: "USD" });
  if (!payment.ok) {
    db.audit(email, "extra-slot-payment-rejected", `${machineId} / ${payment.error}`);
    const err =
      payment.error === "verifier-unconfigured" ? "server-misconfigured" :
      payment.error === "verifier-unreachable" ? "verifier-unreachable" :
      payment.error === "underpaid" ? "underpaid" :
      "bad-transaction";
    const status = err === "server-misconfigured" || err === "verifier-unreachable" ? 503 : 402;
    return json(res, status, { ok: false, error: err });
  }
  // Same order on the same machine = retry after a dropped response; return the
  // key already issued. A different machine or account = replay attempt.
  const prior = db.get("orders", orderId);
  if (prior) {
    if (prior.kind !== "extra-slot" || String(prior.machine).toUpperCase() !== machineId ||
        String(prior.email || "").toLowerCase() !== email) {
      db.audit(email, "extra-slot-order-replay", orderId);
      return json(res, 409, { ok: false, error: "order-already-used" });
    }
    return json(res, 200, { ok: true, key: prior.key, downloadUrl: prior.downloadUrl || "", emailed: false, recovered: true });
  }

  const secret = process.env.MINT_SECRET;
  if (!secret) {
    return json(res, 500, { ok: false, error: "server-misconfigured" });
  }

  const key = mintLicense(machineId, secret);
  const at = new Date().toISOString();
  const downloadUrl =
    process.env.DOWNLOAD_URL || "https://YOUR-USERNAME.github.io/pineapplefx/#install";
  db.set("slots", email, {
    claimed: true,
    orderID: orderId,
    machine: machineId,
    key,
    amount: SLOT_AMOUNT,
    at,
  });
  db.set("orders", orderId, {
    orderID: orderId,
    kind: "extra-slot",
    machine: machineId,
    email,
    key,
    downloadUrl,
    amount: payment.amount == null ? SLOT_AMOUNT : String(payment.amount),
    at,
  });
  db.set("licenses", normalizeKey(key), {
    key,
    email,
    machine: machineId,
    created: at,
    revoked: false,
    source: "extra-slot",
    coupon: "",
    orderID: orderId,
    amount: SLOT_AMOUNT,
  });
  db.audit(email, "extra-slot-claimed", `${machineId} / ${orderId}`);

  return json(res, 200, { ok: true, key, downloadUrl, emailed: false });
}
