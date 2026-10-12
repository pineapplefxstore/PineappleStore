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

BASE = pathlib.Path(__file__).resolve().parent.parent
DATA_DIR = pathlib.Path(os.environ.get('DATA_DIR', BASE / 'site' / 'data'))
DB_FILE = DATA_DIR / 'pfx-db.json'


def main():
    if len(sys.argv) < 3:
        print('usage: py tools/seed_admin.py admin@mail.com StrongPass123')
        sys.exit(1)
    email = sys.argv[1].strip().strip('"\'').lower()
    password = sys.argv[2].strip().strip('"\'')
    if '@' not in email or len(password) < 4:
        print('refusing: bad email or password too short')
        sys.exit(1)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ALT_DIR = BASE / 'data'
    ALT_DIR.mkdir(parents=True, exist_ok=True)
    ALT_DB_FILE = ALT_DIR / 'pfx-db.json'

    db = json.loads(DB_FILE.read_text(encoding='utf-8')) if DB_FILE.exists() else {}
    for table in ('users', 'licenses', 'machines', 'coupons', 'audit'):
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
    DB_FILE.write_text(content, encoding='utf-8')
    ALT_DB_FILE.write_text(content, encoding='utf-8')
    print('admin ready: %s  (db: %s)' % (email, DB_FILE))


if __name__ == '__main__':
    main()
