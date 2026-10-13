/**
 * PineappleFX file-backed database (default adapter).
 *
 * Tables: users, licenses, machines, coupons, partners, slots, pricing, audit.
 * - DATA_DIR env selects the storage dir (default ./data next to the repo).
 * - On read-only/ephemeral serverless FS, falls back to in-memory + warns.
 * - SWAP POINT: replace loadTable/saveTable with Postgres/Supabase calls;
 *   every endpoint below only uses getAll/get/set/remove/audit, so the
 *   migration is one file.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function resolveDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  const siteDir = path.join(process.cwd(), "site", "data");
  const localDir = path.join(process.cwd(), "data");
  if (fs.existsSync(path.join(siteDir, "pfx-db.json"))) return siteDir;
  if (fs.existsSync(path.join(localDir, "pfx-db.json"))) return localDir;
  if (fs.existsSync(path.join(process.cwd(), "site"))) return siteDir;
  return localDir;
}

const DIR = resolveDir();
const FILE = path.join(DIR, "pfx-db.json");

let memoryFallback = false;
let cache = null;

const DEFAULTS = () => ({
  users: {}, // email -> { email, salt, hash, is_admin, created }
  licenses: {}, // normKey -> { key, email, machine, created, revoked, revokedAt, source }
  machines: {}, // machine -> { machine, email, key, firstSeen, lastSeen }
  coupons: {}, // CODE -> { kind, pct, note, maxUses, uses, created }
  partners: {}, // id -> { id, name, email, code, created, by } — affiliate program: who you sponsor + which code they share
  slots: {}, // emailLower -> { claimed, orderID, machine, key, amount, at } — one-time $7.90 extra-machine deal
  pricing: { regular: "30.00", launch: "20.00", launchEnd: "2026-11-01T00:00:00Z" },
  audit: [], // { at, actor, action, detail } — capped
});

function load() {
  if (cache) return cache;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (fs.existsSync(FILE)) {
      cache = { ...DEFAULTS(), ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
      return cache;
    }
    cache = DEFAULTS();
    fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
    return cache;
  } catch (err) {
    if (!memoryFallback) {
      memoryFallback = true;
      console.warn("[pfx-db] filesystem unavailable, using ephemeral memory:", err?.message);
    }
    if (!cache) cache = DEFAULTS();
    return cache;
  }
}

function persist() {
  if (memoryFallback) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const content = JSON.stringify(cache, null, 2);
    fs.writeFileSync(FILE, content, "utf8");
    const altDir = DIR.endsWith(path.join("site", "data"))
      ? path.join(DIR, "..", "..", "data")
      : path.join(DIR, "..", "site", "data");
    try {
      if (fs.existsSync(path.dirname(altDir))) {
        fs.mkdirSync(altDir, { recursive: true });
        fs.writeFileSync(path.join(altDir, "pfx-db.json"), content, "utf8");
      }
    } catch (_) {}
  } catch (err) {
    memoryFallback = true;
    console.warn("[pfx-db] persist failed, ephemeral memory:", err?.message);
  }
}

export const db = {
  get ephemeral() {
    load();
    return memoryFallback;
  },
  all(table) {
    return load()[table];
  },
  get(table, key) {
    return load()[table]?.[key] ?? null;
  },
  set(table, key, value) {
    load()[table][key] = value;
    persist();
  },
  remove(table, key) {
    delete load()[table][key];
    persist();
  },
  audit(actor, action, detail) {
    const d = load();
    d.audit.unshift({ at: new Date().toISOString(), actor, action, detail: detail || "" });
    if (d.audit.length > 500) d.audit.length = 500;
    persist();
  },
  uid() {
    try {
      return crypto.randomUUID();
    } catch {
      return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
    }
  },
};
