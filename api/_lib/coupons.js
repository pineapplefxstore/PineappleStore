/**
 * Coupon helpers shared by the API.
 *
 * Percent-off codes are SELF-VERIFYING: the browser appends an 8-char
 * signature (see assets/pfx-core.js → cpnSig) so a code works on any device
 * with no server lookup. The API mirrors that algorithm so it can price an
 * order correctly without trusting a client-supplied `amount`.
 *
 * SECURITY: only PERCENT codes are accepted from a signature. A free code
 * (one that skips payment) must exist in the server's coupon table — a
 * client-forgeable free code would be a licensing bypass.
 */

const CPN_ALPHA = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CPN_SECRET = "pfxc-9f3a7d1e6b2048c5aa71d9e3";

export function cpnSig(base, kind, pct) {
  const s = `pfxc1|${CPN_SECRET}|${kind}|${String(base).toUpperCase()}|${pct}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  let out = "";
  for (let j = 0; j < 4; j++) out += CPN_ALPHA.charAt((h1 >>> (j * 5)) % CPN_ALPHA.length);
  for (let k = 0; k < 4; k++) out += CPN_ALPHA.charAt((h2 >>> (k * 5)) % CPN_ALPHA.length);
  return out;
}

/** Returns the discount percentage, or null when the code isn't a valid signed percent code. */
export function parseSignedPercent(raw) {
  const code = String(raw || "").trim().toUpperCase();
  const m = /^(.*)-([A-Z0-9]{8})$/.exec(code);
  if (!m) return null;
  const base = m[1];
  const sig = m[2];
  if (base.length < 2 || base.length > 40) return null;
  for (let p = 1; p <= 99; p++) {
    if (cpnSig(base, "percent", p) === sig) return p;
  }
  return null;
}

/**
 * Current base price from the pricing table (launch price while active).
 * Mirrors basePrice() in assets/pfx-core.js.
 */
export function basePrice(pricing) {
  const p = pricing || {};
  const regular = Number(p.regular);
  const launch = Number(p.launch);
  const end = Date.parse(p.launchEnd || "");
  const now = Date.now();
  if (Number.isFinite(launch) && !Number.isNaN(end) && now < end) return launch;
  if (Number.isFinite(regular)) return regular;
  return 30;
}

/**
 * Price a license for a coupon kind: "free" | "half" | "percent:N" | "" .
 * Returns a number with 2 decimals.
 */
export function priceForCoupon(kind, pricing) {
  if (kind === "free") return 0;
  const base = basePrice(pricing);
  let pct = 0;
  if (kind === "half") pct = 50;
  else {
    const m = /^percent:(\d{1,2})$/.exec(String(kind || ""));
    if (m) pct = Math.min(99, Math.max(1, Number(m[1])));
  }
  return Math.round(base * (1 - pct / 100) * 100) / 100;
}
