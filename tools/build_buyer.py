"""Build a personalized, pre-activated .zxp for ONE buyer. PRIVATE tool.
Usage:
  python build_buyer.py --email buyer@mail.com --key PFX2-XXXXXXXX-XXXXXXXX --device ABCD1234
What it does:
  1. Verifies the key is valid FOR that device (refuses to build otherwise).
  2. Copies the extension to a temp dir, bakes in:
     - the license key (panel auto-activates on the buyer's machine only;
       the same file on any other machine stays locked)
     - a visible watermark (Settings > About shows who it is licensed to)
     - an invisible watermark (buyer email hidden in the bundle)
  3. Writes PineappleFX-licensed-<slug>.zxp next to the extension folder.
If this file leaks, the watermark tells you exactly which buyer leaked it.
A leaked copy still cannot be used on other machines (device-bound key)."""
import pathlib
import re
import shutil
import sys
import tempfile
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import mint_key

BASE = pathlib.Path(r'C:\Users\quiff\Downloads\Telegram Desktop\PineappleFX\PineappleFX')
JUNK = {'marg.ing.jfif'}


def main():
    args = sys.argv[1:]
    email = args[args.index('--email') + 1] if '--email' in args else ''
    key = args[args.index('--key') + 1] if '--key' in args else ''
    device = (args[args.index('--device') + 1] if '--device' in args else '').upper()
    if not email or not key or not device:
        print('usage: python build_buyer.py --email buyer@mail --key PFX2-... --device MACHINEID')
        sys.exit(1)
    if '@' not in email or '.' not in email:
        print('refusing: bad email')
        sys.exit(1)
    if not mint_key.check(key, device):
        print('refusing: key is NOT valid for that device')
        sys.exit(1)
    print('key valid for device, building...')

    norm_key = ''.join(c for c in key.upper() if c.isalnum())
    tmp = pathlib.Path(tempfile.mkdtemp(prefix='pfx-buyer-'))
    try:
        for p in sorted(BASE.rglob('*')):
            if p.is_dir() or p.name in JUNK:
                continue
            dest = tmp / p.relative_to(BASE)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, dest)
        dist = tmp / 'dist' / 'index.html'
        h = dist.read_text(encoding='utf-8', errors='ignore')
        # 1) pre-installed key (auto-activates ONLY on buyer's machine)
        assert h.count('var PREKEY = "";') == 1
        h = h.replace('var PREKEY = "";', 'var PREKEY = "%s";' % norm_key)
        # 2) visible watermark: Settings > About > Developer row
        old_dev = 'children:"Pineapple Store"})'
        assert h.count(old_dev) == 1
        h = h.replace(old_dev, 'children:"Pineapple Store \\u00b7 %s"})' % email.replace('"', ''))
        # 3) invisible watermark
        h = h.replace('</head>', '<!-- licensed to %s --></head>' % email, 1)
        dist.write_text(h, encoding='utf-8')

        slug = re.sub(r'[^a-z0-9]+', '-', email.lower()).strip('-')[:40] or 'buyer'
        out = BASE.parent / ('PineappleFX-licensed-%s.zxp' % slug)
        if out.exists():
            out.unlink()
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for f in sorted(tmp.rglob('*')):
                if f.is_file():
                    z.write(f, f.relative_to(tmp).as_posix())
        print('WROTE', out, out.stat().st_size, 'bytes')
        # verify
        with zipfile.ZipFile(out) as z:
            d = z.read('dist/index.html').decode('utf-8', errors='ignore')
            assert norm_key in d and email in d and 'PFX-GATE-START' in d
            print('buyer markers OK — send this .zxp + the key to', email)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    main()
