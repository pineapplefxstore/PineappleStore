"""Build PineappleFX-Installer.exe (Windows). Run from the repo root.

Usage:
  py tools/build_exe.py [--verify-url https://host/api/verify-license]

Pipeline:
  1. Stages payload/ = the 7 sealed extension files + meta.json
     (FNV SECRET from tools/mint_key.py + verify URL + version).
  2. Runs PyInstaller --onefile --noconsole (tkinter GUI bundled).
  3. Copies dist/PineappleFX-Installer.exe to downloads/.

Requires: pip install pyinstaller. tkinter ships with CPython on Windows.
For stronger binary protection, post-process with PyArmor/Nuitka before
this step — the source additionally carries anti-debug/anti-VM checks.
"""
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
STAGE = BASE / 'build' / 'exe-payload'
WANT = ['CSXS/manifest.xml', 'dist/index.html', 'dist/logo.png',
        'extendscript/host.jsx', 'extendscript/presets/Chrome.ffx',
        'index.html', 'Public/logo.png']


def main():
    verify_url = ''
    if '--verify-url' in sys.argv:
        verify_url = sys.argv[sys.argv.index('--verify-url') + 1]
    verify_url = verify_url or os.environ.get('PFX_VERIFY_URL', '')

    src_secret = ''
    m = re.search(r'SECRET = "([0-9a-f]{32})"',
                  (BASE / 'tools' / 'mint_key.py').read_text(encoding='utf-8'))
    if m:
        src_secret = m.group(1)
    if not src_secret:
        print('refusing: cannot read SECRET from tools/mint_key.py')
        sys.exit(1)

    gate = (BASE / 'PineappleFX' / 'dist' / 'index.html').read_text(encoding='utf-8', errors='replace')
    if '/*PFX-SEALED*/' not in gate:
        print('refusing: dist gate not sealed — run build_license.py + protect_gate.py first')
        sys.exit(1)
    if gate.count('var PREKEY = "";') != 1:
        print('refusing: PREKEY hook missing — cannot personalize installs')
        sys.exit(1)

    if STAGE.exists():
        shutil.rmtree(STAGE)
    for rel in WANT:
        s = BASE / 'PineappleFX' / rel.replace('/', os.sep)
        if not s.is_file():
            print('refusing: missing %s' % s)
            sys.exit(1)
        d = STAGE / rel.replace('/', os.sep)
        d.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(s, d)
    (STAGE / 'meta.json').write_text(json.dumps({
        'secret': src_secret, 'verify_url': verify_url, 'version': '2.0.0',
    }), encoding='utf-8')
    print('payload staged (%d files), verify_url=%s' % (len(WANT) + 1, verify_url or '(local-only)'))

    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        print('refusing: pip install pyinstaller first')
        sys.exit(1)

    cmd = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--onefile', '--noconsole',
           '--name', 'PineappleFX-Installer',
           '--add-data', '%s%spayload' % (STAGE, os.pathsep),
           '--distpath', str(BASE / 'build' / 'exe-dist'),
           '--workpath', str(BASE / 'build' / 'exe-work'),
           '--specpath', str(BASE / 'build'),
           str(BASE / 'tools' / 'installer.py')]
    print('running: ' + ' '.join(cmd))
    r = subprocess.run(cmd)
    if r.returncode != 0:
        print('PyInstaller failed')
        sys.exit(1)
    exe = BASE / 'build' / 'exe-dist' / 'PineappleFX-Installer.exe'
    if not exe.is_file():
        print('refusing: exe not produced')
        sys.exit(1)
    dest = BASE / 'downloads' / 'PineappleFX-Installer.exe'
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(exe, dest)
    print('WROTE %s (%.1f MB)' % (dest, dest.stat().st_size / 1e6))


if __name__ == '__main__':
    main()
