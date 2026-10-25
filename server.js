#!/usr/bin/env node
/**
 * PineappleFX backend + storefront, in one zero-dependency Node process.
 *
 *   node server.js            → http://localhost:8787
 *   PORT=8080 node server.js  → custom port
 *
 * Why this exists
 * ---------------
 * The `api/*.js` files are written in the Vercel/Netlify function style
 * (`export default (req, res)`) and they persist state to a JSON file
 * (api/_lib/db.js). Serverless platforms give you an ephemeral filesystem, so
 * a deployed license store there loses every key on cold start. This server
 * runs the exact same handlers against a real disk, so licenses, coupons and
 * the PayPal replay guard survive restarts and deploys.
 *
 * What it does
 * ------------
 *   /api/<name>  →  api/<name>.js   (same contract as Vercel)
 *   everything else → static files from the repo root (index.html, store.html…)
 *
 * It also reads a `.env` file from the repo root so `node server.js` needs no
 * flags. Real environment variables always win over `.env`.
 *
 * Security notes
 * --------------
 *   - api/, data/, tools/, server/, build/, node_modules/ and dotfiles are
 *     never served. `data/pfx-db.json` holds password hashes and every license
 *     key; `tools/` holds MINT_SECRET. Serving either would be fatal.
 *   - Requests are path-normalised and confined to the repo root, so `..%2f`
 *     traversal cannot escape.
 *   - JSON bodies are capped at 1 MB; endpoint-level validation still applies.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.join(ROOT, "api");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";

/* Directories that must never be reachable over HTTP. */
const DENY_DIRS = new Set([
  "api", "data", "tools", "server", "build", "node_modules",
  "site", // only present in the Vercel layout; never public
]);
/* Root-level files that leak internals or are irrelevant to visitors. */
const DENY_FILES = new Set([
  "package.json",
  "package-lock.json",
  "vercel.json",
  "server.js", // backend source lives here
  ".env",
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".zxp": "application/octet-stream",
  ".exe": "application/octet-stream",
  ".wasm": "application/wasm",
};

/* ---------------------------------------------------------------- .env ---- */

/** Minimal .env reader. Existing process.env values always win. */
function loadEnvFile() {
  const file = path.join(ROOT, ".env");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return; // no .env — fine, rely on the real environment
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = t.slice(eq + 1).trim();
    if (val.length >= 2 && (val[0] === '"' || val[0] === "'") && val[val.length - 1] === val[0]) {
      val = val.slice(1, -1);
    } else {
      val = val.replace(/\s+#.*$/, ""); // strip trailing comment
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile();

/* ------------------------------------------------------------- handlers ---- */

/** name → { mtimeMs, mod } */
const handlerCache = new Map();

/** Re-imports a handler when its file changes, so `node server.js` doubles as a dev server. */
async function loadHandler(name) {
  if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(name)) return null;
  const file = path.join(API_DIR, `${name}.js`);
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const hit = handlerCache.get(name);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.mod;

  const mod = await import(pathToFileURL(file).href + `?v=${stat.mtimeMs}`);
  handlerCache.set(name, { mtimeMs: stat.mtimeMs, mod });
  return mod;
}

/* --------------------------------------------------------------- helpers --- */

function queryObject(searchParams) {
  const out = {};
  for (const [k, v] of searchParams) out[k] = v;
  return out;
}

const MAX_JSON_BYTES = 1024 * 1024;

function readRequestBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_JSON_BYTES) {
        aborted = true;
        chunks.length = 0;
        resolve({ tooLarge: true });
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (aborted) return;
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({ body: {} });
      const type = String(req.headers["content-type"] || "");
      if (type.includes("application/x-www-form-urlencoded")) {
        const params = new URLSearchParams(text);
        return resolve({ body: queryObject(params) });
      }
      try {
        const parsed = JSON.parse(text);
        resolve({ body: parsed && typeof parsed === "object" ? parsed : {} });
      } catch {
        resolve({ body: {}, malformed: true });
      }
    });
    req.on("error", () => resolve({ body: {} }));
  });
}

/** Vercel/Netlify-style helpers the endpoints expect: res.status(n).json(x) / .end(). */
function decorate(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    if (res.writableEnded) return res;
    const payload = Buffer.from(JSON.stringify(obj), "utf8");
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", payload.length);
    res.end(payload);
    return res;
  };
  res.send = (body) => {
    if (res.writableEnded) return res;
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
    res.setHeader("Content-Length", payload.length);
    res.end(payload);
    return res;
  };
  return res;
}

/* ------------------------------------------------------------------ API ---- */

async function handleApi(req, res, url) {
  const name = url.pathname.slice("/api/".length).replace(/\/+$/, "");
  const mod = await loadHandler(name);
  if (!mod || typeof mod.default !== "function") {
    return res.status(404).json({ ok: false, error: "not-found" });
  }

  req.query = queryObject(url.searchParams);
  const parsed = await readRequestBody(req);
  if (parsed.tooLarge) {
    return res.status(413).json({ ok: false, error: "body-too-large" });
  }
  req.body = parsed.body;

  try {
    await mod.default(req, res);
    if (!res.writableEnded) {
      // A handler returned without responding: never leave the socket hanging.
      res.status(204).end();
    }
  } catch (err) {
    console.error(`[api/${name}]`, err);
    if (!res.writableEnded) {
      res.status(500).json({ ok: false, error: "server-error" });
    }
  }
}

/* --------------------------------------------------------------- static ---- */

/** Resolve a URL pathname to a real file inside ROOT, or null. */
function resolveStatic(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  if (rel.includes("\0")) return null;

  const segments = rel.split(/[/\\]+/).filter(Boolean);
  if (segments.length === 0) segments.push("index.html");

  for (const seg of segments) {
    if (seg === "." || seg === "..") return null;
    const isDot = seg.startsWith(".");
    if (isDot && seg !== ".well-known") return null; // no dotfiles
  }
  const first = segments[0];
  if (DENY_DIRS.has(first)) return null;
  if (segments.length === 1 && DENY_FILES.has(segments[0])) return null;

  const base = path.resolve(ROOT, segments.join(path.sep));
  if (base !== ROOT && !base.startsWith(ROOT + path.sep)) return null;
  return base;
}

function statFile(p) {
  try {
    const s = fs.statSync(p);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

/** Clean-URL behaviour: /store → store.html, /docs → docs/index.html. */
function findStaticFile(pathname) {
  const base = resolveStatic(pathname);
  if (!base) return null;

  for (const candidate of [base, `${base}.html`, path.join(base, "index.html")]) {
    const s = statFile(candidate);
    if (s) return { file: candidate, stat: s };
  }
  return null;
}

function sendFile(req, res, file, stat) {
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;

  res.setHeader("Content-Type", type);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("ETag", etag);
  res.setHeader(
    "Cache-Control",
    ext === ".html" || ext === ".json" ? "no-cache" : "public, max-age=3600"
  );

  if (req.headers["if-none-match"] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }

  res.setHeader("Content-Length", stat.size);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file);
  stream.on("error", (err) => {
    console.error("[static]", err);
    if (!res.writableEnded) res.destroy();
  });
  stream.pipe(res);
}

function send404(req, res) {
  const custom = path.join(ROOT, "404.html");
  const s = statFile(custom);
  if (s) {
    res.statusCode = 404;
    return sendFile(req, res, custom, s);
  }
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("404 Not Found");
}

/* --------------------------------------------------------------- server ---- */

const server = http.createServer(async (req, res) => {
  decorate(res);

  let url;
  try {
    url = new URL(req.url || "/", "http://localhost");
  } catch {
    return res.status(400).json({ ok: false, error: "bad-url" });
  }

  const started = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - started;
    if (ms > 1500) {
      console.warn(`${req.method} ${url.pathname} → ${res.statusCode} (${ms}ms, slow)`);
    }
  });

  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    return handleApi(req, res, url);
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ ok: false, error: "method-not-allowed" });
  }

  const found = findStaticFile(url.pathname);
  if (!found) return send404(req, res);
  return sendFile(req, res, found.file, found.stat);
});

server.listen(PORT, HOST, () => {
  const where = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`PineappleFX running → http://${where}:${PORT}`);
  if (process.env.PFX_ALLOW_UNVERIFIED === "1") {
    console.warn("⚠  PFX_ALLOW_UNVERIFIED=1 — PayPal orders are NOT verified. Local dev only.");
  }
  if (!process.env.MINT_SECRET) {
    console.warn("⚠  MINT_SECRET is not set — license minting will return server-misconfigured.");
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\n${sig} received — shutting down.`);
    server.close(() => process.exit(0));
    // Don't hang forever on keep-alive sockets.
    setTimeout(() => process.exit(0), 4000).unref();
  });
}
