/**
 * PineappleFX canonical license scheme — SINGLE SOURCE OF TRUTH on the server.
 * Must stay byte-identical to: panel gate (PineappleFX/dist/index.html),
 * tools/mint_key.py, server/worker.js, site/index.html fallback.
 * Scheme: FNV-1a signature over SECRET:serial:DEVICE (+ reverse), Crockford
 * base32 ALPHA, format PFX2-XXXXXXXX-XXXXXXXX (20 alnum chars normalized).
 */
import crypto from "node:crypto";

export const ALPHA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const KEY_RE = /^[A-Za-z0-9]{8}$/; // machine id shape

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function sigFor(secret, serial, device) {
  const h1 = fnv1a(`${secret}:${serial}:${device}`);
  const h2 = fnv1a(`${device}:${serial}:${secret}`);
  let s = "";
  for (let i = 0; i < 6; i++) s += ALPHA[(h1 >>> (27 - i * 5)) & 31];
  for (let j = 0; j < 2; j++) s += ALPHA[(h2 >>> (27 - j * 5)) & 31];
  return s;
}

export function normalizeMachineId(raw) {
  return String(raw || "").trim().toUpperCase();
}

export function normalizeKey(raw) {
  return String(raw || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/** Random-serial mint (server). Serial randomness never affects validity. */
export function mintLicense(machineId, secret) {
  const device = normalizeMachineId(machineId);
  const rand = crypto.randomBytes(8);
  let serial = "";
  for (let i = 0; i < 8; i++) serial += ALPHA[rand[i] & 31];
  return `PFX2-${serial}-${sigFor(String(secret), serial, device)}`;
}

/** Offline-equivalent signature check (what the panel gate computes). */
export function verifySignature(key, machineId, secret) {
  const k = normalizeKey(key);
  const device = normalizeMachineId(machineId);
  if (k.length !== 20 || !k.startsWith("PFX2") || !KEY_RE.test(device)) return false;
  return k.slice(12, 20) === sigFor(String(secret), k.slice(4, 12), device);
}
