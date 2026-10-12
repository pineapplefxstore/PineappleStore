/**
 * OPTIONAL full-automation scaffold (all free tiers, ~30 min setup).
 * What it does: PayPal pays → PayPal pings this Worker → Worker mints a
 * device-bound PFX2 key, emails key+zxp to the buyer via Resend. Zero hands.
 *
 * You need (all free):
 *  1. PayPal Business account + a REST app (Client ID + Secret) with a
 *     webhook for CHECKOUT.ORDER.APPROVED pointing at this worker.
 *  2. Cloudflare account + `wrangler` (free Workers plan).
 *  3. Resend account (free 100 mails/day) + verified sender + API key.
 * Secrets (never in code): set with `wrangler secret put NAME`:
 *  PAYPAL_CLIENT_ID, PAYPAL_SECRET, RESEND_API_KEY, MINT_SECRET (same hex as tools/),
 *  MAIL_FROM (e.g. "PineappleFX <keys@yourdomain>").
 *
 * Buyer flow with this worker: site collects email + Machine ID FIRST
 * (query params), PayPal Smart Button captures, browser POSTs
 * {orderID, email, device} here; worker verifies the capture with PayPal,
 * mints, emails, and returns {ok:true,key} so success.html shows the key
 * instantly. The static PayPal.Me flow stays as fallback.
 */
// ENV = { PAYPAL_CLIENT_ID, PAYPAL_SECRET, RESEND_API_KEY, MINT_SECRET, MAIL_FROM }
const ALPHA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function sigFor(secret, serial, device) {
  const h1 = fnv(secret + ":" + serial + ":" + device);
  const h2 = fnv(device + ":" + serial + ":" + secret);
  let s = "";
  for (let i = 0; i < 6; i++) s += ALPHA[(h1 >>> (27 - i * 5)) & 31];
  for (let j = 0; j < 2; j++) s += ALPHA[(h2 >>> (27 - j * 5)) & 31];
  return s;
}
function mint(secret, device) {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let serial = "";
  for (const b of bytes) serial += ALPHA[b & 31];
  return "PFX2-" + serial + "-" + sigFor(secret, serial, device);
}
async function paypalToken(env) {
  const r = await fetch("https://api-m.paypal.com/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + btoa(env.PAYPAL_CLIENT_ID + ":" + env.PAYPAL_SECRET),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  return (await r.json()).access_token;
}
export default {
  async fetch(req, env) {
    if (req.method !== "POST") return new Response("ok");
    let body = {};
    try { body = await req.json(); } catch { return Response.json({ ok: false }, { status: 400 }); }
    const { orderID, email, device } = body;
    if (!orderID || !email || !/^[A-Za-z0-9]{8}$/.test(device || ""))
      return Response.json({ ok: false, error: "bad-request" }, { status: 400 });
    const token = await paypalToken(env);
    const order = await (await fetch("https://api-m.paypal.com/v2/checkout/orders/" + orderID, {
      headers: { "Authorization": "Bearer " + token },
    })).json();
    const paid = order.status === "COMPLETED" || order.status === "APPROVED";
    const amount = order?.purchase_units?.[0]?.amount;
    const okAmounts = ["15.00", "7.50"]; // full price + 50%-off coupon
    if (!paid || !okAmounts.includes(amount?.value) || amount?.currency_code !== "USD")
      return Response.json({ ok: false, error: "unpaid" }, { status: 402 });
    const key = mint(env.MINT_SECRET, device.toUpperCase());
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: email,
        subject: "Your PineappleFX license key",
        text: "Thanks for buying PineappleFX ($15)!\n\nYour license key (one machine):\n" + key +
          "\n\nYour Machine ID: " + device.toUpperCase() +
          "\n\nInstall: https://YOUR-USERNAME.github.io/pineapplefx/#install\nPaste the key into the panel to unlock. Keep this email — your key lives here.",
      }),
    });
    return Response.json({ ok: true, key }); // success.html displays it instantly AND emails it
  },
};
