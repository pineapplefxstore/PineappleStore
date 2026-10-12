"""Mint PineappleFX device-bound license keys. PRIVATE - never share this file or the SECRET.
Usage:
  python mint_key.py --device <MACHINEID>     mint one key for a buyer's machine
  python mint_key.py --device <MACHINEID> --email buyer@mail.com
  python mint_key.py --check PFX2-XXXXXXXX-XXXXXXXX --device <MACHINEID>
The buyer finds their Machine ID on the locked panel screen (click it to copy)
and sends it with their email + PayPal transaction id after paying $15."""
import secrets
import sys

SECRET = "7c795771be81002adee1870b7dfbc589"
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
