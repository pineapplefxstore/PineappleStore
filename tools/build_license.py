"""PineappleFX license build v2: NO trial. Device-bound PFX2 keys.
Generates secret (reuses existing), writes tools/mint_key.py,
injects the license gate (key activation + Machine ID) into dist/index.html.
Re-runnable: replaces the previous gate block.
Keys are verified OFFLINE (FNV-1a signature over secret+serial+device, no server).
Flow: buyer pays $15 -> submits email + Machine ID + PayPal txn id on the site
      -> seller runs  python tools/mint_key.py --device <MACHINEID>
      -> seller emails the PFX2 key (+ optional personalized .zxp, see build_buyer.py)."""
import os
import pathlib
import re
import secrets as pysecrets

BASE = pathlib.Path(r'C:\Users\quiff\Downloads\Telegram Desktop\PineappleFX\PineappleFX')
TOOLS = BASE.parent / 'tools'
TOOLS.mkdir(exist_ok=True)
DIST = BASE / 'dist' / 'index.html'

BUY_URL = 'https://paypal.me/sxiiedits/15USD'
ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'  # Crockford base32, 32 chars

MINT_TEMPLATE = '''"""Mint PineappleFX device-bound license keys. PRIVATE - never share this file or the SECRET.
Usage:
  python mint_key.py --device <MACHINEID>     mint one key for a buyer's machine
  python mint_key.py --device <MACHINEID> --email buyer@mail.com
  python mint_key.py --check PFX2-XXXXXXXX-XXXXXXXX --device <MACHINEID>
The buyer finds their Machine ID on the locked panel screen (click it to copy)
and sends it with their email + PayPal transaction id after paying $15."""
import secrets
import sys

SECRET = "%%SECRET%%"
ALPHA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

def fnv(s):
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h

def sig_for(serial, device):
    h1 = fnv(SECRET + ":" + serial + ":" + device)
    h2 = fnv(device + ":" + serial + ":" + SECRET)
    s = ""
    for i in range(6):
        s += ALPHA[(h1 >> (27 - i * 5)) & 31]
    for j in range(2):
        s += ALPHA[(h2 >> (27 - j * 5)) & 31]
    return s

def mint(device):
    serial = "".join(secrets.choice(ALPHA) for _ in range(8))
    return "PFX2-%s-%s" % (serial, sig_for(serial, device))

def check(key, device):
    k = "".join(c for c in key.upper() if c.isalnum())
    if len(k) != 20 or not k.startswith("PFX2") or not device:
        return False
    return k[12:20] == sig_for(k[4:12], device.upper())

if __name__ == "__main__":
    args = sys.argv[1:]
    device = ""
    email = ""
    if "--device" in args:
        device = args[args.index("--device") + 1].upper()
    if "--email" in args:
        email = args[args.index("--email") + 1]
    if "--check" in args:
        key = args[args.index("--check") + 1]
        print("VALID" if check(key, device) else "INVALID")
    elif device:
        key = mint(device)
        print(key)
        if email:
            print("email: " + email)
    else:
        print("usage: python mint_key.py --device <MACHINEID> [--email buyer@mail]")
'''

GATE_TEMPLATE = '''<!--PFX-GATE-START-->
<div id="pfx-gate" style="display:none;position:fixed;inset:0;z-index:99999;align-items:center;justify-content:center;background:#141416;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;">
  <div style="width:min(92vw,340px);background:#1e1e21;border:1px solid #3c3c40;border-radius:16px;padding:24px 22px;text-align:center;color:#f5f5f4;box-shadow:0 24px 70px rgba(0,0,0,.6);">
    <img src="./logo.png" alt="PineappleFX" width="64" height="64" style="border-radius:50%;display:block;margin:0 auto 10px;" />
    <div style="font-size:18px;font-weight:700;letter-spacing:-.2px;">Pineapple<span style="color:#feca08;">FX</span></div>
    <div style="font-size:11px;color:#a8a8ad;margin:2px 0 14px;">by Pineapple Store</div>
    <p style="font-size:12.5px;line-height:1.5;color:#c9c9ce;margin:0 0 12px;">This copy of PineappleFX is locked to one machine.<br/>Buy a license, then paste your key below.</p>
    <input id="pfx-gate-key" placeholder="PFX2-XXXXXXXX-XXXXXXXX" spellcheck="false" autocomplete="off" style="width:100%;box-sizing:border-box;background:#141416;border:1px solid #3c3c40;border-radius:9px;color:#f5f5f4;font-family:monospace;font-size:12px;padding:9px 10px;text-transform:uppercase;outline:none;" />
    <button id="pfx-gate-go" style="width:100%;margin-top:10px;border:none;cursor:pointer;border-radius:999px;padding:9px;font-size:13px;font-weight:700;color:#241a04;background:linear-gradient(180deg,#ffd850,#feca08);">Activate this machine</button>
    <div title="Click to copy" id="pfx-gate-dev" style="margin-top:12px;font-size:11.5px;color:#a8a8ad;cursor:pointer;">Machine ID: <span id="pfx-gate-devid" style="font-family:monospace;color:#feca08;font-weight:700;"></span> (click to copy)</div>
    <a href="%%BUY%%" style="display:inline-block;margin-top:10px;font-size:12px;font-weight:600;color:#feca08;text-decoration:none;">Buy PineappleFX &mdash; $15</a>
    <p id="pfx-gate-err" style="min-height:16px;font-size:11.5px;color:#ff6b62;margin:8px 0 0;"></p>
  </div>
</div>
<script>
(function () {
  var SECRET = "%%SECRET%%";
  var PREKEY = "%%PREKEY%%";
  var LS_K = "pineapplefx:license";
  var LS_D = "pineapplefx:device";
  var ALPHA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  /* Server-validated activation: VERIFY_URL is baked at build time
     (%%VERIFY%% -> your https://.../api/verify-license). Empty = offline legacy mode.
     Policy: fresh server token unlocks; offline, a cached token within
     GRACE_MS unlocks; grandfathered installs unlock offline too — EXCEPT
     revoked keys, which always lock. */
  var VERIFY_URL = "%%VERIFY%%";
  var TOKEN_K = "pineapplefx:token";
  var GRACE_MS = 7 * 24 * 3600 * 1000;
  var LEGACY_GRANDFATHER = true;
  function fnv(s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
  function sigFor(serial, device) {
    var h1 = fnv(SECRET + ":" + serial + ":" + device), h2 = fnv(device + ":" + serial + ":" + SECRET), s = "";
    for (var i = 0; i < 6; i++) { s += ALPHA.charAt((h1 >>> (27 - i * 5)) & 31); }
    for (var j = 0; j < 2; j++) { s += ALPHA.charAt((h2 >>> (27 - j * 5)) & 31); }
    return s;
  }
  function deviceId() {
    var d = "";
    try { d = localStorage.getItem(LS_D) || ""; } catch (e) {}
    if (!/^[0-9A-F]{16}$/.test(d)) {
      d = "";
      for (var i = 0; i < 16; i++) { d += "0123456789ABCDEF".charAt(Math.floor(Math.random() * 16)); }
      try { localStorage.setItem(LS_D, d); } catch (e) {}
    }
    var hex = d.slice(0, 10), bits = "", s = "";
    for (var i = 0; i < hex.length; i++) { bits += ("000" + parseInt(hex.charAt(i), 16).toString(2)).slice(-4); }
    for (var k = 0; k < 8; k++) { s += ALPHA.charAt(parseInt(bits.substr(k * 5, 5), 2)); }
    return s;
  }
  function valid(key, device) {
    var k = String(key || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
    if (k.length !== 20 || k.slice(0, 4) !== "PFX2" || !device) return false;
    return k.slice(12, 20) === sigFor(k.slice(4, 12), device);
  }
  function store(k) { try { localStorage.setItem(LS_K, k); } catch (e) {} }
  function stored() { try { return localStorage.getItem(LS_K) || ""; } catch (e) { return ""; } }
  var dev = deviceId();
  if (PREKEY && valid(PREKEY, dev)) { store(PREKEY); }
  var gate = document.getElementById("pfx-gate");
  var err = document.getElementById("pfx-gate-err");
  function unlock() { if (gate.parentNode) { gate.parentNode.removeChild(gate); } }
  function lock(msg) {
    gate.style.display = "flex";
    if (msg) { err.textContent = msg; }
  }
  function tokenGet() { try { return JSON.parse(localStorage.getItem(TOKEN_K) || "null"); } catch (e) { return null; } }
  function tokenSet(o) { try { localStorage.setItem(TOKEN_K, JSON.stringify(o)); } catch (e) {} }
  function tokenFresh(tok) { return tok && tok.mid === dev && tok.exp && tok.exp * 1000 > Date.now(); }
  function tokenInGrace(tok) { return tok && tok.mid === dev && tok.checked && (Date.now() - tok.checked) < GRACE_MS; }
  function serverVerify(key, cb) {
    // cb(ok, data). data.error === "revoked" is authoritative: never grandfather it.
    if (!VERIFY_URL) { cb(false, null); return; }
    var done = false;
    function fin(ok, data) { if (!done) { done = true; cb(ok, data); } }
    try {
      setTimeout(function () { fin(false, null); }, 8000);
      fetch(VERIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ machine_id: dev, license_key: key })
      }).then(function (r) {
        return r.json().catch(function () { return null; });
      }).then(function (d) {
        fin(!!(d && d.ok && d.token), d);
      }).catch(function () { fin(false, null); });
    } catch (e) { fin(false, null); }
  }
  function cacheFreshToken(d) {
    if (d && d.token && d.exp) { tokenSet({ t: d.token, exp: d.exp, mid: dev, checked: Date.now() }); }
  }
  var k0 = stored();
  if (valid(k0, dev)) {
    var t0 = tokenGet();
    if (tokenFresh(t0)) {
      unlock();
      serverVerify(k0, function (ok, d) { if (ok) { cacheFreshToken(d); } });
      return;
    }
    serverVerify(k0, function (ok, d) {
      if (ok) { cacheFreshToken(d); unlock(); return; }
      if (d && d.error === "revoked") { lock("This license was revoked. Contact Pineapple Store."); return; }
      if (tokenInGrace(t0) || (!t0 && LEGACY_GRANDFATHER)) { unlock(); return; }
      lock("Could not reach the license server. Connect to the internet once to finish activation.");
    });
    return;
  }
  document.getElementById("pfx-gate-devid").textContent = dev;
  document.getElementById("pfx-gate-dev").onclick = function () {
    var done = function () { document.getElementById("pfx-gate-err").textContent = "Machine ID copied."; };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(dev).then(done, done); return; }
      var ta = document.createElement("textarea"); ta.value = dev; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (e) {}
      document.body.removeChild(ta); done();
    } catch (e) { done(); }
  };
  gate.style.display = "flex";
  function go() {
    var k = document.getElementById("pfx-gate-key").value;
    if (!valid(k, dev)) { err.textContent = "Invalid key for this machine. Keys work on one machine only."; return; }
    err.textContent = "Verifying with the license server…";
    serverVerify(k, function (ok, d) {
      if (ok) {
        cacheFreshToken(d);
        store(k.toUpperCase().replace(/[^0-9A-Z]/g, "")); unlock(); return;
      }
      if (d && d.error === "revoked") { err.textContent = "This license was revoked. Contact Pineapple Store."; return; }
      if (!VERIFY_URL || LEGACY_GRANDFATHER) {
        store(k.toUpperCase().replace(/[^0-9A-Z]/g, "")); unlock(); return;
      }
      err.textContent = "Could not reach the license server. Connect once to activate.";
    });
  }
  document.getElementById("pfx-gate-go").onclick = go;
  document.getElementById("pfx-gate-key").onkeydown = function (e) { if (e.key === "Enter") go(); };
})();
</script>
<!--PFX-GATE-END-->'''


def main():
    mint_path = TOOLS / 'mint_key.py'
    if mint_path.exists():
        src = mint_path.read_text(encoding='utf-8')
        m = re.search(r'SECRET = "([0-9a-f]{32})"', src)
        secret = m.group(1) if m else pysecrets.token_hex(16)
        print('reusing secret' if m else 'new secret (old file unparseable)')
    else:
        secret = pysecrets.token_hex(16)
        print('new secret generated')
    mint_path.write_text(MINT_TEMPLATE.replace('%%SECRET%%', secret), encoding='utf-8')
    print('wrote', mint_path)

    verify_url = os.environ.get('PFX_VERIFY_URL', '')
    gate = (GATE_TEMPLATE.replace('%%SECRET%%', secret).replace('%%BUY%%', BUY_URL)
            .replace('%%PREKEY%%', '').replace('%%VERIFY%%', verify_url))
    h = DIST.read_text(encoding='utf-8', errors='ignore')
    pat = re.compile(r'<!--PFX-GATE-START-->.*?<!--PFX-GATE-END-->', re.S)
    assert pat.search(h), 'no gate block found - fresh inject unsupported in v2, check dist'
    h = pat.sub(lambda _: gate, h, count=1)
    print('gate replaced (v2, no trial, device-bound, server handshake)')
    print('verify url: %s' % (verify_url or '(empty = offline legacy mode)'))
    assert '%%SECRET%%' not in h and '%%BUY%%' not in h and '%%PREKEY%%' not in h and '%%VERIFY%%' not in h
    assert 'trial_start' not in h, 'trial leftovers!'
    DIST.write_text(h, encoding='utf-8')
    print('dist updated, len', len(h))


if __name__ == '__main__':
    main()
