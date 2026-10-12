"""Harden the PFX license gate inside dist/index.html. PRIVATE build tool.

Run ORDER (each step rewrites dist/index.html):
  1. python tools/build_license.py   # fresh gate (set PFX_VERIFY_URL env to bake it in)
  2. python tools/build_buyer.py ... # optional personalized .zxp
  3. python tools/protect_gate.py     # THIS FILE, last — re-running build_license wipes it

What it does (all semantics-preserving, verified post-build):
  1. Injects a self-test tripwire: the gate must REJECT a known-bad key and
     ACCEPT a known-good key for a canary device, or it stays locked with
     "Security check failed". Patching valid() to always-true trips it.
  2. Splits the SECRET literal into joined chunks (no single grep-able secret).
  3. Renames gate-local identifiers to meaningless _aN names (string literals
     are masked first, so "pfx-gate-dev"-style ids and URLs are untouched).
  4. Strips code comments.
  5. Refuses to run twice (/*PFX-SEALED*/ marker) and node --check's the result.

Honest limits: this raises the bar against casual patching only. The REAL
protection is the server handshake (/api/verify-license + revocation):
a tampered panel can lie to itself, but it cannot forge server tokens.
"""
import pathlib
import re
import shutil
import subprocess
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
DIST = BASE / 'PineappleFX' / 'dist' / 'index.html'
MINT = BASE / 'tools' / 'mint_key.py'
ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
MARKER = '/*PFX-SEALED*/'
CANARY_DEVICE = 'SEALDEV0'
CANARY_SERIAL = 'SEAL0001'


def fnv(s):
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def sig_for(secret, serial, device):
    h1 = fnv(secret + ':' + serial + ':' + device)
    h2 = fnv(device + ':' + serial + ':' + secret)
    s = ''
    for i in range(6):
        s += ALPHA[(h1 >> (27 - i * 5)) & 31]
    for j in range(2):
        s += ALPHA[(h2 >> (27 - j * 5)) & 31]
    return s


# Gate-defined identifiers only. NEVER browser globals, DOM properties,
# promise methods (then/catch), single letters, or words inside UI strings.
RENAME = [
    'SECRET', 'LEGACY_GRANDFATHER', 'VERIFY_URL', 'TOKEN_K',
    # NOTE: PREKEY is deliberately NOT renamed — build_buyer.py and the
    # Windows installer personalize installs via the `var PREKEY = "";` hook.
    'GRACE_MS', 'cacheFreshToken', 'serverVerify', 'tokenInGrace',
    'tokenFresh', 'tokenSet', 'tokenGet', 'deviceId', 'sigFor',
    'stored', 'store', 'valid', 'unlock', 'lock', 'ALPHA', 'LS_D',
    'LS_K', 'gate', 'device', 'serial', 'err', 'dev', 'tok', 'fin',
    'done', 'cb', 'k0', 't0',
]
RENAME.sort(key=len, reverse=True)


def mask_strings(code):
    """Replace '...'/"..." literals with placeholders; return (code, literals)."""
    lits = []

    def sub(m):
        lits.append(m.group(0))
        return '@@S%d@@' % (len(lits) - 1)

    code = re.sub(r"'(?:[^'\\\n]|\\.)*'", sub, code)
    code = re.sub(r'"(?:[^"\\\n]|\\.)*"', sub, code)
    return code, lits


def unmask_strings(code, lits):
    """Restore literals. Iterates because a double-quoted literal may itself
    contain a placeholder from the earlier single-quote pass (nesting)."""

    def sub(m):
        return lits[int(m.group(1))]

    prev = None
    while prev != code:
        prev = code
        code = re.sub(r'@@S(\d+)@@', sub, code)
    if '@@S' in code:
        raise RuntimeError('unmask incomplete — refusing to write')
    return code


def main():
    src = MINT.read_text(encoding='utf-8')
    m = re.search(r'SECRET = "([0-9a-f]{32})"', src)
    if not m:
        print('refusing: cannot read SECRET from tools/mint_key.py')
        sys.exit(1)
    secret = m.group(1)

    h = DIST.read_text(encoding='utf-8')
    pat = re.compile(r'<!--PFX-GATE-START-->(.*?)<!--PFX-GATE-END-->', re.S)
    mm = pat.search(h)
    if not mm:
        print('refusing: no gate block found')
        sys.exit(1)
    block = mm.group(1)
    if MARKER in block:
        print('refusing: gate already sealed (re-run build_license.py first for a fresh gate)')
        sys.exit(1)
    if 'serverVerify' not in block:
        print('refusing: gate has no server handshake — update build_license.py template first')
        sys.exit(1)

    # 1) self-test tripwire (uses UNRENAMED names; injected pre-mangle)
    good = 'PFX2-%s-%s' % (CANARY_SERIAL, sig_for(secret, CANARY_SERIAL, CANARY_DEVICE))
    bad = good[:-1] + ('0' if good[-1] != '0' else '1')
    assert bad != good
    seal = ('\n  var _seal = (function () { try { return valid("%s", "%s") === false'
            ' && valid("%s", "%s") === true; } catch (e) { return false; } })();'
            '\n  if (!_seal) { lock("Security check failed. Please reinstall PineappleFX."); return; }'
            % (bad, CANARY_DEVICE, good, CANARY_DEVICE))
    anchor = 'var k0 = stored();'
    assert block.count(anchor) == 1, 'gate shape changed — update protect_gate.py'
    block = block.replace(anchor, seal + '\n  ' + anchor, 1)

    # 2) mask strings, 3) rename, 4) split secret, strip comments
    block, lits = mask_strings(block)
    names = {}
    for i, name in enumerate(RENAME):
        names[name] = '_a%d' % i
    for name in RENAME:
        block = re.sub(r'\b%s\b' % re.escape(name), names[name], block)
    block = re.sub(r'/\*[\s\S]*?\*/', '', block)   # /* */ (strings are masked)
    block = re.sub(r'//[^\n]*', '', block)          # // (URLs live in strings)
    block = unmask_strings(block, lits)
    chunks = [secret[i:i + 4] for i in range(0, 32, 4)]
    block = block.replace('"%s"' % secret,
                          '[%s].join("")' % ','.join('"%s"' % c for c in chunks))
    assert secret not in block, 'secret still contiguous!'
    block = MARKER + block  # marker lives INSIDE the gate block
    h = pat.sub(lambda _: '<!--PFX-GATE-START-->' + block + '<!--PFX-GATE-END-->', h, count=1)

    DIST.write_text(h, encoding='utf-8')
    print('sealed: secret split, %d identifiers mangled, self-test injected' % len(names))

    # 5) verify: node syntax check on the final gate's <script> body only
    # (the block also contains the gate's HTML, which is not JS)
    node = shutil.which('node')
    final = pat.search(DIST.read_text(encoding='utf-8')).group(1)
    mjs = re.search(r'<script>([\s\S]*)</script>', final)
    final = mjs.group(1) if mjs else final
    if node:
        import tempfile
        with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8') as f:
            f.write(final)
            tmp = f.name
        r = subprocess.run([node, '--check', tmp], capture_output=True, text=True)
        pathlib.Path(tmp).unlink(missing_ok=True)
        if r.returncode != 0:
            print('WARNING: node --check failed:\n' + r.stderr)
        else:
            print('node --check: gate syntax OK')
    else:
        print('node not found — syntax check skipped')


if __name__ == '__main__':
    main()
