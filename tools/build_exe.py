"""Build PineappleFX-Installer.exe (Windows). Run from the repo root.

Usage:
  py tools/build_exe.py [--verify-url https://host/api/verify-license]

Pipeline:
  1. Stages payload/ = the 7 sealed extension files + meta.json
     (FNV SECRET from tools/mint_key.py + verify URL + version).
  2. Runs PyInstaller --onefile --noconsole with icon & version file.
  3. Applies Windows icon resources and version stamps.
  4. Copies dist/PineappleFX-Installer.exe to downloads/.
"""
import json
import os
import pathlib
import re
import shutil
import struct
import subprocess
import sys
import win32api

BASE = pathlib.Path(__file__).resolve().parent.parent
STAGE = BASE / 'build' / 'exe-payload'
WANT = ['CSXS/manifest.xml', 'dist/index.html', 'dist/logo.png',
        'extendscript/host.jsx', 'extendscript/presets/Chrome.ffx',
        'index.html', 'Public/logo.png']


def stamp_exe(exe_path, ico_path, version_txt):
    """Embeds multi-resolution icons and Windows version info metadata."""
    # 1. Update icon resources
    if ico_path and os.path.exists(ico_path):
        with open(ico_path, 'rb') as f:
            data = f.read()
        reserved, type_, count = struct.unpack('<HHH', data[:6])
        entries = []
        for i in range(count):
            offset = 6 + i * 16
            w, h, c, r, planes, bpp, bytes_in_res, data_offset = struct.unpack('<BBBBHHII', data[offset:offset+16])
            img_bytes = data[data_offset:data_offset+bytes_in_res]
            entries.append({
                'w': w, 'h': h, 'c': c, 'r': r, 'planes': planes, 'bpp': bpp,
                'bytes_in_res': bytes_in_res, 'data': img_bytes
            })
        
        h_update = win32api.BeginUpdateResource(str(exe_path), 0)
        for i, e in enumerate(entries, start=1):
            win32api.UpdateResource(h_update, 3, i, e['data'])
            
        grp_header = struct.pack('<HHH', 0, 1, count)
        grp_entries = bytearray()
        for i, e in enumerate(entries, start=1):
            grp_entries += struct.pack('<BBBBHHIH',
                e['w'], e['h'], e['c'], e['r'], e['planes'], e['bpp'], e['bytes_in_res'], i
            )
        win32api.UpdateResource(h_update, 14, 1, grp_header + bytes(grp_entries))
        win32api.EndUpdateResource(h_update, 0)
        print('Embedded icon resources into %s' % exe_path)

    # 2. Update version info metadata (Publisher, ProductName, etc.)
    if version_txt and os.path.exists(version_txt):
        import PyInstaller.utils.win32.versioninfo as vinfo
        v = vinfo.load_version_info_from_text_file(str(version_txt))
        vinfo.write_version_info_to_executable(str(exe_path), v)
        print('Stamped version metadata into %s' % exe_path)


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

    ico = BASE / 'assets' / 'logo.ico'
    ver_file = BASE / 'tools' / 'version_plugin.txt'

    cmd = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--onefile', '--noconsole',
           '--name', 'PineappleFX-Installer',
           '--icon', str(ico),
           '--version-file', str(ver_file),
           '--add-data', '%s%spayload' % (STAGE, os.pathsep),
           '--add-data', '%s%sassets' % (BASE / 'assets', os.pathsep),
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

    # Re-apply explicit resource stamp
    stamp_exe(exe, ico, ver_file)

    dest = BASE / 'downloads' / 'PineappleFX-Installer.exe'
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(exe, dest)
    print('WROTE %s (%.1f MB)' % (dest, dest.stat().st_size / 1e6))


if __name__ == '__main__':
    main()
