/**
 * POST /api/coupons — public coupon lookup (no auth, rate-limited).
 *
 * The store page needs this because admin-created codes live in the server
 * DB, not in a buyer's browser localStorage. Without it a code minted in the
 * admin panel only works on the admin's own machine.
 *
 * Request:  { code }
 * Response: { ok:true, code, kind:"free"|"percent", pct, maxUses, uses, usable }
 *           { ok:false, error:"unknown-code" | "missing-code" | "coupon-exhausted" }
 *
 * Only the discount is revealed — never who created it or the note field.
 */
import { db } from "./_lib/db.js";
import { cors, json, readBody, rateLimit, clientIp } from "./_lib/auth.js";

function lookup(raw) {
  const c = String(raw || "").trim();
  if (!c) return null;
  const hit = db.get("coupons", c);
  if (hit) return { code: c, ...hit };
  const up = c.toUpperCase();
  for (const k of Object.keys(db.all("coupons"))) {
    if (k.toUpperCase() === up) return { code: k, ...db.get("coupons", k) };
  }
  return null;
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "method-not-allowed" });

  // Enumeration guard: a bot must not be able to grind the code space.
  const rl = rateLimit("cpn:" + clientIp(req), 30, 60 * 1000);
  if (!rl.ok) return json(res, 429, { ok: false, error: "too-many-requests" }, { "Retry-After": String(rl.retryAfter) });

  const body = readBody(req);
  const raw = String(body.code || "").trim();
  if (!raw) return json(res, 400, { ok: false, error: "missing-code" });

  const d = lookup(raw);
  if (!d) return json(res, 404, { ok: false, error: "unknown-code" });

  const uses = d.uses || 0;
  const maxUses = d.maxUses == null ? null : d.maxUses;
  const usable = maxUses == null || uses < maxUses;
  if (!usable) return json(res, 410, { ok: false, error: "coupon-exhausted" });

  return json(res, 200, {
    ok: true,
    code: d.code,
    kind: d.kind === "free" ? "free" : "percent",
    pct: d.kind === "free" ? 0 : d.pct || 0,
    maxUses,
    uses,
    usable,
  });
}
