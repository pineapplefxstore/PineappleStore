# PineappleFX 2.0.0 — Release (staged, ready for public release)

Built: 2026-10-12 · Bundle: `com.pineapplestore.pineapplefx` · AE 22.0–2026+ · by Pineapple Store

## Staged files

| File | Size | SHA-256 |
|---|---|---|
| `site/downloads/PineappleFX.zxp` | 0.28 MB | `49F90575530BF460280081A6BD69E737F0D562618BAB04EBACEDB305AE1615EB` |
| `site/downloads/PineappleFX-Installer.exe` | 10.8 MB | `F7BD2343EC37C54218C0FDFCA811CB9871AF3A56013324444D24E003BAB1381E` |
| Mirror: `C:\Users\quiff\Desktop\PineappleFX\release\` (same two files) | | |

Verify: `python tools/ci_check.py` (checks zip validity, sealed gate, manifest id).

## What went into this build

- `py tools/build_license.py` — fresh device-bound gate (FNV-1a, offline legacy mode;
  set `PFX_VERIFY_URL=https://<api-host>/api/verify-license` before building to
  bake in server enforcement + revocation-on-next-check).
- `py tools/protect_gate.py` — 32 identifiers mangled, SECRET split, self-test
  tripwire injected (`var PREKEY = "";` hook intentionally preserved for
  personalized/buyer installs).
- `py tools/package_zxp.py` — zipped + staged (unsigned: needs PlayerDebugMode
  or ZXPSignCmd signature — see install.html).
- `py tools/build_exe.py` — PyInstaller onefile bundle of `tools/installer.py`
  (tkinter GUI + `--cli`, anti-debug/VM checks, hardware fingerprint receipt,
  online verify with offline FNV fallback, PREKEY pre-activation).

## Buyer flow

1. Pay on the site → `PFX2-…` key appears instantly (or by email).
2. Manual: install the `.zxp` with an extension manager, paste the key.
3. Automated: run the `.exe`, enter the key + the Machine ID from the locked
   panel → installs, enables debug mode, and pre-activates (no pasting).

## Deploying the site

Push to `main` → GitHub Actions runs `tools/ci_check.py` + backend smoke tests,
then publishes `site/` to GitHub Pages (`PineappleStore` repo). The `/api/*`
functions ship inertly on Pages — point `window.PFX_API_BASE` at a live backend
(Vercel project root = `site/`) to enable server features.
