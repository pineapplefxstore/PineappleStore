/**
 * PineappleFX extra-machine deal — one-time $7.90 second slot per account.
 *
 *   GET  /api/extra-slot?email=you@mail.com
 *     → { ok:true, claimed:false }
 *     → { ok:true, claimed:true, machine, key, amount, at }
 *
 *   POST /api/extra-slot  { email, machine_id, orderID }
 *     → { ok:true, key, downloadUrl } | { ok:false, error }
 *     errors: missing-fields | bad-email | bad-machine | bad-transaction
 *             already-claimed | server-misconfigured
 *
 * The slot is keyed by account email (lower-cased): exactly one claim per
 * account, ever. The minted key is a standard device-bound PFX2 key for the
 * second machine and is recorded in licenses (source "extra-slot") so
 * /api/verify-license and the admin panel treat it like any other key.
 */
import { db } from "./_lib/db.js";
import { cors, json, readBody, isAccountDisabled } from "./_lib/auth.js";
import {
  normalizeKey,
  normalizeMachineId,
  mintLicense,
} from "./_lib/license.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MACHINE_RE = /^[A-Za-z0-9]{8}$/;
export const SLOT_AMOUNT = "7.90";

export function slotFor(email) {
  return db.get("slots", String(email || "").trim().toLowerCase());
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    cors(res);
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
  if (orderId.length < 5) {
    return json(res, 400, { ok: false, error: "bad-transaction" });
  }
  // ---- one-time gate: exactly one claim per account ----
  if (slotFor(email)?.claimed) {
    return json(res, 409, { ok: false, error: "already-claimed" });
  }

  const secret = process.env.MINT_SECRET;
  if (!secret) {
    return json(res, 500, { ok: false, error: "server-misconfigured" });
  }

  const key = mintLicense(machineId, secret);
  const at = new Date().toISOString();
  db.set("slots", email, {
    claimed: true,
    orderID: orderId,
    machine: machineId,
    key,
    amount: SLOT_AMOUNT,
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

  const downloadUrl =
    process.env.DOWNLOAD_URL || "https://YOUR-USERNAME.github.io/pineapplefx/#install";
  return json(res, 200, { ok: true, key, downloadUrl, emailed: false });
}
