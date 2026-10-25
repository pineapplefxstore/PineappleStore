"""PineappleFX Windows installer + auto-activation. Stdlib only.

GUI (default):  python tools/installer.py   (Apple-inspired dark UI)
CLI:            python tools/installer.py --cli --email you@mail --machine ABCD1234 --key PFX2-... [--yes]
Uninstall:      python tools/installer.py --uninstall

Features:
  1. Safety checks (debugger -> abort; VM -> confirm).
  2. Installs the extension payload into %APPDATA%\\Adobe\\CEP\\extensions\\PineappleFX.
  3. Enables PlayerDebugMode for CSXS.9 -> CSXS.20 (unsigned panels).
  4. Pre-activates panel with buyer's license key.
  5. Registers in Windows Control Panel (Add/Remove Programs) under "PineappleFX".
  6. Creates uninstaller and Windows Start Menu shortcut.
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
APP_DISPLAY = 'PineappleFX for Adobe After Effects'
PUBLISHER = 'PineappleFX'
VERSION = '2.0.0'
ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
MACHINE_RE = re.compile(r'^[A-Za-z0-9]{8}$')
PREKEY_HOOK = 'var PREKEY = "";'


def base_dir():
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
    secret = ''
    try:
        mint = base_dir() / 'tools' / 'mint_key.py'
        m = re.search(r'SECRET = "([0-9a-f]{32})"', mint.read_text(encoding='utf-8'))
        if m:
            secret = m.group(1)
    except OSError:
        pass
    return {'secret': secret, 'verify_url': os.environ.get('PFX_VERIFY_URL', ''), 'version': VERSION}


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


# ---------------- license math ----------------

def fnv(s):
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def sig_for(secret, serial, device):
    combo = '%s:%s:%s' % (secret, serial, device)
    h = fnv(combo)
    return ALPHA[h % 32] + ALPHA[(h >> 5) % 32] + ALPHA[(h >> 10) % 32] + ALPHA[(h >> 15) % 32]


def norm_key(k):
    return ''.join(c for c in (k or '').upper() if c.isalnum())


def key_valid_for(key, machine, secret):
    k = norm_key(key)
    if len(k) != 20 or not k.startswith('PFX2'):
        return False
    body = k[4:]
    serial = body[:12]
    sig = body[12:]
    return sig == sig_for(secret, serial, machine.upper())


def verify_online(url, machine, key, hw_fp):
    body = json.dumps({'key': norm_key(key), 'machine': machine.upper(), 'hw_fp': hw_fp}).encode('utf-8')
    req = urllib.request.Request(url, data=body, headers={'Content-Type': 'application/json', 'User-Agent': 'PFX-Installer/2.0'})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            payload = json.loads(r.read().decode('utf-8'))
            if payload.get('valid'):
                return True, payload.get('token', ''), payload.get('exp', 0), None
            return False, '', 0, payload.get('error') or 'rejected'
    except Exception as e:
        return False, '', 0, str(e)


# ---------------- installation & control panel registration ----------------

def cep_extensions_dir():
    appdata = os.environ.get('APPDATA')
    if not appdata:
        appdata = str(pathlib.Path.home() / 'AppData' / 'Roaming')
    return pathlib.Path(appdata) / 'Adobe' / 'CEP' / 'extensions'


def pfx_appdata_dir():
    appdata = os.environ.get('APPDATA')
    if not appdata:
        appdata = str(pathlib.Path.home() / 'AppData' / 'Roaming')
    return pathlib.Path(appdata) / APP


def install_files(src, log):
    dest = cep_extensions_dir() / APP
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        backup = dest.with_name(APP + '.bak')
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
    for v in range(9, 21):
        key = r'HKCU\Software\Adobe\CSXS.%d' % v
        r = subprocess.run(['reg', 'add', key, '/v', 'PlayerDebugMode',
                            '/t', 'REG_SZ', '/d', '1', '/f'],
                           capture_output=True, text=True)
        if r.returncode == 0:
            ok_any = True
    if ok_any:
        log('PlayerDebugMode enabled for CSXS.9 -> CSXS.20')
    return ok_any


def preactivate(dest, key, log):
    p = dest / 'dist' / 'index.html'
    h = p.read_text(encoding='utf-8')
    if h.count(PREKEY_HOOK) != 1:
        raise RuntimeError('PREKEY hook not found (already personalized?)')
    h = h.replace(PREKEY_HOOK, 'var PREKEY = "%s";' % norm_key(key))
    p.write_text(h, encoding='utf-8')
    log('pre-activated for this machine')


def write_receipt(email, machine, key, token, exp, via, hw_fp, version, log):
    d = pfx_appdata_dir()
    d.mkdir(parents=True, exist_ok=True)
    receipt = {
        'email': email, 'machine': machine.upper(),
        'key_fp': hashlib.sha256(norm_key(key).encode()).hexdigest()[:16],
        'token': token, 'token_exp': exp, 'verified_via': via,
        'hw_fp': hw_fp, 'app_version': version,
    }
    (d / 'license.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    log('receipt written to %s' % (d / 'license.json'))


def register_control_panel(dest_dir, log):
    """Registers PineappleFX into Windows Control Panel Add/Remove Programs."""
    try:
        import winreg
        app_dir = pfx_appdata_dir()
        app_dir.mkdir(parents=True, exist_ok=True)
        
        # Copy running installer exe as uninstaller into %APPDATA%/PineappleFX
        uninst_exe = app_dir / 'PineappleFX-Uninstaller.exe'
        if getattr(sys, 'frozen', False):
            current_exe = sys.executable
            if os.path.abspath(current_exe) != os.path.abspath(str(uninst_exe)):
                shutil.copy2(current_exe, str(uninst_exe))
        
        # Copy logo icon if present
        ico_src = base_dir() / 'assets' / 'logo.ico'
        ico_dest = app_dir / 'logo.ico'
        if ico_src.exists():
            shutil.copy2(str(ico_src), str(ico_dest))

        key_path = r'Software\Microsoft\Windows\CurrentVersion\Uninstall\PineappleFX'
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as k:
            winreg.SetValueEx(k, 'DisplayName', 0, winreg.REG_SZ, APP_DISPLAY)
            winreg.SetValueEx(k, 'DisplayVersion', 0, winreg.REG_SZ, VERSION)
            winreg.SetValueEx(k, 'Publisher', 0, winreg.REG_SZ, PUBLISHER)
            winreg.SetValueEx(k, 'InstallLocation', 0, winreg.REG_SZ, str(dest_dir))
            
            uninst_cmd = f'"{uninst_exe}" --uninstall' if uninst_exe.exists() else f'"{sys.executable}" -m tools.installer --uninstall'
            winreg.SetValueEx(k, 'UninstallString', 0, winreg.REG_SZ, uninst_cmd)
            winreg.SetValueEx(k, 'QuietUninstallString', 0, winreg.REG_SZ, uninst_cmd + ' --yes')
            
            icon_path = str(ico_dest if ico_dest.exists() else dest_dir / 'dist' / 'logo.png')
            winreg.SetValueEx(k, 'DisplayIcon', 0, winreg.REG_SZ, icon_path)
            winreg.SetValueEx(k, 'HelpLink', 0, winreg.REG_SZ, 'https://pineapplestore.vercel.app/faq')
            winreg.SetValueEx(k, 'URLInfoAbout', 0, winreg.REG_SZ, 'https://pineapplestore.vercel.app')
            winreg.SetValueEx(k, 'NoModify', 0, winreg.REG_DWORD, 1)
            winreg.SetValueEx(k, 'NoRepair', 0, winreg.REG_DWORD, 1)
            
            # Estimated size in KB
            try:
                size_kb = sum(f.stat().st_size for f in dest_dir.glob('**/*') if f.is_file()) // 1024
                winreg.SetValueEx(k, 'EstimatedSize', 0, winreg.REG_DWORD, int(size_kb))
            except Exception:
                pass
        log('Registered in Windows Control Panel as "%s"' % APP_DISPLAY)
        return True
    except Exception as e:
        log('Control panel registration note: %s' % e)
        return False


def run_uninstall():
    """Uninstalls PineappleFX extension and cleans registry entry."""
    errors = []
    dest = cep_extensions_dir() / APP
    if dest.exists():
        try:
            shutil.rmtree(dest, ignore_errors=True)
        except Exception as e:
            errors.append(str(e))
    backup = dest.with_name(APP + '.bak')
    if backup.exists():
        try:
            shutil.rmtree(backup, ignore_errors=True)
        except Exception:
            pass

    # Remove Windows Uninstall key
    try:
        import winreg
        key_path = r'Software\Microsoft\Windows\CurrentVersion\Uninstall\PineappleFX'
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
    except Exception:
        pass

    if errors:
        return False, 'Uninstalled with warnings: ' + ', '.join(errors)
    return True, 'PineappleFX has been completely removed from your system.'


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
    write_receipt(email, machine, key, token, exp, via, hw, meta.get('version', VERSION), log)
    register_control_panel(dest, log)
    return True, 'Successfully Installed and Activated!\n\nOpen After Effects → Window → Extensions → PineappleFX.'


def ensure_console():
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

    if args.uninstall:
        ok, msg = run_uninstall()
        print(('OK: ' if ok else 'FAILED: ') + msg)
        return 0 if ok else 1

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
        from tkinter import messagebox
        from PIL import Image, ImageTk
    except Exception:
        print('tkinter/PIL unavailable — falling back to CLI')
        return main_cli(argparse.Namespace(email='', machine='', key='', api='', allow_vm=True, uninstall=False))

    if debugger_present():
        r = tk.Tk()
        r.withdraw()
        messagebox.showerror(APP, 'Debugger detected. Close it and run again.')
        r.destroy()
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
    root.title(APP_DISPLAY)
    root.geometry('540x520')
    root.resizable(False, False)

    BG = '#1e1e20'
    CARD = '#2a2a2e'
    BORDER = '#38383c'
    ACCENT = '#feca08'
    TEXT = '#f5f5f7'
    MUTED = '#86868b'
    INPUT_BG = '#141416'

    root.configure(bg=BG)

    # Set icon
    ico_path = base_dir() / 'assets' / 'logo.ico'
    if ico_path.exists():
        try:
            root.iconbitmap(str(ico_path))
        except Exception:
            pass

    # Header
    header = tk.Frame(root, bg=BG)
    header.pack(pady=(22, 12), fill='x')

    png_path = base_dir() / 'assets' / 'logo.png'
    if png_path.exists():
        try:
            pil_img = Image.open(str(png_path)).resize((54, 54), Image.Resampling.LANCZOS)
            img_tk = ImageTk.PhotoImage(pil_img)
            lbl_logo = tk.Label(header, image=img_tk, bg=BG)
            lbl_logo.image = img_tk
            lbl_logo.pack()
        except Exception:
            pass

    tk.Label(header, text='PineappleFX Setup', font=('SF Pro Display', 16, 'bold'), fg=TEXT, bg=BG).pack(pady=(6, 2))
    tk.Label(header, text='Official Plugin Installer & Activator', font=('SF Pro Text', 10), fg=MUTED, bg=BG).pack()

    card = tk.Frame(root, bg=CARD, highlightbackground=BORDER, highlightthickness=1, padx=22, pady=16)
    card.pack(padx=28, fill='x')

    def make_field(parent, label_text):
        tk.Label(parent, text=label_text, font=('SF Pro Text', 9, 'bold'), fg=MUTED, bg=CARD).pack(anchor='w', pady=(6, 2))
        entry = tk.Entry(parent, font=('SF Pro Text', 11), bg=INPUT_BG, fg=TEXT, insertbackground=ACCENT,
                         relief='flat', highlightbackground=BORDER, highlightthickness=1)
        entry.pack(fill='x', ipady=6)
        return entry

    e_email = make_field(card, 'PURCHASE EMAIL (FOR RECEIPT)')
    e_mid = make_field(card, 'MACHINE ID (SHOWN ON AFTER EFFECTS PANEL)')
    e_key = make_field(card, 'LICENSE KEY (PFX2-...)')

    log_box = tk.Text(card, height=4, font=('Consolas', 9), bg=INPUT_BG, fg='#a1a1aa',
                      relief='flat', state='disabled', highlightthickness=0)
    log_box.pack(fill='x', pady=(12, 4))

    def say(msg):
        log_box.configure(state='normal')
        log_box.insert('end', msg + '\n')
        log_box.see('end')
        log_box.configure(state='disabled')
        root.update_idletasks()

    def do_install():
        btn_go.configure(state='disabled', text='Installing & Activating...')
        root.update()
        ok, msg = run_flow(e_email.get(), e_mid.get(), e_key.get(), '', say)
        btn_go.configure(state='normal', text='Install & Activate Plugin')
        if ok:
            messagebox.showinfo('PineappleFX Setup', msg)
        else:
            messagebox.showerror('Setup Error', msg)

    btn_go = tk.Button(card, text='Install & Activate Plugin', font=('SF Pro Text', 11, 'bold'),
                       bg=ACCENT, fg='#141416', activebackground='#ffdb4d', activeforeground='#141416',
                       relief='flat', bd=0, pady=10, cursor='hand2', command=do_install)
    btn_go.pack(fill='x', pady=(12, 4))

    footer = tk.Label(root, text='Registers in Windows Control Panel • Publisher: PineappleFX',
                      font=('SF Pro Text', 8), fg='#636366', bg=BG)
    footer.pack(side='bottom', pady=12)

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
    ap.add_argument('--uninstall', action='store_true', help='Uninstall PineappleFX and remove registry entry')
    ap.add_argument('--yes', action='store_true')
    args = ap.parse_args()

    if args.uninstall:
        ok, msg = run_uninstall()
        if not args.cli and sys.platform == 'win32':
            try:
                import tkinter as tk
                from tkinter import messagebox
                r = tk.Tk()
                r.withdraw()
                messagebox.showinfo(APP, msg) if ok else messagebox.showerror(APP, msg)
                r.destroy()
            except Exception:
                pass
        print(('OK: ' if ok else 'FAILED: ') + msg)
        return 0 if ok else 1

    if args.cli or args.key or sys.platform != 'win32':
        return main_cli(args)
    try:
        return main_gui()
    except Exception as e:
        print('GUI failed (%s) — falling back to CLI' % e)
        return main_cli(args)


if __name__ == '__main__':
    sys.exit(main())
