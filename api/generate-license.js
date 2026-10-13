/**
 * PineappleFX — automated, self-hosted licensing backend.
 *
 * Deploy: this file is a Vercel / Netlify-style serverless function.
 *   Vercel:      put `site/` as the project root → POST /api/generate-license
 *   Netlify:     same path works via Netlify Functions redirect, or copy to
 *                netlify/functions/generate-license.js
 *   Local dev:   `npx vercel dev` (serves site/ + api/ together on one port,
 *                which is also what fixes `file://` fetch failures).
 *
 * Key scheme: FNV-1a device binding, IDENTICAL to the AE panel gate.
 *   See the CANONICAL comment on generateLicenseKey below.
 *
 * Env vars (never commit these):
 *   MINT_SECRET      MUST equal the panel SECRET (tools/mint_key.py SECRET).
 *                    Rotating it requires rebuilding + reshipping the .zxp,
 *                    or previously issued keys stop validating.
 *   RESEND_API_KEY   (preferred) Resend API key for delivery
 *   SENDGRID_API_KEY (fallback)  SendGrid API key for delivery
 *   MAIL_FROM        e.g. "PineappleFX <keys@yourdomain.com>"
 *   DOWNLOAD_URL     public installer URL put in the delivery email
 *                    (default: https://YOUR-USERNAME.github.io/PineappleStore/downloads/PineappleFX.zxp
 *                     — replace YOUR-USERNAME with the GitHub account hosting Pages)
 *
 * Instant flow (no manual txn digging):
 *   PayPal onApprove captures the order in-page → frontend POSTs
 *   { orderID, email (PayPal payer email), machine_id, amount, coupon }.
 *   `orderID` is accepted as transaction proof (no txn_id typing needed).
 *   Legacy manual flow ({ email, machine_id, txn_id, coupon }) still works.
 *
 * Request (JSON):  { email | payer_email, machine_id, txn_id | orderID, coupon, amount }
 * Response (JSON): { ok:true, key, emailed:true|false } | { ok:false, error }
 */
import crypto from "node:crypto";
import { db } from "./_lib/db.js";
import { isAccountDisabled, cors, json, readBody, rateLimit, clientIp } from "./_lib/auth.js";
import {
  ALPHA,
  fnv1a,
  sigFor,
  normalizeKey,
  normalizeMachineId,
  mintLicense,
  verifySignature,
} from "./_lib/license.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MACHINE_RE = /^[A-Za-z0-9]{8}$/;

// Re-exported for backward compatibility (tests / tooling).
export { ALPHA, fnv1a, sigFor, normalizeKey, normalizeMachineId };
export const generateLicenseKey = (machineId, secret) => mintLicense(machineId, secret);
export function verifyLicenseKey(key, machineId, secret) {
  const k = normalizeKey(key);
  const device = normalizeMachineId(machineId);
  if (k.length !== 20 || !k.startsWith("PFX2") || !MACHINE_RE.test(device)) return false;
  const want = k.slice(12, 20);
  const got = sigFor(String(secret), k.slice(4, 12), device);
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
  } catch {
    return false;
  }
}

// Site-side coupons (price logic only — NOT panel unlock codes).
// Built-ins always work. Admin-generated codes (Admin Panel → Coupon
// generator) must ALSO be mirrored here via env, otherwise the deployed API
// rejects them with bad-coupon (local simulation mode doesn't need this):
//   COUPON_ALLOWLIST='{"PFX-AB12-CD34":"percent:25","PFX-VIP1":"free"}'
// Values: "free" | "half" (=percent:50) | "percent:N" | N (number = % off).
const COUPONS = {
  "PINFX-#UB-)5>}": "half", // 50% off — txn still required
  "OWNPFX-UKVL&{4B": "free", // owner — no payment, txn optional
};

function extraCoupons() {
  try {
    const raw = process.env.COUPON_ALLOWLIST || process.env.EXTRA_COUPONS || "";
    if (!raw) return {};
    const o = JSON.parse(raw);
    const out = {};
    for (const k of Object.keys(o || {})) {
      const v = o[k];
      if (v === "free" || v === "half" || typeof v === "number") out[k] = v;
      else if (typeof v === "string" && /^percent:\d{1,2}$/.test(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function normCouponValue(v) {
  if (v === "free") return "free";
  if (v === "half") return "half";
  if (typeof v === "number" && v >= 1 && v <= 99) return `percent:${Math.round(v)}`;
  if (typeof v === "string" && /^percent:([1-9][0-9]?)$/.test(v)) return v;
  return "invalid";
}

/**
 * Canonical scheme lives in ./_lib/license.js (single source of truth,
 * re-exported above). Coupon sources, in order: built-ins → DB coupons
 * (admin panel) → COUPON_ALLOWLIST env.
 */
function allCoupons() {
  const out = { ...COUPONS, ...extraCoupons() };
  for (const k of Object.keys(db.all("coupons"))) {
    const d = db.get("coupons", k);
    if (d) out[k] = d.kind === "free" ? "free" : `percent:${d.pct || 0}`;
  }
  return out;
}

function couponKind(raw) {
  const c = String(raw || "").trim();
  if (!c) return "";
  const all = allCoupons();
  if (all[c]) return normCouponValue(all[c]);
  const up = c.toUpperCase();
  for (const k of Object.keys(all)) {
    if (k.toUpperCase() === up) return normCouponValue(all[k]);
  }
  return "invalid";
}

/** One-time $7.90 deal claimed for this account email? */
function slotClaimedFor(email) {
  const slot = db.get("slots", String(email || "").trim().toLowerCase());
  return !!(slot && slot.claimed);
}

/** Distinct non-revoked machines holding keys for this account email. */
function distinctMachinesFor(email) {
  const want = String(email || "").trim().toLowerCase();
  const seen = new Set();
  for (const rec of Object.values(db.all("licenses"))) {
    if (rec && !rec.revoked && String(rec.email || "").toLowerCase() === want && rec.machine) {
      seen.add(String(rec.machine).toUpperCase());
    }
  }
  return [...seen];
}

/** Max-uses + existence check against the DB copy of a coupon code. */
function couponUsableDb(raw) {
  const c = String(raw || "").trim();
  if (!c) return true;
  const hit = db.get("coupons", c);
  if (!hit) {
    const up = c.toUpperCase();
    for (const k of Object.keys(db.all("coupons"))) {
      if (k.toUpperCase() === up) {
        const d = db.get("coupons", k);
        if (d.maxUses != null && (d.uses || 0) >= d.maxUses) return false;
        return true;
      }
    }
    return true; // builtin / env codes have no server-side counter
  }
  if (hit.maxUses != null && (hit.uses || 0) >= hit.maxUses) return false;
  return true;
}

function couponUseDb(raw) {
  const c = String(raw || "").trim();
  if (!c) return;
  let hit = db.get("coupons", c) ? c : null;
  if (!hit) {
    const up = c.toUpperCase();
    for (const k of Object.keys(db.all("coupons"))) {
      if (k.toUpperCase() === up) {
        hit = k;
        break;
      }
    }
  }
  if (!hit) return;
  const d = db.get("coupons", hit);
  d.uses = (d.uses || 0) + 1;
  db.set("coupons", hit, d);
}

async function sendViaResend({ to, subject, text, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { skipped: true };
  const from = process.env.MAIL_FROM || "PineappleFX <keys@localhost>";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, text, html }),
  });
  if (!r.ok) throw new Error(`resend-${r.status}`);
  return { sent: true, via: "resend" };
}

async function sendViaSendGrid({ to, subject, text, html }) {
  const key = process.env.SENDGRID_API_KEY;
  if (!key) return { skipped: true };
  const from = process.env.MAIL_FROM || "keys@localhost";
  const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from.replace(/^.*<(.*)>.*$/, "$1") || from },
      subject,
      content: [
        { type: "text/plain", value: text },
        { type: "text/html", value: html },
      ],
    }),
  });
  if (!r.ok && r.status !== 202) throw new Error(`sendgrid-${r.status}`);
  return { sent: true, via: "sendgrid" };
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "method-not-allowed" });
  }

  // Email-sending endpoint: strict rate limit stops spam abuse.
  const rl = rateLimit("gen:" + clientIp(req), 20, 3600 * 1000);
  if (!rl.ok)
    return json(res, 429, { ok: false, error: "too-many-requests" }, { "Retry-After": String(rl.retryAfter) });

  const body = readBody(req);
  const email = String(
    body.email || body.payer_email || body.payerEmail || ""
  ).trim();
  const machineId = String(body.machine_id || body.machineId || body.device || "")
    .trim()
    .toUpperCase();
  // Instant flow: PayPal orderID captured in-page counts as transaction proof.
  const orderId = String(body.orderID || body.order_id || body.orderId || "").trim();
  const txnId = String(
    body.txn_id || body.txnId || body.txn || orderId || ""
  ).trim();
  const amount = String(body.amount || "").trim();
  const couponRaw = String(body.coupon || "").trim();
  const kind = couponKind(couponRaw);

  // ---- validation: machine_id + (orderID/txn XOR valid coupon) ----
  // Email is required for paid orders (receipt delivery) but optional for
  // free-coupon claims — the key is displayed instantly on screen anyway.
  const emailOptional = kind === "free";
  if (!machineId || (!txnId && !couponRaw) || (!email && !emailOptional)) {
    return json(res, 400, { ok: false, error: "missing-fields" });
  }
  if (email && !EMAIL_RE.test(email)) {
    return json(res, 400, { ok: false, error: "bad-email" });
  }
  if (email && isAccountDisabled(db.all("users"), email)) {
    db.audit(email, "license-blocked-disabled", machineId);
    return json(res, 403, { ok: false, error: "account-disabled" });
  }
  if (!MACHINE_RE.test(machineId)) {
    return json(res, 400, { ok: false, error: "bad-machine" });
  }
  if (couponRaw && kind === "invalid") {
    return json(res, 400, { ok: false, error: "bad-coupon" });
  }
  if (couponRaw && !couponUsableDb(couponRaw)) {
    return json(res, 400, { ok: false, error: "coupon-exhausted" });
  }
  const isFreeClaim = kind === "free";
  if (!isFreeClaim && txnId.length < 5) {
    return json(res, 400, { ok: false, error: "bad-transaction" });
  }

  // ---- strict 1-machine-per-license: a paid issuance for a NEW distinct
  // machine is allowed only while the account is within its slot budget
  // (1 base slot + 1 if the one-time $7.90 extra-machine deal was claimed).
  // Same-machine reissue, free-coupon claims, and key-less emails bypass.
  if (email && !isFreeClaim) {
    const allowed = slotClaimedFor(email) ? 2 : 1;
    const used = distinctMachinesFor(email);
    if (!used.includes(machineId) && used.length >= allowed) {
      db.audit(email, "machine-limit-hit", machineId);
      return json(res, 403, { ok: false, error: "machine-limit", allowed });
    }
  }

  const secret = process.env.MINT_SECRET;
  if (!secret) {
    // Fail loudly but gracefully — frontend turns this into a readable message.
    return json(res, 500, { ok: false, error: "server-misconfigured" });
  }

  // ---- mint (CSPRNG serial + canonical FNV-1a device binding, panel-valid) ----
  const key = generateLicenseKey(machineId, secret);

  // ---- record (drives /api/verify-license revocation + admin panel) ----
  db.set("licenses", normalizeKey(key), {
    key,
    email: email || "",
    machine: machineId,
    created: new Date().toISOString(),
    revoked: false,
    source: couponRaw ? "coupon" : "purchase",
    coupon: couponRaw || "",
    orderID: orderId || "",
    amount: amount || "",
  });
  if (couponRaw) couponUseDb(couponRaw);
  db.audit(email || "?", "license-issued", `${machineId}${couponRaw ? " / " + couponRaw : ""}`);

  // ---- deliver (Resend → SendGrid → graceful no-mailer mode) ----
  const downloadUrl =
    process.env.DOWNLOAD_URL || "https://YOUR-USERNAME.github.io/PineappleStore/downloads/PineappleFX.zxp";
  const subject = "Your PineappleFX license key";
  const text =
    `Thanks for buying PineappleFX!\n\n` +
    `Your license key (locked to one machine):\n${key}\n\n` +
    `Machine ID: ${machineId}\n` +
    (orderId ? `PayPal Order: ${orderId}\n` : "") +
    (txnId && txnId !== orderId ? `Transaction: ${txnId}\n` : "") +
    (amount ? `Amount: $${amount} USD\n` : "") +
    (couponRaw ? `Coupon: ${couponRaw}\n` : "") +
    `\nDownload / install guide:\n${downloadUrl}\n\n` +
    `Paste the key into the locked panel to unlock — it works offline from there.\n` +
    `Keep this email: your key lives here.`;
  const html =
    `<p>Thanks for buying PineappleFX!</p>` +
    `<p>Your license key (locked to one machine):</p>` +
    `<p style="font-family:monospace;font-size:18px;font-weight:bold;">${key}</p>` +
    `<p>Machine ID: <b>${machineId}</b>` +
    (orderId ? `<br>PayPal Order: ${orderId}` : "") +
    (txnId && txnId !== orderId ? `<br>Transaction: ${txnId}` : "") +
    (amount ? `<br>Amount: $${amount} USD` : "") +
    (couponRaw ? `<br>Coupon: ${couponRaw}` : "") +
    `</p><p><a href="${downloadUrl}">Download / install guide</a></p>` +
    `<p>Paste the key into the locked panel to unlock — it works offline from there. Keep this email: your key lives here.</p>`;

  let emailed = false;
  let mailer = "none";
  if (email) {
    try {
      const viaResend = await sendViaResend({ to: email, subject, text, html });
      if (viaResend.sent) {
        emailed = true;
        mailer = viaResend.via;
      } else {
        const viaSg = await sendViaSendGrid({ to: email, subject, text, html });
        if (viaSg.sent) {
          emailed = true;
          mailer = viaSg.via;
        }
      }
    } catch (err) {
      // Key is already minted — never fail the request because mail hiccuped.
      // Frontend shows the key inline AND reports the mail problem.
      console.error("license-email-failed:", err?.message || err);
      return json(res, 200, { ok: true, key, emailed: false, mailer: "failed", downloadUrl, error: "email-failed" });
    }
  }

  return json(res, 200, { ok: true, key, emailed, mailer, downloadUrl });
}
