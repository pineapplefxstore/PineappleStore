"""Create / promote an admin account in the server DB. PRIVATE tool.

Usage:
  py tools/seed_admin.py admin@mail.com StrongPass123
  DATA_DIR=./data py tools/seed_admin.py admin@mail.com StrongPass123

Writes the SAME scrypt hash format the Node API verifies
(scrypt$n=16384,r=8,p=1,keylen=32$salt$hash), so seeded accounts log in
immediately via /api/auth and pass the is_admin RBAC gate.
Existing DB content is preserved. Never commit the DB file.
"""
import datetime
import hashlib
import json
import os
import pathlib
import secrets
import sys

import re

BASE = pathlib.Path(__file__).resolve().parent.parent
# Works both before (site/data) and after (root data) the Pages move.
DATA_DIRS = [
    pathlib.Path(os.environ.get('DATA_DIR')) if os.environ.get('DATA_DIR') else None,
    BASE / 'data',
    BASE / 'site' / 'data',
]
DATA_DIRS = [d for d in DATA_DIRS if d]
DATA_DIR = DATA_DIRS[0]
DB_FILE = DATA_DIR / 'pfx-db.json'

EMAIL_RE = re.compile(r'^[^\s@]+@[^\s@]+\.[^\s@]+$')
MIN_PASSWORD_LEN = 6


def clean_email(raw):
    return str(raw or '').strip().strip('"\'').lower()


def clean_password(raw):
    return str(raw or '').strip().strip('"\'')


def valid_email(email):
    return bool(EMAIL_RE.match(email))


def valid_password(password):
    return len(password) >= MIN_PASSWORD_LEN


def main():
    if len(sys.argv) < 3:
        print('usage: py tools/seed_admin.py admin@mail.com StrongPass123')
        sys.exit(1)
    email = clean_email(sys.argv[1])
    password = clean_password(sys.argv[2])
    if not valid_email(email) or not valid_password(password):
        print('refusing: bad email or password too short '
              '(need valid email + password of at least %d characters)' % MIN_PASSWORD_LEN)
        sys.exit(1)

    for d in DATA_DIRS:
        d.mkdir(parents=True, exist_ok=True)

    db = json.loads(DB_FILE.read_text(encoding='utf-8')) if DB_FILE.exists() else {}
    for table in ('users', 'licenses', 'machines', 'coupons', 'partners', 'slots', 'audit'):
        db.setdefault(table, {} if table != 'audit' else [])
    db.setdefault('pricing', {'regular': '30.00', 'launch': '20.00',
                              'launchEnd': '2026-11-01T00:00:00Z'})

    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=32)
    users = db['users']
    created = users[email]['created'] if email in users else \
        datetime.datetime.now(datetime.timezone.utc).isoformat()
    users[email] = {
        'email': email,
        'alg': 'scrypt$n=16384,r=8,p=1,keylen=32',
        'salt': salt.hex(),
        'hash': dk.hex(),
        'is_admin': True,
        'created': created,
    }
    db['audit'] = [{'at': created, 'actor': 'seed',
                    'action': 'admin-seeded', 'detail': email}] + db.get('audit', [])
    content = json.dumps(db, indent=2)
    for d in DATA_DIRS:
        try:
            (d / 'pfx-db.json').write_text(content, encoding='utf-8')
        except OSError:
            pass
    print('admin ready: %s  (db: %s)' % (email, DB_FILE))


if __name__ == '__main__':
    main()
