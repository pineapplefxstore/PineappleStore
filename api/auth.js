/**
 * /api/auth — persistent accounts (DB-backed, replaces browser-only auth).
 *   POST { action:"signup", email, password } → { ok, token, email, is_admin }
 *   POST { action:"login", email, password }  → { ok, token, email, is_admin }
 *   GET  /api/auth (or action:"me", Bearer)   → { ok, email, is_admin }
 * Session: JWT (7d) via response body + HttpOnly `pfx_session` cookie.
 * First-ever account with the ADMIN_EMAIL env becomes admin (bootstrap);
 * afterwards is_admin is granted only through the admin panel / seed script.
 */
import { db } from "./_lib/db.js";
import {
  cors,
  hashPassword,
  json,
  readBody,
  setSessionCookie,
  signJWT,
  verifyJWT,
  verifyPassword,
  bearerToken,
} from "./_lib/auth.js";

const SESSION_TTL = 7 * 24 * 3600;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    cors(res);
    return res.status(204).end();
  }
  const isGetMe = req.method === "GET";
  const body = isGetMe ? {} : readBody(req);
  const action = isGetMe ? "me" : String(body.action || "me");
  const users = db.all("users");

  if (action === "me") {
    const p = verifyJWT(bearerToken(req));
    if (!p?.email || !users[p.email.toLowerCase()])
      return json(res, 401, { ok: false, error: "unauthorized" });
    const u = users[p.email.toLowerCase()];
    return json(res, 200, { ok: true, email: u.email, is_admin: !!u.is_admin, disabled: !!u.disabled });
  }

  if (req.method !== "POST") return json(res, 405, { ok: false, error: "method-not-allowed" });

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!EMAIL_RE.test(email)) return json(res, 400, { ok: false, error: "bad-email" });
  if (password.length < 4) return json(res, 400, { ok: false, error: "bad-password" });

  const adminEmail = String(process.env.ADMIN_EMAIL || "pineapplefx.store@gmail.com").toLowerCase();

  if (action === "signup") {
    if (users[email]) {
      if (users[email].disabled) {
        db.audit(email, "signup-blocked-disabled", "");
        return json(res, 403, { ok: false, error: "account-disabled" });
      }
      return json(res, 409, { ok: false, error: "exists" });
    }
    const bootstrapAdmin = email === adminEmail && !Object.values(users).some((u) => u.is_admin);
    users[email] = {
      email,
      ...parseHash(hashPassword(password)),
      is_admin: bootstrapAdmin,
      created: new Date().toISOString(),
    };
    db.set("users", email, users[email]);
    db.audit(email, "signup", bootstrapAdmin ? "bootstrap-admin" : "");
    return issue(res, users[email]);
  }

  if (action === "login") {
    const u = users[email];
    if (!u || !verifyPassword(password, `${u.alg}$${u.salt}$${u.hash}`))
      return json(res, 401, { ok: false, error: "bad-credentials" });
    if (u.disabled) {
      db.audit(email, "login-blocked-disabled", "");
      return json(res, 403, { ok: false, error: "account-disabled" });
    }
    db.audit(email, "login", "");
    return issue(res, u);
  }

  return json(res, 400, { ok: false, error: "bad-action" });
}

function parseHash(stored) {
  // stored: scrypt$n=..,r=..,p=..,keylen=..$salt$hash → splittable record
  const [alg, params, salt, hash] = String(stored).split("$");
  return { alg: `${alg}$${params}`, salt, hash };
}

function issue(res, user) {
  let token;
  try {
    token = signJWT({ email: user.email, admin: !!user.is_admin, typ: "session" }, SESSION_TTL);
  } catch {
    return json(res, 500, { ok: false, error: "server-misconfigured" });
  }
  setSessionCookie(res, token, SESSION_TTL);
  return json(res, 200, { ok: true, token, email: user.email, is_admin: !!user.is_admin });
}
