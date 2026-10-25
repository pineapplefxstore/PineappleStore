/**
 * GET /api/health — deployment self-check. No secrets, no auth.
 *
 * Use this to confirm a backend is actually usable before pointing
 * window.PFX_API_BASE at it:
 *
 *   curl https://your-host/api/health
 *
 * `ready:false` means paid purchases and/or free-coupon claims will fail
 * closed, and `checks` names the missing piece. The single most common
 * misconfiguration is a serverless host: `storage.persistent:false` means
 * every license disappears on the next cold start.
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "./_lib/db.js";
import { cors, json } from "./_lib/auth.js";

function storageInfo() {
  const dir = process.env.DATA_DIR || path.join(process.cwd(), "data");
  let persistent = false;
  let writable = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    writable = true;
    persistent = !db.ephemeral;
  } catch {
    writable = false;
  }
  return { dir: path.basename(dir) ? dir.replace(process.cwd(), ".") : dir, writable, persistent };
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return json(res, 405, { ok: false, error: "method-not-allowed" });

  const storage = storageInfo();
  const verifiesPayments = process.env.PFX_ALLOW_UNVERIFIED !== "1";
  const checks = {
    mintSecret: !!process.env.MINT_SECRET,
    paypal: !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
    paymentVerification: verifiesPayments,
    persistentStorage: storage.persistent,
    mailer: !!(process.env.RESEND_API_KEY || process.env.SENDGRID_API_KEY),
    sessionSecret: !!(process.env.TOKEN_SECRET || process.env.MINT_SECRET),
  };

  // Minimum bar for "keys can be sold and delivered": mint + verified payments.
  const ready = checks.mintSecret && checks.paypal && checks.paymentVerification;

  return json(res, 200, {
    ok: true,
    service: "pineapplefx-licensing",
    ready,
    checks,
    storage,
    counts: {
      users: Object.keys(db.all("users") || {}).length,
      licenses: Object.keys(db.all("licenses") || {}).length,
      coupons: Object.keys(db.all("coupons") || {}).length,
      orders: Object.keys(db.all("orders") || {}).length,
    },
    time: new Date().toISOString(),
  });
}
