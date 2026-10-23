"""Sync the website's live panel mock with the REAL plugin.

Usage:
  py tools/sync_panel_mock.py

Reads the built panel bundle (PineappleFX/dist/index.html) and rewrites
assets/pfx-panel-data.js with window.PFX_PANEL = {
  version   - from CSXS/manifest.xml
  tabs      - [{id, label}] in panel order (enabled tabs only)
  targets   - the expression "Target property" name list
  i18n      - every English string the mock needs, verbatim from the panel
  presets   - the real preset tables: easing, expressions, text, glass,
              transitions, styles, numbers, devices, tools
}

Function-valued preset fields (expression `generate`) are carried as source
text under "<key>Src" so the mock can rebuild them with `new Function`.

Run this whenever the plugin bundle changes; never hand-edit the output.
"""
import json
import pathlib
import re
import subprocess
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
OUT = BASE / 'assets' / 'pfx-panel-data.js'

# The tab->view contract, taken from the real panel (footer text, action label,
# badge). Mirrors each view's JSX in the bundle; the strings themselves come
# from the panel's own i18n dict, so nothing here is invented.
VIEW_META = {
    'easing':       {'footer': 'bezier_or_spring', 'action': 'action.apply',      'badge': None},
    'text':         {'footer': 'text.footer.in',   'action': 'action.apply',      'badge': None},
    'transitions':  {'footer': 'transitions.footer', 'action': 'action.apply',    'badge': 'transitions.atPlayhead'},
    'glass':        {'footer': 'glass.footer.hasComp', 'action': 'glass.insert',  'badge': None},
    'styles':       {'footer': 'styles.footer.other', 'action': 'action.apply',   'badge': None},
    'expressions':  {'footer': 'expr.footer.auto', 'action': 'action.apply',      'badge': None},
    'numbers':      {'footer': 'numbers.footer',   'action': 'action.apply',      'badge': None},
    'devices':      {'footer': 'devices.footer',   'action': 'glass.insert',      'badge': None},
    'tools':        {'footer': 'requirement',      'action': 'actionLabel',       'badge': None},
}


def read_bundle():
    return (BASE / 'PineappleFX' / 'dist' / 'index.html').read_text(encoding='utf-8')


def match_brace(text, start):
    """Return the slice of `text` from `start` (a '{') through its match."""
    depth = 0
    in_str = None
    in_tpl = False
    i = start
    while i < len(text):
        c = text[i]
        if in_str:
            if c == '\\':
                i += 2
                continue
            if c == in_str:
                in_str = None
            i += 1
            continue
        if in_tpl:
            if c == '\\':
                i += 2
                continue
            if c == '`':
                in_tpl = False
            i += 1
            continue
        if c in '"\'':
            in_str = c
        elif c == '`':
            in_tpl = True
        elif c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
        i += 1
    raise ValueError('unbalanced braces from %d' % start)


def main():
    text = read_bundle()

    # i18n dict: const E0={"key":{en:"...",ru:"..."}, ...} (JS literal -> eval in node)
    m = re.search(r'\bconst E0=\{', text)
    if not m:
        sys.exit('FAIL: i18n dict not found in bundle')
    dict_src = match_brace(text, m.end() - 1)

    # tab order + labels (also a JS literal: {id:"easing",label:"Easing",enabled:!0})
    m2 = re.search(r'\{id:"easing",label:.*?\}\];', text)
    if not m2:
        sys.exit('FAIL: tab list not found in bundle')
    tabs_src = '[' + m2.group(0)[:-2] + ']'

    work = BASE / 'build'
    work.mkdir(exist_ok=True)
    (work / '_mock_dict.js').write_text(dict_src, encoding='utf-8')
    (work / '_mock_tabs.js').write_text(tabs_src, encoding='utf-8')

    # the preset tables, via node (they contain template literals + helpers)
    script = r'''
const fs = require("fs");
const path = require("path");
const repo = process.argv[1];
const src = fs.readFileSync(path.join(repo, "PineappleFX/dist/index.html"), "utf8");
const TABLES = { easing:"Ro", expressions:"To", text:"Fo", glass:"Uo",
                 transitions:"Vo", styles:"Ko", tools:"qo", numbers:"Eo", devices:"Mo" };
// View-level param lists that are NOT per-preset: the Numbers "Format" block
// (mf, an array) and the Devices "Frame" block (eb/bl/nb/rb/ab, single
// objects in declaration order).
const VIEW_PARAMS = { numbers: [["array", "mf"]],
                      devices: [["obj", "eb"], ["obj", "bl"], ["obj", "nb"], ["obj", "rb"], ["obj", "ab"]] };
function sliceBrace(start) {           // start at '[' -> through its match
  let depth = 0, inStr = null, inTpl = false;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (inStr) { if (c === "\\") { j++; continue; } if (c === inStr) inStr = null; continue; }
    if (inTpl) { if (c === "\\") { j++; continue; } if (c === "`") inTpl = false; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "`") { inTpl = true; continue; }
    if (c === "[") depth++;
    else if (c === "]") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error("unbalanced [ at " + start);
}
function sliceObj(start) {             // start at '{' -> through its match
  let depth = 0, inStr = null;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (inStr) { if (c === "\\") { j++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error("unbalanced { at " + start);
}
function extractArray(name) {
  const re = new RegExp("\\b" + name + "=\\[\\s*\\{");
  const m = re.exec(src);
  if (!m) throw new Error("not found: " + name);
  return sliceBrace(m.index + name.length + 1);
}
// `eb={type:...}` -> the object literal (JS, so eval it, not json)
function extractObj(name) {
  const m = new RegExp("[^A-Za-z0-9_$]" + name + "=\\{type").exec(src);
  if (!m) throw new Error("obj not found: " + name);
  return sliceObj(m.index + name.length + 2);
}
function evalJS(s) { return new Function("return (" + s + ")")(); }
const stubHandler = {
  get(t, p) {
    if (p === Symbol.unscopables) return undefined;
    if (p === Symbol.toPrimitive) return () => 0;
    if (p === "toString") return () => "";
    if (p === "length") return 0;
    return stub;
  },
  apply: () => stub, construct: () => stub, has: () => true,
};
const stub = new Proxy(function () {}, stubHandler);
const scope = new Proxy({}, { get: (t, p) => (p === Symbol.unscopables ? undefined : stub), has: () => true });
function serialize(value, depth) {
  if (depth > 6) return undefined;
  if (typeof value === "function") {
    if (value === stub) return undefined;
    const s = String(value);
    return s.length > 8 ? s : undefined;
  }
  if (Array.isArray(value)) return value.map(v => serialize(v, depth + 1)).filter(v => v !== undefined);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) {
      const v = value[k];
      const s = serialize(v, depth + 1);
      if (s === undefined) continue;
      out[typeof v === "function" ? k + "Src" : k] = s;
    }
    return out;
  }
  if (typeof value === "number" && !isFinite(value)) return String(value);
  return value;
}
const out = { presets: {}, targets: [], viewParams: {} };
for (const [tab, name] of Object.entries(TABLES)) {
  const arr = new Function("scope", "with(scope){ return (" + extractArray(name) + ") }")(scope);
  out.presets[tab] = arr.map(p => serialize(p, 0));
}
for (const [tab, spec] of Object.entries(VIEW_PARAMS)) {
  // "array" entries already are a full param list; "obj" entries are single
  // params to be appended in declaration order -> one flat list per tab.
  const flat = [];
  for (const [kind, n] of spec) {
    const v = evalJS(kind === "array" ? extractArray(n) : extractObj(n));
    if (Array.isArray(v)) flat.push.apply(flat, v); else flat.push(v);
  }
  out.viewParams[tab] = flat;
}
// expression "Target property" list (const ze=[...])
const zm = /\bconst ze=\[(.*?)\]/.exec(src);
out.targets = JSON.parse("[" + zm[1] + "]");
process.stdout.write(JSON.stringify(out));
'''
    r = subprocess.run(['node', '-e', script, str(BASE)],
                       capture_output=True, encoding='utf-8', errors='replace')
    if r.returncode != 0:
        sys.exit('FAIL: preset extraction\n' + r.stderr)
    extracted = json.loads(r.stdout)
    presets = extracted['presets']
    targets = extracted['targets']

    # i18n dict + tab list are JS literals -> eval them in node, one file each
    lit = subprocess.run(
        ['node', '-e',
         'const fs=require("fs");'
         'const d=eval("(" + fs.readFileSync(process.argv[1],"utf8") + ")");'
         'const t=eval("(" + fs.readFileSync(process.argv[2],"utf8") + ")");'
         'process.stdout.write(JSON.stringify({dict:d,tabs:t}));',
         str(work / '_mock_dict.js'), str(work / '_mock_tabs.js')],
        capture_output=True, encoding='utf-8', errors='replace')
    if lit.returncode != 0:
        sys.exit('FAIL: i18n/tab parse\n' + lit.stderr[:2000])
    parsed = json.loads(lit.stdout)
    i18n = {k: v['en'] for k, v in parsed['dict'].items() if isinstance(v, dict) and 'en' in v}
    tabs = [{'id': t['id'], 'label': t['label']}
            for t in parsed['tabs'] if t.get('enabled')]

    (work / '_mock_dict.js').unlink(missing_ok=True)
    (work / '_mock_tabs.js').unlink(missing_ok=True)

    manifest = (BASE / 'PineappleFX' / 'CSXS' / 'manifest.xml').read_text(encoding='utf-8')
    version = re.search(r'ExtensionBundleVersion="([^"]+)"', manifest).group(1)

    payload = {
        'version': version,
        'tabs': tabs,
        'targets': targets,
        'i18n': i18n,
        'viewMeta': VIEW_META,
        'presets': presets,
        'viewParams': extracted.get('viewParams', {}),
    }

    body = json.dumps(payload, ensure_ascii=False, indent=1)
    OUT.write_text(
        '/* GENERATED by tools/sync_panel_mock.js - do not edit by hand.\n'
        '   Mirrors the real After Effects panel: same tabs, presets, parameters,\n'
        '   footer strings and button labels, straight from the plugin bundle. */\n'
        'window.PFX_PANEL = ' + body + ';\n',
        encoding='utf-8')
    n = sum(len(v) for v in presets.values())
    print('OK: %s (%d KB, %d presets, %d strings, %d tabs)' % (
        OUT.relative_to(BASE), OUT.stat().st_size // 1024, n, len(i18n), len(tabs)))


if __name__ == '__main__':
    main()
