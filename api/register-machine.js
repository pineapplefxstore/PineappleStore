/**
 * POST /api/register-machine — bind a machine ID to a PENDING vault entry.
 *
 * Called automatically by the AE plugin gate on first successful activation,
 * and by the dashboard "Activate PC" / "Change PC" button.
 *
 * Request:  { key, machine_id }
 *           key        – the license key the user just activated (normalized)
 *           machine_id – the 8-char device ID read by the AE panel
 *
 * Auth: none required (key acts as the credential; rate-limited by IP).
 *
 * Logic:
 *   1. Validate + normalize inputs.
 *   2. Verify the key's FNV signature matches the supplied machine_id.
 *   3. Look up the email that owns this key in db.licenses.
 *   4. Load the owner's vault; find the PENDING placeholder (or existing entry).
 *   5. Rebind: mint a real machine-bound key, update vault + licenses + machines.
 *   6. Return { ok: true, key: newKey }.
 */
import { db } from "./_lib/db.js";
import { json, readBody, rateLimit, clientIp } from "./_lib/auth.js";
import {
  mintLicense,
  normalizeKey,
  normalizeMachineId,
  verifySignature,
  KEY_RE,
} from "./_lib/license.js";

export default async function handler(req, res) {
  const { cors } = await import("./_lib/auth.js");
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "method-not-allowed" });

  const rl = rateLimit("regmid:" + clientIp(req), 30, 10 * 60 * 1000);
  if (!rl.ok) return json(res, 429, { ok: false, error: "too-many-requests" }, { "Retry-After": String(rl.retryAfter) });

  const body = readBody(req);
  const rawKey = body.key || body.license_key || body.licenseKey || "";
  const rawMid = body.machine_id || body.machineId || body.device || "";

  const key = normalizeKey(rawKey);
  const mid = normalizeMachineId(rawMid);

  if (!key || !mid) return json(res, 400, { ok: false, error: "missing-fields" });
  if (!KEY_RE.test(mid)) return json(res, 400, { ok: false, error: "invalid-machine-id" });

  const secret = process.env.MINT_SECRET;
  if (!secret) return json(res, 500, { ok: false, error: "server-misconfigured" });

  // --- 1. Verify the key's signature is valid for this machine ---
  if (!verifySignature(key, mid, secret)) {
    return json(res, 403, { ok: false, error: "signature-mismatch" });
  }

  // --- 2. Find the email that owns this key ---
  const licenses = db.all("licenses");
  let ownerEmail = null;
  let pendingSlot = null; // the DB key (machine slot) that held the PENDING entry

  // First try direct DB lookup by key
  const licRecord = licenses[key];
  if (licRecord) {
    ownerEmail = licRecord.email || null;
  }

  // If not in DB (placeholder key stored in-memory on client only), we need
  // to scan users' vaults for the PENDING entry matching this key.
  if (!ownerEmail) {
    const users = db.all("users");
    for (const email of Object.keys(users)) {
      const u = users[email];
      const vault = u.vault || {};
      for (const slot of Object.keys(vault)) {
        const entry = vault[slot];
        if (entry && normalizeKey(entry.key) === key) {
          ownerEmail = email;
          pendingSlot = slot;
          break;
        }
      }
      if (ownerEmail) break;
    }
  }

  if (!ownerEmail) {
    // Key is unknown to this server — accept if signature is valid (legacy enroll),
    // but we can't update a vault. Just register the machine.
    const newKey = mintLicense(mid, secret);
    db.set("licenses", newKey.replace(/[^0-9A-Z]/g, ""), {
      key: newKey,
      email: "",
      machine: mid,
      created: new Date().toISOString(),
      revoked: false,
      source: "auto-register-anonymous",
    });
    const m = db.get("machines", mid) || { machine: mid, firstSeen: new Date().toISOString() };
    m.lastSeen = new Date().toISOString();
    m.key = newKey;
    db.set("machines", mid, m);
    db.audit("?", "register-machine-anon", mid);
    return json(res, 200, { ok: true, key: newKey });
  }

  // --- 3. Mint a real machine-bound key for this device ---
  const newKey = mintLicense(mid, secret);
  const normNew = normalizeKey(newKey);

  // --- 4. Update licenses table ---
  // Mark old placeholder key as superseded (if it was in DB)
  if (licRecord) {
    db.set("licenses", key, { ...licRecord, machine: mid, superseded: true });
  }
  db.set("licenses", normNew, {
    key: newKey,
    email: ownerEmail,
    machine: mid,
    created: new Date().toISOString(),
    revoked: false,
    source: "auto-register",
  });

  // --- 5. Update machines table ---
  const m = db.get("machines", mid) || { machine: mid, firstSeen: new Date().toISOString() };
  m.lastSeen = new Date().toISOString();
  m.email = ownerEmail;
  m.key = newKey;
  db.set("machines", mid, m);

  // --- 6. Update user vault ---
  const users = db.all("users");
  const userRec = users[ownerEmail];
  if (userRec) {
    const vault = userRec.vault || {};
    // Remove the PENDING slot (or the old entry for this key)
    const slotToRemove = pendingSlot || "PENDING";
    if (vault[slotToRemove] && normalizeKey((vault[slotToRemove].key || "")) === key) {
      delete vault[slotToRemove];
    }
    // Also remove any other slot that held the same key
    for (const slot of Object.keys(vault)) {
      if (normalizeKey((vault[slot]?.key || "")) === key && slot !== mid) {
        delete vault[slot];
      }
    }
    // Write the new real entry
    vault[mid] = {
      key: newKey,
      at: Date.now(),
      orderID: (licRecord?.orderID) || "AUTO",
      machine: mid,
    };
    userRec.vault = vault;
    db.set("users", ownerEmail, userRec);
  }

  db.audit(ownerEmail, "register-machine-ok", mid);
  return json(res, 200, { ok: true, key: newKey });
}
