"""Pineapple Store pre-deploy gate. Run:  python tools/ci_check.py
Also executed by .github/workflows/deploy.yml on every push/PR to main.

Fails (exit 1) on: missing pages/assets, absolute site paths, JS syntax
errors, broken gate/seal in dist or the staged .zxp, wrong manifest bundle
id, or an unconfigured production VERIFY_URL (warning only — set
PFX_VERIFY_URL env to silence when the API host is known).
"""
import pathlib
import re
import shutil
import subprocess
import sys
import zipfile

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except (AttributeError, OSError):
    pass

BASE = pathlib.Path(__file__).resolve().parent.parent
SITE = BASE / 'site'
ERRORS, WARNS = [], []


def err(msg):
    ERRORS.append(msg)
    print('FAIL ' + msg)


def warn(msg):
    WARNS.append(msg)
    print('WARN ' + msg)


def ok(msg):
    print('PASS ' + msg)


# ---- 1. required pages & assets -------------------------------------------
for rel in ('index.html', 'store.html', 'dashboard.html', 'install.html',
            'faq.html', 'admin.html', 'success.html',
            'assets/site.css', 'assets/premium.css', 'assets/logo.png',
            'assets/pfx-core.js', 'assets/pfx-preview.js',
            'assets/pfx-licensing.js', 'assets/pfx-admin.js'):
    (ok('page/asset present: ' + rel) if (SITE / rel).exists()
     else err('missing required file: site/' + rel))

# ---- 2. relative paths only (GitHub Pages serves a /<repo>/ subpath) ------
for page in ('index.html', 'store.html', 'dashboard.html', 'install.html',
             'faq.html', 'admin.html', 'success.html'):
    p = SITE / page
    if not p.exists():
        continue
    t = p.read_text(encoding='utf-8')
    bad = [m for m in re.findall(r'''(?:href|src)="(/(?!/)[^"]*)"''', t)]
    if bad:
        err('%s has root-absolute refs (break under /<repo>/): %s' % (page, bad[:3]))
    else:
        ok(page + ': all refs relative')

# ---- 3. JS syntax (node --check) ------------------------------------------
node = shutil.which('node')
js_files = sorted((SITE / 'api').rglob('*.js')) + sorted((SITE / 'assets').glob('pfx-*.js'))
if not node:
    warn('node not found — JS syntax check skipped')
else:
    bad = 0
    for f in js_files:
        r = subprocess.run([node, '--check', str(f)], capture_output=True, text=True)
        if r.returncode != 0:
            bad += 1
            err('JS syntax error in %s:\n%s' % (f.relative_to(BASE), r.stderr.strip()[:400]))
    if not bad:
        ok('JS syntax OK (%d files)' % len(js_files))

# ---- 4. python tools compile ----------------------------------------------
for f in sorted((BASE / 'tools').glob('*.py')):
    try:
        compile(f.read_text(encoding='utf-8'), str(f), 'exec')
    except SyntaxError as e:
        err('python syntax error in tools/%s: %s' % (f.name, e))
ok('tools/*.py compile check done')

# ---- 5. manifest: bundle id + AE range ------------------------------------
man = BASE / 'PineappleFX' / 'CSXS' / 'manifest.xml'
if not man.exists():
    err('missing PineappleFX/CSXS/manifest.xml')
else:
    t = man.read_text(encoding='utf-8')
    if 'ExtensionBundleId="com.pineapplestore.pineapplefx"' in t:
        ok('manifest bundle id = com.pineapplestore.pineapplefx')
    else:
        err('manifest ExtensionBundleId must be com.pineapplestore.pineapplefx')
    if 'com.pineapplestore.pineapplefx.panel' in t:
        ok('manifest extension id matches bundle')
    else:
        err('manifest Extension Id must be com.pineapplestore.pineapplefx.panel')
    m = re.search(r'Host Name="AEFT" Version="\[([^,]+),', t)
    if m and m.group(1).startswith('22.0'):
        ok('manifest targets AE 22.0+ (2022 → 2026+)')
    else:
        err('manifest AE host range wrong: %s' % (m.group(0) if m else 'missing'))

# ---- 6. gate: seal + handshake present in dist ----------------------------
dist = BASE / 'PineappleFX' / 'dist' / 'index.html'
if not dist.exists():
    err('missing PineappleFX/dist/index.html')
else:
    t = dist.read_text(encoding='utf-8', errors='replace')
    for needle, label in (('<!--PFX-GATE-START-->', 'gate block'),
                          ('/*PFX-SEALED*/', 'obfuscation seal'),
                          ('Security check failed', 'self-test tripwire'),
                          # "pineapplefx:token" is the seal-proof marker: the token-cache
                          # key string survives identifier mangling; its presence
                          # proves the server-handshake code shipped.
                          ('"pineapplefx:token"', 'server handshake (token cache)')):
        (ok('dist gate: ' + label) if needle in t else err('dist gate missing: ' + label))
    if 'sxii.edits' in t:
        err('dist gate still contains legacy branding')

# ---- 7. staged .zxp: exists, valid zip, same gate --------------------------
zxp = SITE / 'downloads' / 'PineappleFX.zxp'
if not zxp.exists():
    err('missing site/downloads/PineappleFX.zxp (run the release chain)')
else:
    try:
        with zipfile.ZipFile(zxp) as z:
            names = set(z.namelist())
        want = {'CSXS/manifest.xml', 'dist/index.html', 'dist/logo.png',
                'extendscript/host.jsx', 'index.html'}
        if want <= names:
            ok('PineappleFX.zxp packaged (%d entries, %.1f MB)' % (len(names), zxp.stat().st_size / 1e6))
        else:
            err('PineappleFX.zxp missing entries: %s' % sorted(want - names))
        with zipfile.ZipFile(zxp) as z:
            inner = z.read('dist/index.html').decode('utf-8', errors='replace')
            man_in = z.read('CSXS/manifest.xml').decode('utf-8', errors='replace')
        if '/*PFX-SEALED*/' in inner:
            ok('staged .zxp gate sealed')
        else:
            err('staged .zxp gate is NOT sealed — run tools/protect_gate.py')
        if 'com.pineapplestore.pineapplefx' in man_in:
            ok('staged .zxp manifest id correct')
        else:
            err('staged .zxp manifest id wrong')
    except zipfile.BadZipFile:
        err('site/downloads/PineappleFX.zxp is not a valid zip')

# ---- 8. production VERIFY_URL baked? (warning — needs the API host) --------
gate_src = (BASE / 'PineappleFX' / 'dist' / 'index.html').read_text(encoding='utf-8', errors='replace') \
    if dist.exists() else ''
m = re.search(r'var _a\d+ = "(https?://[^"]+/api/verify-license)"', gate_src) or \
    re.search(r'var VERIFY_URL = "(https?://[^"]+)"', gate_src)
if m and 'YOUR-' not in m.group(1):
    ok('gate VERIFY_URL baked: ' + m.group(1))
else:
    warn('gate VERIFY_URL empty — panels run offline-legacy mode; set PFX_VERIFY_URL at build time for server enforcement')

# ---- 9. conflicting server-only deploy configs -----------------------------
for rel in ('vercel.json', 'netlify.toml', 'site/_redirects'):
    if (BASE / rel).exists():
        warn('server-only config present (%s) — harmless on Pages, ensure it does not shadow static routes' % rel)
ok('deploy-config scan done')

print('\n%d error(s), %d warning(s)' % (len(ERRORS), len(WARNS)))
sys.exit(1 if ERRORS else 0)
