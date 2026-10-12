"""PineappleFX Windows installer + auto-activation. Stdlib only.

GUI (default):  python tools/installer.py   (tkinter window)
CLI:            python tools/installer.py --cli --email you@mail --machine ABCD1234 --key PFX2-... [--yes]

What it does:
  1. Safety checks (debugger -> abort; VM -> confirm).
  2. Installs the extension payload into %APPDATA%\\Adobe\\CEP\\extensions\\PineappleFX.
  3. Enables PlayerDebugMode for CSXS.9 → CSXS.12 (unsigned panels).
  4. Verifies the PFX2 key (backend /api/verify-license when reachable,
     else local FNV signature check) and PRE-ACTIVATES the installed copy
     by baking the key in (same mechanism as tools/build_buyer.py), so the
     After Effects panel unlocks on first launch with no pasting.
  5. Writes a signed-token receipt to %APPDATA%\\PineappleFX\\license.json.

Why the Machine ID comes from the panel, not hardware: the panel derives
its 8-char ID from its own install seed, so only the ID shown on the
locked panel validates. The installer records a hardware fingerprint
alongside for audit/binding metadata — it never substitutes the panel ID.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

APP = 'PineappleFX'
ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
MACHINE_RE = re.compile(r'^[A-Za-z0-9]{8}$')
PREKEY_HOOK = 'var PREKEY = "";'


def base_dir():
    # Frozen (PyInstaller): payload lives in the bundle; else repo layout.
    if getattr(sys, 'frozen', False):
        return pathlib.Path(sys._MEIPASS)  # noqa: SLF001
    return pathlib.Path(__file__).resolve().parent.parent


def payload_dir():
    return base_dir() / 'payload'


def extension_source():
    d = payload_dir()
    if (d / 'dist' / 'index.html').exists():
        return d
    return base_dir() / 'PineappleFX'


def load_meta():
    meta_path = payload_dir() / 'meta.json'
    if meta_path.exists():
        try:
            return json.loads(meta_path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            pass
    # Source mode: read SECRET straight from the private mint tool.
    secret = ''
    try:
        mint = base_dir() / 'tools' / 'mint_key.py'
        m = re.search(r'SECRET = "([0-9a-f]{32})"', mint.read_text(encoding='utf-8'))
        if m:
            secret = m.group(1)
    except OSError:
        pass
    return {'secret': secret, 'verify_url': os.environ.get('PFX_VERIFY_URL', ''), 'version': '2.0.0'}


# ---------------- security: anti-debug / anti-VM ----------------

def debugger_present():
    try:
        import ctypes
        if ctypes.windll.kernel32.IsDebuggerPresent():
            return True
        attached = ctypes.c_bool(False)
        if ctypes.windll.kernel32.CheckRemoteDebuggerPresent(-1, ctypes.byref(attached)):
            return bool(attached.value)
    except Exception:
        pass
    return False


def vm_indicators():
    hits = []
    try:
        out = subprocess.run(['wmic', 'computersystem', 'get', 'manufacturer,model'],
                             capture_output=True, text=True, timeout=20).stdout.lower()
        out += subprocess.run(['wmic', 'bios', 'get', 'serialnumber'],
                              capture_output=True, text=True, timeout=20).stdout.lower()
        for sig in ('virtualbox', 'vmware', 'qemu', 'kvm', 'xen', 'parallels', 'hyper-v', 'innotek'):
            if sig in out:
                hits.append(sig)
    except Exception:
        pass
    return hits


def hardware_fp():
    raw = ''
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Microsoft\Cryptography') as k:
            raw = winreg.QueryValueEx(k, 'MachineGuid')[0]
    except Exception:
        pass
    if not raw:
        try:
            raw = subprocess.run(['wmic', 'cpu', 'get', 'processorid'],
                                 capture_output=True, text=True, timeout=20).stdout
        except Exception:
            raw = 'unknown-cpu'
    try:
        disk = subprocess.run(['wmic', 'diskdrive', 'get', 'serialnumber'],
                              capture_output=True, text=True, timeout=20).stdout
        raw += '|' + disk
    except Exception:
        pass
    return hashlib.sha256(raw.encode('utf-8', 'replace')).hexdigest()[:16].upper()


# ---------------- license math (mirrors panel gate, offline fallback) ----------------

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


def norm_key(raw):
    return ''.join(c for c in raw.upper() if c.isalnum())


def key_valid_for(key, machine, secret):
    k = norm_key(key)
    if len(k) != 20 or not k.startswith('PFX2') or not machine:
        return False
    return k[12:20] == sig_for(secret, k[4:12], machine.upper())


def verify_online(verify_url, machine, key, hw_fp, timeout=15):
    """Returns (ok, token, exp, error). Never raises."""
    try:
        req = urllib.request.Request(
            verify_url,
            data=json.dumps({'machine_id': machine, 'license_key': key, 'hw_fp': hw_fp}).encode(),
            headers={'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode('utf-8', 'replace'))
        if data.get('ok') and data.get('token'):
            return True, data['token'], data.get('exp'), ''
        return False, '', 0, data.get('error', 'invalid')
    except Exception as e:
        return False, '', 0, 'unreachable: %s' % (e,)


# ---------------- install steps ----------------

def cep_extension_dir():
    appdata = os.environ.get('APPDATA') or str(pathlib.Path.home() / 'AppData' / 'Roaming')
    return pathlib.Path(appdata) / 'Adobe' / 'CEP' / 'extensions' / APP


def install_files(src, log):
    dest = cep_extension_dir()
    if dest.exists():
        backup = dest.parent / (APP + '.bak')
        if backup.exists():
            shutil.rmtree(backup, ignore_errors=True)
        dest.rename(backup)
        log('previous install moved to %s' % backup)
    for rel in ('CSXS/manifest.xml', 'dist/index.html', 'dist/logo.png',
                'extendscript/host.jsx', 'extendscript/presets/Chrome.ffx',
                'index.html', 'Public/logo.png'):
        s, d = src / rel.replace('/', os.sep), dest / rel.replace('/', os.sep)
        if not s.is_file():
            raise RuntimeError('payload missing: ' + rel)
        d.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(s, d)
    log('installed to %s' % dest)
    return dest


def enable_debug_mode(log):
    ok_any = False
    for v in ('9', '10', '11', '12'):
        key = r'HKCU\Software\Adobe\CSXS.%s' % v
        r = subprocess.run(['reg', 'add', key, '/v', 'PlayerDebugMode',
                            '/t', 'REG_SZ', '/d', '1', '/f'],
                           capture_output=True, text=True)
        if r.returncode == 0:
            ok_any = True
            log('PlayerDebugMode enabled for CSXS.%s' % v)
        else:
            log('CSXS.%s: %s' % (v, (r.stderr or r.stdout or 'failed').strip()[:120]))
    if not ok_any:
        raise RuntimeError('could not write registry (run as administrator?)')
    return True


def preactivate(dest, key, log):
    """Bake the buyer's key into the installed copy (device-bound: only
    unlocks on the machine the key was minted for)."""
    p = dest / 'dist' / 'index.html'
    h = p.read_text(encoding='utf-8')
    if h.count(PREKEY_HOOK) != 1:
        raise RuntimeError('PREKEY hook not found (already personalized?)')
    h = h.replace(PREKEY_HOOK, 'var PREKEY = "%s";' % norm_key(key))
    p.write_text(h, encoding='utf-8')
    log('pre-activated for this machine')


def write_receipt(email, machine, key, token, exp, via, hw_fp, version, log):
    d = pathlib.Path(os.environ.get('APPDATA') or str(pathlib.Path.home())) / APP
    d.mkdir(parents=True, exist_ok=True)
    receipt = {
        'email': email, 'machine': machine.upper(),
        'key_fp': hashlib.sha256(norm_key(key).encode()).hexdigest()[:16],
        'token': token, 'token_exp': exp, 'verified_via': via,
        'hw_fp': hw_fp, 'app_version': version,
    }
    (d / 'license.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    log('receipt written to %s' % (d / 'license.json'))


def run_flow(email, machine, key, api_url, log):
    machine = machine.strip().upper()
    if not MACHINE_RE.match(machine):
        return False, 'Machine ID must be exactly 8 letters/numbers (see the locked panel).'
    if len(norm_key(key)) != 20 or not norm_key(key).startswith('PFX2'):
        return False, 'That does not look like a PFX2 key.'
    meta = load_meta()
    verify_url = api_url or meta.get('verify_url', '')
    hw = hardware_fp()
    token, exp, via = '', 0, 'local'
    if verify_url:
        log('contacting license server…')
        ok, token, exp, err = verify_online(verify_url, machine, key, hw)
        if ok:
            via = 'server'
            log('server verified ✓')
        else:
            log('server says: %s — falling back to local check' % err)
    if via == 'local':
        if not meta.get('secret'):
            return False, 'No backend configured and no local secret available.'
        if not key_valid_for(key, machine, meta['secret']):
            return False, 'Invalid key for this machine. Keys work on one machine only.'
        log('local signature valid ✓')
    src = extension_source()
    dest = install_files(src, log)
    enable_debug_mode(log)
    preactivate(dest, key, log)
    write_receipt(email, machine, key, token, exp, via, hw, meta.get('version', '2.0.0'), log)
    return True, 'Installed + activated. Restart After Effects → Window → Extensions → PineappleFX.'


def ensure_console():
    """Frozen --noconsole exe has no stdout; attach one for CLI mode."""
    try:
        if sys.stdout is None or getattr(sys.stdout, 'closed', False):
            import ctypes
            ctypes.windll.kernel32.AllocConsole()
            sys.stdout = open('CONOUT$', 'w', encoding='utf-8', errors='replace')
            sys.stderr = open('CONOUT$', 'w', encoding='utf-8', errors='replace')
            try:
                sys.stdin = open('CONIN$', 'r', encoding='utf-8', errors='replace')
            except OSError:
                pass
        else:
            try:
                sys.stdout.reconfigure(encoding='utf-8', errors='replace')
                sys.stderr.reconfigure(encoding='utf-8', errors='replace')
            except (AttributeError, OSError):
                pass
    except Exception:
        pass


def main_cli(args):
    ensure_console()

    def log(m):
        print(m, flush=True)

    if debugger_present():
        print('refusing: debugger detected. Close it and run again.')
        return 1
    vms = vm_indicators()
    if vms and not args.allow_vm:
        print('warning: virtualized environment (%s). Re-run with --allow-vm to proceed.' % ','.join(vms))
        return 1
    if sys.platform != 'win32':
        print('warning: not Windows — registry + CEP paths will differ; continuing anyway.')
    email = args.email or ''
    machine = args.machine or input('Machine ID (8 chars, on the locked panel): ').strip()
    key = args.key or input('License key (PFX2-...): ').strip()
    ok, msg = run_flow(email, machine, key, args.api, log)
    print(('OK: ' if ok else 'FAILED: ') + msg)
    return 0 if ok else 1


def main_gui():
    try:
        import tkinter as tk
        from tkinter import messagebox, scrolledtext
    except Exception:
        print('tkinter unavailable — use --cli')
        return main_cli(argparse.Namespace(email='', machine='', key='', api='', allow_vm=True))

    if debugger_present():
        try:
            r = tk.Tk()
            r.withdraw()
            messagebox.showerror(APP, 'Debugger detected. Close it and run again.')
            r.destroy()
        finally:
            pass
        return 1
    vms = vm_indicators()
    if vms:
        r = tk.Tk()
        r.withdraw()
        go = messagebox.askyesno(APP, 'Virtualized environment (%s) detected.\nContinue anyway?' % ','.join(vms))
        r.destroy()
        if not go:
            return 1

    root = tk.Tk()
    root.title('PineappleFX Installer')
    root.resizable(False, False)
    tk.Label(root, text='Email (receipt)').grid(row=0, column=0, sticky='w', padx=10, pady=4)
    e_email = tk.Entry(root, width=40)
    e_email.grid(row=0, column=1, padx=10, pady=4)
    tk.Label(root, text='Machine ID (locked panel)').grid(row=1, column=0, sticky='w', padx=10, pady=4)
    e_mid = tk.Entry(root, width=40)
    e_mid.grid(row=1, column=1, padx=10, pady=4)
    tk.Label(root, text='License key (PFX2-…)').grid(row=2, column=0, sticky='w', padx=10, pady=4)
    e_key = tk.Entry(root, width=40)
    e_key.grid(row=2, column=1, padx=10, pady=4)
    log = scrolledtext.ScrolledText(root, width=58, height=12, state='disabled')
    log.grid(row=3, column=0, columnspan=2, padx=10, pady=6)

    def say(m):
        log.configure(state='normal')
        log.insert('end', m + '\n')
        log.see('end')
        log.configure(state='disabled')
        root.update_idletasks()

    def go_install():
        btn.configure(state='disabled')
        ok, msg = run_flow(e_email.get(), e_mid.get(), e_key.get(), '', say)
        messagebox.showinfo(APP, msg) if ok else messagebox.showerror(APP, msg)
        btn.configure(state='normal')

    btn = tk.Button(root, text='Install & Activate', command=go_install)
    btn.grid(row=4, column=0, columnspan=2, pady=(0, 10))
    root.mainloop()
    return 0


def main():
    ap = argparse.ArgumentParser(description='PineappleFX installer + auto-activation')
    ap.add_argument('--cli', action='store_true')
    ap.add_argument('--email', default='')
    ap.add_argument('--machine', default='')
    ap.add_argument('--key', default='')
    ap.add_argument('--api', default='', help='override /api/verify-license URL')
    ap.add_argument('--allow-vm', action='store_true')
    args = ap.parse_args()
    if args.cli or args.key or sys.platform != 'win32':
        return main_cli(args)
    try:
        return main_gui()
    except Exception as e:
        print('GUI failed (%s) — falling back to CLI' % e)
        return main_cli(args)


if __name__ == '__main__':
    sys.exit(main())
