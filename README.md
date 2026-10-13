# PineappleFX website — free hosting via GitHub Pages (root layout)

Custom domain: `www.pineapplestore.us.ci` (see `CNAME` at the repo root).
The static site lives at the REPO ROOT — `index.html`, `store.html`,
`admin.html`, `dashboard.html`, `assets/`, `downloads/` — so Pages serves it
with no 404. `api/` at root is inert on Pages; point the site at an outside
backend with `window.PFX_API_BASE` if needed.

## Before publishing (3 minutes)

1. **PayPal:** checkout runs on PayPal Smart Buttons with your Client ID
   (already embedded in `index.html`). The matching **Client Secret stays
   OFF the repo** — anyone holding it can act on your PayPal account, so it only
   ever belongs in a private server env (see `server/`). If a secret is ever
   pasted somewhere public, rotate it in the PayPal Developer dashboard.
2. **Order form:** order form is already pointed at sxiiscan@gmail.com - change it there if your inbox ever changes:
   `https://formsubmit.co/sxiiscan@gmail.com` → `https://formsubmit.co/you@mail.com`
   (one line in `index.html`, flagged `REPLACE-ME`). First submission needs
   one confirmation click from that inbox (FormSubmit anti-spam), then it just works.
3. NEVER put any .zxp in `downloads/` public folder beyond the demo build - the personal installer only goes out by email to paying buyers.

## Publish (all free)

1. Create a free GitHub account (if needed) and a **public** repository,
   e.g. `pineapplefx`. The repo root already contains
   `index.html`, `assets/logo.png` and `downloads/PineappleFX.zxp` — push it as-is.
2. On GitHub: repo **Settings → Pages → Build and deployment → Deploy from a branch**,
   select branch `main`, folder `/ (root)`, Save.
3. After ~1 minute your site is live at
   `https://YOUR-USERNAME.github.io/pineapplefx/`

## Selling flow (no server, only PayPal's cut)

1. Buyer pays $15 via the PayPal button and fills the order form
   (email + Machine ID from the locked panel + PayPal transaction ID).
   You get it as an email via FormSubmit.
2. Verify the payment in PayPal activity, then mint (private, never share `tools/`):
   `python tools/mint_key.py --device <MACHINEID> --email buyer@mail`
3. Optionally build their personal installer (auto-activates on their machine,
   watermarked with their email so leaks trace back):
   `python tools/build_buyer.py --email buyer@mail --key <KEY> --device <MACHINEID>`
4. Email the buyer the `PFX2-…` key (+ their .zxp). Done. Keys work offline, forever,
   on that one machine.

## Coupons (site-side only, on purpose)

- `PINFX-#UB-)5>}` → 50% off: PayPal buttons switch to $7.50, coupon is recorded
  in the order form so you can verify it against the payment.
- `OWNPFX-UKVL&{4B` → free: PayPal step is skipped, buyer just sends the form,
  you mint a free key as usual.
- These codes live ONLY in the website JS (coupons = price logic). They are NOT
  unlock codes in the panel: anything hardcoded in the shipped .zxp is readable
  by anyone who unzips it, which would give the discount/freebie to everybody
  with no purchase at all. Owner installs stay free via `tools/mint_key.py`.
- Note: the site repo is public, so assume both codes are visible to buyers.
  That is fine — redemption still goes through your manual mint step, so a
  posted code can't conjure a working key by itself.

## Files (multi-page site)

- `index.html` — homepage: hero, features, live panel preview, CTA
- `store.html` — pricing, PayPal checkout, coupons, license generator
- `dashboard.html` — My Keys: keys, computers, $7.90 extra-computer deal
- `install.html` — install guide + help notes
- `faq.html` — Help + answers
- `admin.html` — admin panel (owner login only) + Partner program
- `assets/site.css` — shared theme + components
- `assets/premium.css` — premium layer (type, nav, footer, bands)
- `assets/pfx-core.js` — theme, pricing, accounts, keys, coupons, PayPal
- `assets/pfx-preview.js` — homepage live demo (index only)
- `assets/pfx-licensing.js` — checkout → key box, claims, extra-computer deal (store + dashboard)
- `assets/pfx-admin.js` — admin panel logic (owner only)
- `assets/pfx-affiliates.js` — partner program: add people you sponsor, track code uses
- All pages share localStorage state, so accounts, coupons, and keys carry over.
- `success.html` — post-payment page (order summary + key display). It lives
  alongside `index.html`. After capture, buyers land here automatically.
- `assets/logo.png` — pineapple mark (copied from the extension)
- `server/` — optional full-automation scaffold (Cloudflare Worker + PayPal webhooks
  + email). Only needed if you later want instant, hands-free delivery. If you
  deploy it: paste the worker URL into `WORKER_URL` in `success.html` and the
  page will show each buyer their fresh key on the spot (still emailed too).

## Backend API (server-validated licensing + production admin)

`api/` is a Vercel/Netlify-style serverless backend (Node, zero deps):

- `POST /api/generate-license` — mint + email keys (records every issue in DB)
- `POST /api/verify-license` — `{machine_id, license_key}` → signed JWT
  session token; honors revocation (panel handshake target)
- `/api/auth` — signup/login/me (scrypt + JWT cookie/Bearer)
- `POST /api/admin` — owner-only: overview, people, keys
  (make/take-away/reset), discount codes, partners, prices, history log
- `GET /api/pricing` — public pricing; the site auto-applies it when reachable

Required env (never commit): `MINT_SECRET` (= panel SECRET),
`TOKEN_SECRET` (session/token signing), `ADMIN_EMAIL`, `MAIL_FROM`,
`RESEND_API_KEY` / `SENDGRID_API_KEY`, `DOWNLOAD_URL`.
Optional: `DATA_DIR` (default `data`), `LICENSE_TOKEN_TTL`,
`COUPON_ALLOWLIST` (extra codes if you bypass the DB).

Bootstrap:

    py tools/seed_admin.py pineapplefx.store@gmail.com <StrongPassword>
    npx vercel dev   # serves the site + api together (project pineapple-store)

The DB is a JSON file (`DATA_DIR/pfx-db.json`: users, licenses, machines,
coupons, partners, pricing, history) — fine for VPS/single-node; swap `api/_lib/db.js`
for Postgres/Supabase when you outgrow it (endpoints only use get/set).

Panel enforcement: `PFX_VERIFY_URL=https://your-api/api/verify-license \
py tools/build_license.py && py tools/protect_gate.py`
(empty URL = current offline legacy behavior; sealed panels get identifier
mangling + a self-test tripwire; revoked keys lock on next online check).
