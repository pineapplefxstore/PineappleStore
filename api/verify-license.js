/**
 * POST /api/verify-license — server-validated activation handshake.
 *
 * Request:  { machine_id, license_key }
 * Response: { ok:true, token, exp } | { ok:false, error }
 *
 * Validation order:
 *   1.Normalize inputs → 2. DB record exists and not revoked → 3. Offline-
 *   equivalent FNV signature check (MINT_SECRET) for keys minted outside the
 *   DB (legacy/manual mints) → 4. Issue short-lived signed JWT session token.
 *
 * Token payload: { mid (machine), kh (key sha256, privacy), typ:"license" },
 * TTL: LICENSE_TOKEN_TTL (default 30 days). The panel caches it and
 * revalidates; see the PFX-GATE block for the grace policy.
 */
import crypto from "node:crypto";
import { db } from "./_lib/db.js";
import { json, readBody, signJWT, rateLimit, clientIp } from "./_lib/auth.js";
import { normalizeKey, normalizeMachineId, verifySignature } from "./_lib/license.js";

const TOKEN_TTL = parseInt(process.env.LICENSE_TOKEN_TTL || "2592000", 10); // 30d

export default async function handler(req, res) {
  const { cors } = await import("./_lib/auth.js");
  cors(req, res);
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "method-not-allowed" });

  const rl = rateLimit("verify:" + clientIp(req), 120, 10 * 60 * 1000);
  if (!rl.ok)
    return json(res, 429, { ok: false, error: "too-many-requests" }, { "Retry-After": String(rl.retryAfter) });

  const body = readBody(req);
  const machine = normalizeMachineId(body.machine_id || body.machineId || body.device);
  const key = normalizeKey(body.license_key || body.licenseKey || body.key);

  if (!machine || !key) return json(res, 400, { ok: false, error: "missing-fields" });

  const secret = process.env.MINT_SECRET;
  if (!secret) return json(res, 500, { ok: false, error: "server-misconfigured" });

  // 1) DB record (revocation-aware)
  const record = db.get("licenses", key);
  if (record) {
    if (record.revoked) {
      db.audit(record.email || "?", "verify-revoked", machine);
      return json(res, 403, { ok: false, error: "revoked" });
    }
    // Auto-detect and sync machine if license was pending or unassigned
    if (!record.machine || record.machine === "PENDING" || record.machine === "?") {
      record.machine = machine;
      record.autoBoundAt = new Date().toISOString();
      db.set("licenses", key, record);
      db.audit(record.email || "?", "verify-autobound", machine);
    } else if (record.machine !== machine) {
      db.audit(record.email || "?", "verify-wrong-machine", machine);
      return json(res, 403, { ok: false, error: "wrong-machine" });
    }
  } else {
    // 2) Legacy/manual keys: accept a correct offline signature, then enroll.
    if (!verifySignature(key, machine, secret)) {
      db.audit("?", "verify-invalid", machine);
      return json(res, 403, { ok: false, error: "invalid" });
    }
    db.set("licenses", key, {
      key,
      email: "",
      machine,
      created: new Date().toISOString(),
      revoked: false,
      source: "legacy-enroll",
    });
  }

  const m = db.get("machines", machine) || { machine, firstSeen: new Date().toISOString() };
  m.lastSeen = new Date().toISOString();
  m.key = key;
  db.set("machines", machine, m);

  const kh = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  let token;
  try {
    token = signJWT({ mid: machine, kh, typ: "license" }, TOKEN_TTL);
  } catch {
    return json(res, 500, { ok: false, error: "server-misconfigured" });
  }
  db.audit(record?.email || "?", "verify-ok", machine);
  return json(res, 200, {
    ok: true,
    token,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL,
    ttl: TOKEN_TTL,
  });
}
