/**
 * GET /api/pricing — public pricing (admin-controlled, no auth).
 * The static site tries this (3s timeout) and falls back to baked-in
 * defaults, so file:// and offline previews keep working.
 * Response: { ok:true, pricing:{ regular, launch, launchEnd }, active:{ amount, launch } }
 */
import { db } from "./_lib/db.js";
import { cors, json } from "./_lib/auth.js";

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "GET") return json(res, 405, { ok: false, error: "method-not-allowed" });
  const p = db.all("pricing");
  const launch = Date.now() < Date.parse(p.launchEnd);
  return json(res, 200, {
    ok: true,
    pricing: p,
    active: { amount: launch ? p.launch : p.regular, launch },
  });
}
