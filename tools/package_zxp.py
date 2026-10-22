"""Package the release .zxp. Run AFTER build_license.py + protect_gate.py.

Usage:
  py tools/package_zxp.py [--out PineappleFX.zxp]

Writes PineappleFX.zxp at the repo root AND stages a copy at
downloads/PineappleFX.zxp (the website download buttons).

Layout inside the zip (extension root):
  CSXS/manifest.xml, dist/index.html, dist/logo.png,
  extendscript/host.jsx, extendscript/presets/Chrome.ffx,
  index.html, Public/logo.png
Junk (e.g. marg.ing.jfif) is excluded.

NOTE: this zip is UNSIGNED. Install it with PlayerDebugMode enabled
(see install.html) or sign it with Adobe ZXPSignCmd + a real certificate
for signature-enforced environments.
"""
import pathlib
import shutil
import sys
import zipfile

BASE = pathlib.Path(__file__).resolve().parent.parent
SRC = BASE / 'PineappleFX'
JUNK = {'marg.ing.jfif', 'Thumbs.db', '.DS_Store'}

WANT = ['CSXS/manifest.xml', 'dist/index.html', 'dist/logo.png',
        'extendscript/host.jsx', 'extendscript/presets/Chrome.ffx',
        'index.html', 'Public/logo.png']


def collect():
    files = []
    for rel in WANT:
        p = SRC / rel.replace('/', __import__('os').sep)
        if not p.is_file():
            print('refusing: missing source file %s' % p)
            sys.exit(1)
        files.append((p, rel.replace('/', '/')))
    return files


def main():
    out = pathlib.Path(sys.argv[sys.argv.index('--out') + 1]) if '--out' in sys.argv else BASE / 'PineappleFX.zxp'
    files = collect()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p, arc in files:
            z.write(p, arc)
    with zipfile.ZipFile(out) as z:
        assert set(z.namelist()) == set(WANT), 'zip layout drift!'
        gate = z.read('dist/index.html').decode('utf-8', errors='replace')
        assert '<!--PFX-GATE-START-->' in gate, 'gate block missing!'
        assert '/*PFX-SEALED*/' in gate, 'gate NOT sealed — run tools/protect_gate.py first!'
        man = z.read('CSXS/manifest.xml').decode('utf-8', errors='replace')
        assert 'com.pineapplestore.pineapplefx' in man, 'manifest bundle id wrong!'
    staged = BASE / 'downloads' / 'PineappleFX.zxp'
    staged.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(out, staged)
    print('WROTE %s (%.2f MB) + staged %s' % (out, out.stat().st_size / 1e6, staged))


if __name__ == '__main__':
    main()
