"""Recolor the plugin's live-preview box from iOS blue to the PineappleFX gold theme.

Only the four draw calls inside the expressions live-preview component (Iy)
change: the motion trail, its glow, and the two gradient stops. The blue swatch
in the color palette and the style defaults are left alone -- those are user
facing colours, not the preview box.

Byte-safe: exact-string replacement with a balance assertion, because
PineappleFX/dist/index.html is a sealed bundle.
"""
import pathlib

BUNDLE = pathlib.Path("PineappleFX/dist/index.html")

# PineappleFX gold theme (see site/assets/site.css): gold + ink.
REPLACEMENTS = [
    # trail dots
    ('c.fillStyle="#0a84ff"', 'c.fillStyle="#feca08"'),
    # drop shadow / glow
    ('c.shadowColor="rgba(10,132,255,0.35)"', 'c.shadowColor="rgba(254,202,8,0.38)"'),
    # box body gradient (light gold -> deep gold)
    ('Ut.addColorStop(0,"#3aa0ff")', 'Ut.addColorStop(0,"#ffe25c")'),
    ('Ut.addColorStop(1,"#0a6cf0")', 'Ut.addColorStop(1,"#e0a300")'),
]


def main():
    text = BUNDLE.read_text(encoding="utf-8")
    for old, new in REPLACEMENTS:
        n = text.count(old)
        if n != 1:
            raise SystemExit(f"FAIL: expected exactly 1 occurrence of {old!r}, found {n}")
        text = text.replace(old, new)

    # sanity: the sealed gates must survive, and the box must be gold now
    for marker in ("<!--PFX-GATE-START-->", "/*PFX-SEALED*/"):
        if marker not in text:
            raise SystemExit(f"FAIL: sealed marker missing after patch: {marker}")
    if "#3aa0ff" in text or "#0a6cf0" in text:
        raise SystemExit("FAIL: old gradient stops still present")
    if text.count('c.fillStyle="#feca08"') != 1:
        raise SystemExit("FAIL: gold trail not applied")

    BUNDLE.write_text(text, encoding="utf-8", newline="")
    print(f"OK: preview box recolored to gold ({len(text)} bytes)")


if __name__ == "__main__":
    main()
