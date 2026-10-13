/**
 * PineappleFX server auth: scrypt passwords + HS256 JWT sessions + RBAC.
 * - Password format: scrypt$n=16384,r=8,p=1,keylen=32$salthex$hashhex
 *   (matches tools/seed_admin.py so admins can be seeded offline).
 * - Tokens: standard 3-part JWT, HMAC-SHA256 over TOKEN_SECRET.
 *   Accepted via `Authorization: Bearer` or `pfx_session` HttpOnly cookie.
 */
import crypto from "node:crypto";

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, keylen: 32 };

export function tokenSecret() {
  return process.env.TOKEN_SECRET || process.env.MINT_SECRET || "";
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .scryptSync(String(password), Buffer.from(salt, "hex"), SCRYPT_OPTS.keylen, {
      N: SCRYPT_OPTS.N,
      r: SCRYPT_OPTS.r,
      p: SCRYPT_OPTS.p,
    })
    .toString("hex");
  return `scrypt$n=${SCRYPT_OPTS.N},r=${SCRYPT_OPTS.r},p=${SCRYPT_OPTS.p},keylen=${SCRYPT_OPTS.keylen}$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  try {
    const parts = String(stored || "").split("$");
    if (parts.length !== 4 || parts[0] !== "scrypt") return false;
    const params = Object.fromEntries(parts[1].split(",").map((kv) => kv.split("=")));
    const N = parseInt(params.n, 10),
      r = parseInt(params.r, 10),
      p = parseInt(params.p, 10),
      keylen = parseInt(params.keylen, 10) || 32;
    if (!N || !r || !p) return false;
    const want = Buffer.from(parts[3], "hex");
    const got = crypto.scryptSync(String(password), Buffer.from(parts[2], "hex"), want.length || keylen, { N, r, p });
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj) {
  return b64url(JSON.stringify(obj));
}

export function signJWT(payload, ttlSeconds) {
  const secret = tokenSecret();
  if (!secret) throw new Error("server-misconfigured");
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, exp: now + ttlSeconds, ...payload };
  const unsigned = `${b64urlJson({ alg: "HS256", typ: "JWT" })}.${b64urlJson(body)}`;
  const sig = b64url(crypto.createHmac("sha256", secret).update(unsigned).digest());
  return `${unsigned}.${sig}`;
}

export function verifyJWT(token) {
  try {
    const secret = tokenSecret();
    if (!secret || !token) return null;
    const parts = String(token).split(".");
    if (parts.length !== 3) return null;
    const [h, b, s] = parts;
    const expect = b64url(crypto.createHmac("sha256", secret).update(`${h}.${b}`).digest());
    const a = Buffer.from(s),
      e = Buffer.from(expect);
    if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) return null;
    const payload = JSON.parse(Buffer.from(b.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000) - 60) return null; // 60s skew
    return payload;
  } catch {
    return null;
  }
}

export function bearerToken(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  const cookie = req.headers?.cookie || "";
  const m = cookie.match(/(?:^|;\s*)pfx_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

/* ---- HTTP helpers shared by all endpoints ---- */

/* Closed-by-default CORS: only our own shop origins get ACAO.
   Override/extend with ALLOWED_ORIGINS="https://a.example,https://b.example".
   *.vercel.app previews + localhost are allowed for development. */
const DEFAULT_ORIGINS = [
  "https://www.pineapplestore.us.ci",
  "https://pineapplestore.us.ci",
  "https://pineapplefxstore.github.io",
];
const DEV_SUFFIXES = [".vercel.app"];

function allowedOrigins() {
  const extra = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return [...new Set([...DEFAULT_ORIGINS, ...extra])];
}

function originAllowed(origin) {
  if (!origin) return false;
  const o = String(origin).replace(/\/$/, "");
  if (allowedOrigins().includes(o)) return true;
  try {
    const u = new URL(o);
    if (DEV_SUFFIXES.some((s) => u.hostname.endsWith(s))) return true;
    if ((u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
        (u.protocol === "http:" || u.protocol === "https:")) return true;
  } catch { return false; }
  return false;
}

export function cors(req, res) {
  const origin = req?.headers?.origin || req?.headers?.Origin || "";
  if (origin && originAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", String(origin).replace(/\/$/, ""));
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export function json(res, status, obj, extraHeaders) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (extraHeaders) for (const k of Object.keys(extraHeaders)) res.setHeader(k, extraHeaders[k]);
  return res.status(status).json(obj);
}

/* In-memory per-instance rate limiter (serverless-safe best effort:
   each instance tracks its own callers; still stops casual brute force). */
const __hits = new Map(); // key -> [timestamps]
function prune(key, windowMs) {
  const now = Date.now();
  const arr = (__hits.get(key) || []).filter((t) => now - t < windowMs);
  __hits.set(key, arr);
  return arr;
}

export function rateLimit(key, max, windowMs) {
  const arr = prune(key, windowMs);
  if (arr.length >= max) {
    const retryAfter = Math.max(1, Math.ceil((arr[0] + windowMs - Date.now()) / 1000));
    return { ok: false, retryAfter };
  }
  arr.push(Date.now());
  __hits.set(key, arr);
  return { ok: true, retryAfter: 0 };
}

export function clientIp(req) {
  const fwd = req?.headers?.["x-forwarded-for"] || req?.headers?.["X-Forwarded-For"] || "";
  const ip = String(fwd).split(",")[0].trim() || req?.socket?.remoteAddress || "unknown";
  return ip.slice(0, 64);
}

const MAX_BODY_BYTES = 64 * 1024;

export function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body || "{}");
    } catch {
      return {};
    }
  }
  if (req.query && typeof req.query === "object") return req.query;
  return {};
}

export function setSessionCookie(res, token, ttlSeconds) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `pfx_session=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${ttlSeconds}; SameSite=Lax${secure}`
  );
}

/** True when a user record exists and is deactivated. Missing record → false. */
export function isAccountDisabled(usersTable, email) {
  const u = usersTable?.[String(email || "").trim().toLowerCase()];
  return !!(u && u.disabled);
}

/** Returns { email, is_admin } or sends 401/403 and returns null. */
export function requireAdmin(req, res, usersTable) {
  const payload = verifyJWT(bearerToken(req));
  if (!payload || !payload.email) {
    json(res, 401, { ok: false, error: "unauthorized" });
    return null;
  }
  const user = usersTable[payload.email.toLowerCase()];
  if (!user || !user.is_admin) {
    json(res, 403, { ok: false, error: "forbidden" });
    return null;
  }
  return { email: payload.email.toLowerCase(), is_admin: true };
}
