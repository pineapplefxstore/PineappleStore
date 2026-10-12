/**
 * POST /api/admin — RBAC-gated administration (requires is_admin JWT).
 *   { action, ... } → JSON. Every action is audit-logged. Confirmations
 *   happen in the UI; the API enforces auth + validation unconditionally.
 *
 *   overview                  → counts, revenue estimate, recent audit
 *   users                     → [{ email, machines, licenses, created, is_admin }]
 *   licenses {filter?}        → all license records (newest audit-first cap 200)
 *   license-generate {email, machine} → mint + record a key (server FNV)
 *   license-revoke {key}      → revoke (panel locks on next check)
 *   license-reset {key, machine} → re-bind a key to a new machine (PC switch)
 *   coupons                   → all coupon defs (db + builtin flag)
 *   coupon-create {code, kind, pct?, maxUses?, note?}
 *   coupon-delete {code}      → db codes only (builtins protected)
 *   pricing                   → current { regular, launch, launchEnd }
 *   pricing-set {regular?, launch?, launchEnd?}
 *   audit {limit?}            → recent audit log
 */
import crypto from "node:crypto";
import { db } from "./_lib/db.js";
import { cors, json, readBody, requireAdmin, isAccountDisabled } from "./_lib/auth.js";
import { mintLicense, normalizeKey, normalizeMachineId, verifySignature } from "./_lib/license.js";

const CODE_RE = /^[A-Z0-9-]{4,24}$/;

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    cors(res);
    return res.status(204).end();
  }
  if (req.method !== "POST" && req.method !== "DELETE") return json(res, 405, { ok: false, error: "method-not-allowed" });

  const users = db.all("users");
  const admin = requireAdmin(req, res, users);
  if (!admin) return null;
  const me = admin.email;

  const body = readBody(req);
  const action = String(body.action || "");

  /* ---------- DELETE method (e.g. DELETE /api/admin) ---------- */
  if (req.method === "DELETE") {
    const code = String(body.code || (req.query && req.query.code) || "").trim().toUpperCase();
    if (code) {
      if (builtinCoupons()[code]) return json(res, 400, { ok: false, error: "builtin-protected" });
      if (!db.get("coupons", code)) return json(res, 404, { ok: false, error: "not-found" });
      db.remove("coupons", code);
      db.audit(me, "coupon-delete", code);
      return json(res, 200, { ok: true, code });
    }
    return json(res, 400, { ok: false, error: "missing-target" });
  }

  /* ---------- overview ---------- */
  if (action === "overview") {
    const licenses = db.all("licenses");
    const keys = Object.keys(licenses);
    const active = keys.filter((k) => !licenses[k].revoked);
    const coupons = db.all("coupons");
    const pricing = db.all("pricing");
    const paid = active.filter((k) => {
      const c = licenses[k].coupon ? normCoupon(licenses[k].coupon) : null;
      return !c || c.kind !== "free";
    }).length;
    return json(res, 200, {
      ok: true,
      users: Object.keys(users).length,
      licenses: keys.length,
      active: active.length,
      revoked: keys.length - active.length,
      machines: Object.keys(db.all("machines")).length,
      coupons: Object.keys(coupons).length,
      paidKeys: paid,
      revenueEst: (paid * parseFloat(pricing.launch || "20")).toFixed(2),
      ephemeral: db.ephemeral,
      audit: db.all("audit").slice(0, 20),
    });
  }

  /* ---------- users ---------- */
  if (action === "users") {
    const vault = db.all("licenses");
    const rows = Object.values(users).map((u) => {
      const mine = Object.values(vault).filter((l) => l.email === u.email);
      return {
        email: u.email,
        is_admin: !!u.is_admin,
        disabled: !!u.disabled,
        created: u.created,
        licenses: mine.length,
        machines: [...new Set(mine.map((l) => l.machine))],
      };
    });
    return json(res, 200, { ok: true, users: rows });
  }

  if (action === "user-deactivate") {
    const targetEmail = String(body.email || "").trim().toLowerCase();
    if (!targetEmail) return json(res, 400, { ok: false, error: "missing-email" });
    if (targetEmail === "pineapplefx.store@gmail.com") return json(res, 400, { ok: false, error: "cannot-deactivate-admin" });
    const u = users[targetEmail];
    if (!u) return json(res, 404, { ok: false, error: "user-not-found" });
    const nextDisabled = body.disabled !== undefined ? !!body.disabled : !u.disabled;
    u.disabled = nextDisabled;
    db.set("users", targetEmail, u);
    db.audit(me, nextDisabled ? "user-deactivate" : "user-activate", targetEmail);
    return json(res, 200, { ok: true, email: targetEmail, disabled: nextDisabled });
  }

  if (action === "user-delete") {
    const targetEmail = String(body.email || "").trim().toLowerCase();
    if (!targetEmail) return json(res, 400, { ok: false, error: "missing-email" });
    if (targetEmail === "pineapplefx.store@gmail.com") return json(res, 400, { ok: false, error: "cannot-delete-admin" });
    if (!users[targetEmail]) return json(res, 404, { ok: false, error: "user-not-found" });
    db.remove("users", targetEmail);
    const allLicenses = db.all("licenses");
    const purgedKeys = [];
    for (const [k, rec] of Object.entries(allLicenses)) {
      if (String(rec.email || "").toLowerCase() === targetEmail) {
        purgedKeys.push(k);
        db.remove("licenses", k);
      }
    }
    const allMachines = db.all("machines");
    for (const [mId, mRec] of Object.entries(allMachines)) {
      if (String(mRec.email || "").toLowerCase() === targetEmail || purgedKeys.includes(mRec.key)) {
        db.remove("machines", mId);
      }
    }
    if (db.get("slots", targetEmail)) {
      db.remove("slots", targetEmail);
    }
    db.audit(me, "user-delete", targetEmail);
    return json(res, 200, { ok: true, email: targetEmail, purgedLicenses: purgedKeys.length });
  }

  /* ---------- licenses ---------- */
  if (action === "licenses") {
    const q = String(body.filter || "").toUpperCase();
    let rows = Object.values(db.all("licenses")).sort((a, b) =>
      String(b.created).localeCompare(String(a.created))
    );
    if (q) rows = rows.filter((l) => (l.key + l.email + l.machine + (l.source || "") + (l.coupon || "") + (l.orderID || "")).toUpperCase().includes(q));
    return json(res, 200, { ok: true, licenses: rows.slice(0, 200), total: rows.length });
  }

  if (action === "license-generate") {
    const email = String(body.email || "").trim().toLowerCase();
    const machine = normalizeMachineId(body.machine);
    const secret = process.env.MINT_SECRET;
    if (!secret) return json(res, 500, { ok: false, error: "server-misconfigured" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { ok: false, error: "bad-email" });
    if (isAccountDisabled(users, email)) return json(res, 403, { ok: false, error: "account-disabled" });
    if (!/^[A-Za-z0-9]{8}$/.test(machine)) return json(res, 400, { ok: false, error: "bad-machine" });
    const key = mintLicense(machine, secret);
    db.set("licenses", normalizeKey(key), {
      key,
      email,
      machine,
      created: new Date().toISOString(),
      revoked: false,
      source: "admin",
      by: me,
    });
    db.audit(me, "license-generate", `${email} / ${machine}`);
    return json(res, 200, { ok: true, key });
  }

  if (action === "license-revoke") {
    const key = normalizeKey(body.key);
    const rec = db.get("licenses", key);
    if (!rec) return json(res, 404, { ok: false, error: "not-found" });
    rec.revoked = true;
    rec.revokedAt = new Date().toISOString();
    db.set("licenses", key, rec);
    db.audit(me, "license-revoke", `${rec.email} / ${rec.machine}`);
    return json(res, 200, { ok: true });
  }

  if (action === "license-reset") {
    // Re-bind a key to a new machine (legit PC switch): new key, old revoked.
    const key = normalizeKey(body.key);
    const machine = normalizeMachineId(body.machine);
    const secret = process.env.MINT_SECRET;
    if (!secret) return json(res, 500, { ok: false, error: "server-misconfigured" });
    if (!/^[A-Za-z0-9]{8}$/.test(machine)) return json(res, 400, { ok: false, error: "bad-machine" });
    const rec = db.get("licenses", key);
    if (!rec) return json(res, 404, { ok: false, error: "not-found" });
    rec.revoked = true;
    rec.revokedAt = new Date().toISOString();
    db.set("licenses", key, rec);
    const fresh = mintLicense(machine, secret);
    db.set("licenses", normalizeKey(fresh), {
      key: fresh,
      email: rec.email,
      machine,
      created: new Date().toISOString(),
      revoked: false,
      source: "reset",
      by: me,
      resetFrom: key,
    });
    db.audit(me, "license-reset", `${rec.machine} → ${machine}`);
    return json(res, 200, { ok: true, key: fresh });
  }

  /* ---------- coupons ---------- */
  if (action === "coupons") {
    return json(res, 200, { ok: true, coupons: db.all("coupons"), builtin: builtinCoupons() });
  }

  if (action === "coupon-create") {
    const code = String(body.code || "").trim().toUpperCase();
    const kind = body.kind === "free" ? "free" : "percent";
    const pct = Math.round(Number(body.pct) || 0);
    const maxUses = body.maxUses === null || body.maxUses === "" || body.maxUses == null ? null : Math.max(1, parseInt(body.maxUses, 10) || 1);
    if (!CODE_RE.test(code)) return json(res, 400, { ok: false, error: "bad-code" });
    if (builtinCoupons()[code] || db.get("coupons", code)) return json(res, 409, { ok: false, error: "exists" });
    if (kind !== "free" && !(pct >= 1 && pct <= 99)) return json(res, 400, { ok: false, error: "bad-pct" });
    db.set("coupons", code, {
      kind,
      pct: kind === "free" ? 0 : pct,
      note: String(body.note || "").slice(0, 60),
      maxUses,
      uses: 0,
      created: new Date().toISOString(),
      by: me,
    });
    db.audit(me, "coupon-create", code);
    return json(res, 200, { ok: true, code });
  }

  if (action === "coupon-delete") {
    const code = String(body.code || "").trim().toUpperCase();
    if (builtinCoupons()[code]) return json(res, 400, { ok: false, error: "builtin-protected" });
    if (!db.get("coupons", code)) return json(res, 404, { ok: false, error: "not-found" });
    db.remove("coupons", code);
    db.audit(me, "coupon-delete", code);
    return json(res, 200, { ok: true });
  }

  /* ---------- pricing ---------- */
  if (action === "pricing") {
    return json(res, 200, { ok: true, pricing: db.all("pricing") });
  }

  if (action === "pricing-set") {
    const p = db.all("pricing");
    if (body.regular != null) {
      if (!/^\d+(\.\d{1,2})?$/.test(String(body.regular))) return json(res, 400, { ok: false, error: "bad-regular" });
      p.regular = Number(body.regular).toFixed(2);
    }
    if (body.launch != null) {
      if (!/^\d+(\.\d{1,2})?$/.test(String(body.launch))) return json(res, 400, { ok: false, error: "bad-launch" });
      p.launch = Number(body.launch).toFixed(2);
    }
    if (body.launchEnd != null) {
      const t = Date.parse(String(body.launchEnd));
      if (Number.isNaN(t)) return json(res, 400, { ok: false, error: "bad-launchEnd" });
      p.launchEnd = new Date(t).toISOString();
    }
    db.set("pricing", "regular", p.regular);
    db.set("pricing", "launch", p.launch);
    db.set("pricing", "launchEnd", p.launchEnd);
    db.audit(me, "pricing-set", JSON.stringify(p));
    return json(res, 200, { ok: true, pricing: p });
  }

  if (action === "audit") {
    const limit = Math.min(200, Math.max(1, parseInt(body.limit, 10) || 50));
    return json(res, 200, { ok: true, audit: db.all("audit").slice(0, limit) });
  }

  return json(res, 400, { ok: false, error: "bad-action" });
}

function builtinCoupons() {
  return {
    "PINFX-#UB-)5>}": { kind: "percent", pct: 50, note: "Launch 50% off", builtin: true },
    "OWNPFX-UKVL&{4B": { kind: "free", pct: 0, note: "Owner", builtin: true },
  };
}

function normCoupon(code) {
  const c = String(code || "").trim();
  if (!c) return null;
  if (builtinCoupons()[c]) return builtinCoupons()[c];
  const hit = db.get("coupons", c);
  if (hit) return hit;
  const up = c.toUpperCase();
  for (const k of Object.keys(builtinCoupons())) if (k.toUpperCase() === up) return builtinCoupons()[k];
  for (const k of Object.keys(db.all("coupons"))) if (k.toUpperCase() === up) return db.get("coupons", k);
  return null;
}
