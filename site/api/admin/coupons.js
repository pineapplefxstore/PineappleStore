/**
 * /api/admin/coupons — Delete and manage coupons.
 * DELETE /api/admin/coupons { code } -> purges coupon from DB.
 */
import { db } from "../_lib/db.js";
import { cors, json, readBody, requireAdmin } from "../_lib/auth.js";

const BUILTIN_COUPONS = {
  "PINFX-#UB-)5>}": true,
  "OWNPFX-UKVL&{4B": true,
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    cors(res);
    return res.status(204).end();
  }

  const users = db.all("users");
  const admin = requireAdmin(req, res, users);
  if (!admin) return null;
  const me = admin.email;

  if (req.method === "DELETE") {
    const body = readBody(req);
    const code = String(body.code || (req.query && req.query.code) || "").trim().toUpperCase();
    if (!code) return json(res, 400, { ok: false, error: "missing-code" });

    if (BUILTIN_COUPONS[code]) {
      return json(res, 400, { ok: false, error: "builtin-protected" });
    }

    if (!db.get("coupons", code)) {
      return json(res, 404, { ok: false, error: "not-found" });
    }

    db.remove("coupons", code);
    db.audit(me, "coupon-delete", code);
    return json(res, 200, { ok: true, code });
  }

  return json(res, 405, { ok: false, error: "method-not-allowed" });
}
