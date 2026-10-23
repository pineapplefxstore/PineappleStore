/* PineappleFX live panel preview (index page).
   Data-driven: renders straight from window.PFX_PANEL, which tools/sync_panel_mock.js
   generates from the real plugin bundle. Same tabs, presets, parameters, footer
   strings and button labels as the panel inside After Effects. */
(function () {
  var D = window.PFX_PANEL;
  if (!D) return;
  var root = document.getElementById("mPills");
  if (!root) return;
  var main = document.querySelector(".mock-main");
  var listEl = document.getElementById("mList");
  var footEl = document.getElementById("mFoot");
  var applyEl = document.getElementById("mApply");
  var NS = "http://www.w3.org/2000/svg";

  /* graph geometry, taken from the real easing editor (viewBox 360x200, pad 22) */
  var GX = 22, GY = 22, GW = 316, GH = 156;

  var cur = { tab: 0, idx: 0 };
  var vals = {};          /* per-preset parameter values, reset on selection */
  var applyState = null;  /* current footer/button contract for the active view */

  /* ---------- i18n: the panel's own English strings ---------- */
  function y(key, fallback) { var s = D.i18n[key]; return (s === undefined ? (fallback || key) : s); }
  function en(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

  /* ---------- helpers used by the preset code generators ---------- */
  function O(o, k) { var n = o[k]; return typeof n === "number" ? n : Number(n); }
  function uc(o, k) { return String(o[k] === undefined || o[k] === null ? "" : o[k]); }
  function V(x) { if (!isFinite(x)) return "0"; return String(Math.round(x * 1e3) / 1e3); }

  var PF = { none: "", space: " ", comma: ",", dot: ".", apostrophe: "\u2019" };
  var FF = { dot: ".", comma: "," };
  function we(o, k, d) { var v = o[k]; return typeof v === "string" ? v : d; }
  function fn(o, k, d) { var v = o[k], n = typeof v === "number" ? v : Number(v); return isFinite(n) ? n : d; }

  /* number-counter value formatter + expression builder — ported from the panel */
  function pl(val, fmt) {
    var dec = Math.max(0, Math.min(4, Math.round(fn(fmt, "decimals", 0))));
    var pad = Math.max(0, Math.min(8, Math.round(fn(fmt, "pad", 0))));
    var tsep = PF[we(fmt, "thousandSep", "none")] || "";
    var dsep = FF[we(fmt, "decimalSep", "dot")] || ".";
    var pre = we(fmt, "prefix", ""), suf = we(fmt, "suffix", "");
    var gap = we(fmt, "gap", "none") === "space" ? " " : "";
    var neg = val < 0, m = Math.abs(val);
    var fixed = dec > 0 ? m.toFixed(dec) : String(Math.round(m));
    var dotAt = fixed.indexOf(".");
    var ip = dotAt === -1 ? fixed : fixed.slice(0, dotAt);
    var fp = dotAt === -1 ? "" : fixed.slice(dotAt + 1);
    while (ip.length < pad) ip = "0" + ip;
    if (tsep) { var g = "", c = 0; for (var i = ip.length - 1; i >= 0; i--) { g = ip.charAt(i) + g; c++; if (c % 3 === 0 && i > 0) g = tsep + g; } ip = g; }
    var out = fp !== "" ? ip + dsep + fp : ip;
    if (pre !== "") out = pre + gap + out;
    if (suf !== "") out = out + gap + suf;
    if (neg) out = "-" + out;
    return out;
  }
  function bf(e) {
    var t = we(e, "ease", "ease"), n = t === "linear" ? "linear" : t;
    var r = PF[we(e, "thousandSep", "none")] || "";
    var a = FF[we(e, "decimalSep", "dot")] || ".";
    var i = we(e, "gap", "none") === "space" ? " " : "";
    return [
      "// PineappleFX \u00b7 Number Counter",
      "// Start / End / Duration / Decimals / Leading Zeros are live on this layer.",
      "var TSEP = " + JSON.stringify(r) + ";",
      "var DSEP = " + JSON.stringify(a) + ";",
      "var PRE  = " + JSON.stringify(we(e, "prefix", "")) + ";",
      "var SUF  = " + JSON.stringify(we(e, "suffix", "")) + ";",
      "var GAP  = " + JSON.stringify(i) + ";",
      "",
      'var s = effect("PineappleFX Start")(1);',
      'var e = effect("PineappleFX End")(1);',
      'var d = Math.max(0.001, effect("PineappleFX Duration")(1));',
      'var dec = Math.max(0, Math.min(4, Math.round(effect("PineappleFX Decimals")(1))));',
      'var pad = Math.max(0, Math.min(8, Math.round(effect("PineappleFX Leading Zeros")(1))));',
      "",
      "var t = time - inPoint;",
      "var v = " + n + "(t, 0, d, s, e);",
      "",
      "var neg = v < 0;",
      "var m = Math.abs(v);",
      "var fixed = dec > 0 ? m.toFixed(dec) : String(Math.round(m));",
      'var dotAt = fixed.indexOf(".");',
      'var ip = dotAt === -1 ? fixed : fixed.substring(0, dotAt);',
      'var fp = dotAt === -1 ? "" : fixed.substring(dotAt + 1);',
      "",
      'while (ip.length < pad) ip = "0" + ip;',
      "",
      'if (TSEP !== "") {',
      '  var g = "";',
      "  var c = 0;",
      "  for (var i = ip.length - 1; i >= 0; i--) {",
      "    g = ip.charAt(i) + g;",
      "    c++;",
      "    if (c % 3 === 0 && i > 0) g = TSEP + g;",
      "  }",
      "  ip = g;",
      "}",
      "",
      'var out = fp !== "" ? ip + DSEP + fp : ip;',
      'if (PRE !== "") out = PRE + GAP + out;',
      'if (SUF !== "") out = out + GAP + SUF;',
      "// Sign outside the affixes: -$1,234.56, never $-1,234.56.",
      'if (neg) out = "-" + out;',
      "out;"
    ].join("\n");
  }
  function Y1(t, dur, ease) {
    var r = Math.max(0, Math.min(1, dur > 0 ? t / dur : 1));
    switch (ease) { case "linear": return r; case "easeIn": return r * r; case "easeOut": return 1 - (1 - r) * (1 - r); default: return r * r * (3 - 2 * r); }
  }

  /* ---------- one-shot CSS for the demo stages ---------- */
  (function () {
    if (document.getElementById("mDemoCss")) return;
    var st = document.createElement("style"); st.id = "mDemoCss";
    st.textContent =
      ".mock-list i .msub{display:block;font-size:9.5px;opacity:.7;margin-top:2px;line-height:1.2;}" +
      ".mock-list i.on .msub{opacity:.75;}" +
      ".mhead h4{margin:0;font-size:14px;font-weight:600;color:var(--mock-txt);}" +
      ".mhead p{margin:4px 0 0;font-size:11.5px;line-height:1.55;color:var(--mock-dim);}" +
      ".mcap{font-size:9.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--mock-dim);margin:0 0 7px;font-weight:700;}" +
      ".mbadge{display:inline-block;font-size:9.5px;color:#feca08;border:1px solid rgba(254,202,8,.45);border-radius:999px;padding:1px 8px;margin-left:8px;vertical-align:middle;font-weight:600;}" +
      ".mchips{display:flex;flex-wrap:wrap;gap:5px;}" +
      ".mchip{font-style:normal;padding:4px 11px;border-radius:8px;border:1px solid var(--mock-line);color:var(--mock-dim);cursor:pointer;font-size:11px;background:var(--mock-card);}" +
      ".mchip:hover{color:var(--mock-txt);}" +
      ".mchip.on{background:#feca08;color:#241a04;border-color:#feca08;font-weight:600;}" +
      ".mnum{width:66px;background:transparent;border:1px solid transparent;border-radius:5px;color:var(--mock-txt);font-family:ui-monospace,monospace;font-size:11px;text-align:right;outline:none;padding:2px 4px;}" +
      ".mnum:focus{border-color:var(--mock-line);background:var(--mock-card);}" +
      ".munit{color:var(--mock-dim);font-size:10.5px;min-width:14px;}" +
      ".mtxt{width:120px;background:var(--mock-card);border:1px solid var(--mock-line);border-radius:6px;color:var(--mock-txt);font-size:11px;padding:4px 7px;outline:none;}" +
      ".mdetail{display:flex;justify-content:space-between;align-items:baseline;padding:5px 0;font-size:11.5px;color:var(--mock-dim);}" +
      ".mdetail span:last-child{font-family:ui-monospace,monospace;color:var(--mock-txt);}" +
      ".mhint{font-size:10.5px;color:var(--mock-dim);margin-top:7px;line-height:1.5;}" +
      ".mstage{background:var(--mock-card);border:1px solid var(--mock-line);border-radius:12px;min-height:150px;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;}" +
      ".mstage .tx{font-size:34px;font-weight:800;letter-spacing:-1px;color:var(--mock-txt);}" +
      "@keyframes mSlideUp{from{opacity:0;transform:translateY(var(--dist,60px));}to{opacity:1;transform:none;}}" +
      "@keyframes mFade{from{opacity:0;}to{opacity:1;}}" +
      "@keyframes mBounce{0%{opacity:0;transform:translateY(var(--dist,60px));}60%{opacity:1;transform:translateY(calc(var(--dist,60px) * -.25));}80%{transform:translateY(calc(var(--dist,60px) * .1));}100%{opacity:1;transform:none;}}" +
      "@keyframes mType{from{width:0;}to{width:10ch;}}" +
      ".mglassbg{background:linear-gradient(135deg,#ff9f0a,#ff375f 40%,#5e5ce6 75%,#0a84ff);}" +
      ".mart{background:conic-gradient(from 40deg,#ff9f0a,#ff375f,#bf5af2,#0a84ff,#30d158,#ff9f0a);}" +
      ".mphone{background:#111;border:1px solid #48484c;position:relative;}" +
      ".mscreen{position:absolute;overflow:hidden;background:linear-gradient(180deg,#2c2c30,#101014);}" +
      ".misland{background:#000;position:absolute;left:50%;transform:translateX(-50%);}" +
      ".mpre{background:#141416;border:1px solid var(--mock-line);border-radius:10px;padding:12px;font-family:ui-monospace,monospace;font-size:10.5px;line-height:1.6;color:#e8e8e6;white-space:pre;overflow:auto;max-height:190px;margin:0;}" +
      ".mcodehead{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;}" +
      ".mcopy{font-style:normal;font-size:10.5px;color:var(--mock-dim);cursor:pointer;border:1px solid var(--mock-line);border-radius:999px;padding:2px 10px;background:var(--mock-card);}" +
      ".mcopy:hover{color:#feca08;border-color:#feca08;}";
    document.head.appendChild(st);
  })();

  /* ---------- shared UI bits ---------- */
  function toast(msg) {
    var t = document.getElementById("mToast");
    if (!t) {
      t = document.createElement("div"); t.id = "mToast";
      t.style.cssText = "position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#1e1e22;color:#f5f5f4;border:1px solid #feca08;border-radius:999px;padding:10px 22px;font-size:13px;font-weight:600;z-index:99;box-shadow:0 12px 30px rgba(0,0,0,.5);white-space:nowrap;";
      document.body.appendChild(t);
    }
    t.textContent = msg; t.style.display = "block";
    clearTimeout(t.__h); t.__h = setTimeout(function () { t.style.display = "none"; }, 2800);
  }
  function copyText(txt, msg) {
    function done() { toast(msg || "Copied."); }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt).then(done, done); return; }
      var ta = document.createElement("textarea"); ta.value = txt; document.body.appendChild(ta);
      ta.select(); try { document.execCommand("copy"); } catch (e) {}
      document.body.removeChild(ta); done();
    } catch (e) { done(); }
  }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function svgEl(n, attrs) {
    var e = document.createElementNS(NS, n);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  /* ---------- parameter widgets (match the panel's renderers) ---------- */
  function numRow(p, value, onChange) {
    var wrap = el("div", "prow");
    var lab = el("b"); lab.textContent = y("__lbl_" + p.id, p.label);
    wrap.appendChild(lab);
    var sl = el("span", "mslider");
    var inp = document.createElement("input");
    inp.className = "mnum"; inp.type = "number";
    inp.min = p.min; inp.max = p.max; inp.step = p.step;
    if (p.decimals !== undefined) inp.setAttribute("data-dec", p.decimals);
    var unit = el("span", "munit"); unit.textContent = p.unit || "";
    function paint() {
      var v = Math.max(p.min, Math.min(p.max, value));
      var t = p.max > p.min ? (v - p.min) / (p.max - p.min) : 0;
      sl.style.setProperty("--f", (t * 100).toFixed(1) + "%");
      if (document.activeElement !== inp) inp.value = p.decimals !== undefined ? (+v).toFixed(p.decimals) : (+v).toFixed(2).replace(/\.?0+$/, "") || "0";
      return v;
    }
    function fromPointer(e) {
      var r = sl.getBoundingClientRect();
      var t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      var raw = p.min + t * (p.max - p.min);
      if (p.step && p.step >= 1) raw = Math.round(raw / p.step) * p.step;
      onChange(+raw.toFixed(4)); paint();
    }
    sl.style.cursor = "pointer"; sl.style.touchAction = "none";
    sl.addEventListener("pointerdown", function (e) {
      try { sl.setPointerCapture(e.pointerId); } catch (_) {}
      fromPointer(e);
      function mv(ev) { fromPointer(ev); }
      function up() { sl.removeEventListener("pointermove", mv); sl.removeEventListener("pointerup", up); }
      sl.addEventListener("pointermove", mv); sl.addEventListener("pointerup", up);
    });
    inp.addEventListener("change", function () {
      var v = Number(inp.value);
      if (isFinite(v)) { onChange(Math.max(p.min, Math.min(p.max, v))); paint(); }
      else paint();
    });
    if (p.inputOnly) { /* number-only param: no rail, like the panel's inputOnly rows */ }
    else wrap.appendChild(sl);
    wrap.appendChild(inp); wrap.appendChild(unit);
    wrap.__paint = paint; paint();
    return wrap;
  }
  function enumRow(p, value, onChange) {
    var wrap = el("div", "prow");
    wrap.style.alignItems = "flex-start";
    var lab = el("b"); lab.textContent = p.label;
    wrap.appendChild(lab);
    var chips = el("span", "mchips");
    (p.options || []).forEach(function (o) {
      var c = el("i", "mchip");
      c.textContent = o.label;
      if (o.value === value) c.className = "mchip on";
      c.onclick = function () {
        Array.prototype.forEach.call(chips.children, function (x) { x.classList.remove("on"); });
        c.classList.add("on"); onChange(o.value);
      };
      chips.appendChild(c);
    });
    wrap.appendChild(chips);
    return wrap;
  }
  function colorRow(p, value, onChange) {
    var wrap = el("div", "prow");
    var lab = el("b"); lab.textContent = p.label;
    wrap.appendChild(lab);
    var sw = el("span", "swatch");
    sw.style.background = value; sw.style.cursor = "pointer";
    sw.title = y("common.pickColor");
    var hx = el("span"); hx.style.cssText = "font-family:ui-monospace,monospace;font-size:11px;";
    hx.textContent = String(value).toUpperCase();
    var ci = document.createElement("input");
    ci.type = "color"; ci.value = value; ci.style.display = "none";
    document.body.appendChild(ci);
    sw.onclick = function () { ci.click(); };
    ci.oninput = function () { onChange(ci.value); sw.style.background = ci.value; hx.textContent = ci.value.toUpperCase(); };
    wrap.appendChild(sw); wrap.appendChild(hx);
    return wrap;
  }
  function textRow(p, value, onChange) {
    var wrap = el("div", "prow");
    var lab = el("b"); lab.textContent = p.label;
    wrap.appendChild(lab);
    var inp = document.createElement("input");
    inp.className = "mtxt"; inp.type = "text";
    inp.maxLength = p.maxLength || 8; inp.spellcheck = false;
    inp.placeholder = p.placeholder || "";
    inp.value = value;
    inp.oninput = function () { onChange(inp.value); };
    wrap.appendChild(inp);
    return wrap;
  }
  function paramRow(p, value, onChange) {
    if (p.type === "number") return numRow(p, typeof value === "number" ? value : Number(p.default), onChange);
    if (p.type === "enum") return enumRow(p, typeof value === "string" ? value : p.default, onChange);
    if (p.type === "color") return colorRow(p, typeof value === "string" ? value : p.default, onChange);
    return textRow(p, typeof value === "string" ? value : p.default, onChange);
  }
  function defaultsOf(params) {
    var o = {};
    (params || []).forEach(function (p) { o[p.id] = p.default; });
    return o;
  }

  /* ---------- easing curve ---------- */
  function springPath(freq, damping) {
    var pts = [], lo = 0, hi = 1, b, v, i;
    for (i = 0; i <= 200; i++) {
      v = i / 200 * 1.4;
      b = 1 - Math.exp(-damping * v) * Math.cos(freq * 2 * Math.PI * v);
      if (b < lo) lo = b; if (b > hi) hi = b;
    }
    var pad = 0.1, lo2 = Math.min(0, lo) - pad, hi2 = Math.max(1, hi) + pad, d = "";
    for (i = 0; i <= 200; i++) {
      v = i / 200 * 1.4;
      b = 1 - Math.exp(-damping * v) * Math.cos(freq * 2 * Math.PI * v);
      d += (i ? " L" : "M") + (GX + v / 1.4 * GW).toFixed(1) + " " + (GY + (1 - (b - lo2) / (hi2 - lo2)) * GH).toFixed(1);
    }
    return d;
  }
  function drawCurve(box, preset, curve, onCurveChange) {
    box.innerHTML = "";
    var svg = svgEl("svg", { viewBox: "0 0 360 200", width: "100%", height: "150", preserveAspectRatio: "xMidYMid meet" });
    svg.style.overflow = "visible";
    var g, i;
    for (i = 0; i <= 4; i++) { g = GX + GW / 4 * i; svg.appendChild(svgEl("line", { x1: g, x2: g, y1: GY, y2: GY + GH, stroke: "#3a3a3f", "stroke-width": 1, opacity: i === 0 || i === 4 ? .7 : .25 })); }
    for (i = 0; i <= 4; i++) { g = GY + GH / 4 * i; svg.appendChild(svgEl("line", { x1: GX, x2: GX + GW, y1: g, y2: g, stroke: "#3a3a3f", "stroke-width": 1, opacity: i === 0 || i === 4 ? .7 : .25 })); }
    var X = function (v) { return GX + v * GW; }, Y = function (v) { return GY + (1 - v) * GH; };

    if (preset.type === "spring") {
      svg.appendChild(svgEl("path", { d: springPath(preset.freq, preset.damping), fill: "none", stroke: "#feca08", "stroke-width": 2.5, "stroke-linecap": "round" }));
    } else {
      var c = curve || preset.curve;
      var ax = X(0), ay = Y(0), bx = X(1), by = Y(1);
      /* the four pieces that move while a handle is dragged; they are updated
         in place so the SVG is never destroyed mid-drag (which would break
         pointer capture). A full render() happens only on pointerup. */
      var l1 = svgEl("line", { stroke: "#717171", "stroke-dasharray": "3 3" });
      var l2 = svgEl("line", { stroke: "#717171", "stroke-dasharray": "3 3" });
      var path = svgEl("path", { fill: "none", stroke: "#feca08", "stroke-width": 2.5, "stroke-linecap": "round" });
      svg.appendChild(l1); svg.appendChild(l2); svg.appendChild(path);
      svg.appendChild(svgEl("circle", { cx: ax, cy: ay, r: 3, fill: "#f2f2f0" }));
      svg.appendChild(svgEl("circle", { cx: bx, cy: by, r: 3, fill: "#f2f2f0" }));
      var parts = [1, 2].map(function () {
        var hit = svgEl("circle", { r: 12, fill: "transparent", style: "cursor:grab;touch-action:none" });
        var dot = svgEl("circle", { r: 5, fill: "#feca08", stroke: "#f2f2f0", "stroke-width": 2, "pointer-events": "none" });
        svg.appendChild(hit); svg.appendChild(dot);
        return { hit: hit, dot: dot };
      });
      function applyCurve(nc) {
        c = nc;
        l1.setAttribute("x1", ax); l1.setAttribute("y1", ay);
        l1.setAttribute("x2", X(nc.x1)); l1.setAttribute("y2", Y(nc.y1));
        l2.setAttribute("x1", bx); l2.setAttribute("y1", by);
        l2.setAttribute("x2", X(nc.x2)); l2.setAttribute("y2", Y(nc.y2));
        path.setAttribute("d", "M " + ax + " " + ay + " C " + X(nc.x1) + " " + Y(nc.y1) + " " + X(nc.x2) + " " + Y(nc.y2) + " " + bx + " " + by);
        [[nc.x1, nc.y1], [nc.x2, nc.y2]].forEach(function (pt, k) {
          parts[k].hit.setAttribute("cx", X(pt[0])); parts[k].hit.setAttribute("cy", Y(pt[1]));
          parts[k].dot.setAttribute("cx", X(pt[0])); parts[k].dot.setAttribute("cy", Y(pt[1]));
        });
      }
      applyCurve(c);
      parts.forEach(function (part, k) {
        part.hit.addEventListener("pointerdown", function (e) {
          e.preventDefault();
          try { part.hit.setPointerCapture(e.pointerId); } catch (_) {}
          function mv(ev) {
            var r = svg.getBoundingClientRect();
            var sc = Math.min(r.width / 360, r.height / 200);
            var px = (ev.clientX - r.left - (r.width - 360 * sc) / 2) / sc;
            var py = (ev.clientY - r.top - (r.height - 200 * sc) / 2) / sc;
            var nx = Math.max(0, Math.min(1, (px - GX) / GW));
            var ny = Math.max(-1, Math.min(2, (GY - py) / GH));
            applyCurve(k === 0 ? { x1: +nx.toFixed(3), y1: +ny.toFixed(3), x2: c.x2, y2: c.y2 }
                               : { x1: c.x1, y1: c.y1, x2: +nx.toFixed(3), y2: +ny.toFixed(3) });
          }
          function up(ev) {
            part.hit.removeEventListener("pointermove", mv);
            part.hit.removeEventListener("pointerup", up);
            try { part.hit.releasePointerCapture(ev.pointerId); } catch (_) {}
            if (onCurveChange) onCurveChange(c);
          }
          part.hit.addEventListener("pointermove", mv);
          part.hit.addEventListener("pointerup", up);
        });
      });
    }
    box.appendChild(svg);
  }

  /* ---------- stage helpers ---------- */
  function stage(html, minH) {
    var s = el("div", "mstage", html);
    if (minH) s.style.minHeight = minH + "px";
    return s;
  }
  function replayBtn(label, fn) {
    var b = el("span", "mcopy");
    b.textContent = label; b.style.cssText += "font-size:11px;padding:4px 13px;";
    b.onclick = fn;
    return b;
  }
  function section(title, node, bare) {
    var w = el("div");
    w.style.margin = "14px 0 0";
    if (!bare) { var c = el("p", "mcap"); c.textContent = title; w.appendChild(c); }
    w.appendChild(node);
    return w;
  }

  /* =========================================================
     VIEWS — one per tab, each mirroring the real panel
     ========================================================= */
  var VIEWS = [

    /* --- Easing: curve editor + Details + spring/bezier footer --- */
    function (p, st) {
      var edited = st.values.__curve !== null && st.values.__curve !== undefined;
      var head = el("div");
      head.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;";
      var cap = el("p", "mcap"); cap.textContent = y("easing.curve"); cap.style.margin = "0";
      head.appendChild(cap);
      if (edited) {
        var reset = el("span", "mcopy");
        reset.textContent = y("easing.resetTo") + " " + p.label;
        reset.onclick = function () { st.values.__curve = null; render(); };
        head.appendChild(reset);
      }
      main.appendChild(head);
      var box = el("div", "mock-curve");
      main.appendChild(box);
      drawCurve(box, p, st.values.__curve, function (c) { st.values.__curve = c; render(); });

      var h = el("div", "mhead");
      h.style.marginTop = "12px";
      h.innerHTML = "<h4>" + p.label + (edited ? ' <span class="mbadge">' + y("easing.edited") + "</span>" : "") + "</h4><p>" + p.description + "</p>";
      main.appendChild(h);

      /* Details: cubic-bezier readout, or the spring's damping + frequency */
      var det = el("div");
      det.style.marginTop = "12px";
      var dc = el("p", "mcap"); dc.textContent = y("common.details"); det.appendChild(dc);
      if (p.type === "spring") {
        det.appendChild(el("div", "mdetail", "<span>" + y("easing.damping") + "</span><span>" + p.damping + "</span>"));
        det.appendChild(el("div", "mdetail", "<span>" + y("easing.frequency") + "</span><span>" + p.freq + " Hz</span>"));
      } else {
        var c = st.values.__curve || p.curve;
        det.appendChild(el("div", "mdetail", "<span>cubic-bezier</span><span>" + [c.x1, c.y1, c.x2, c.y2].map(V).join(", ") + "</span>"));
        if (edited) det.appendChild(el("p", "mhint", y("easing.dragHint")));
      }
      main.appendChild(det);

      applyState = {
        foot: p.type === "spring" ? y("easing.footer.spring") : y("easing.footer.bezier"),
        label: y("action.apply"),
        title: y("easing.applyTitle"),
        run: function () {
          toast(p.type === "spring"
            ? y("common.applied") + " " + p.label + " \u2014 " + en(4, "prop")
            : y("common.applied") + " " + p.label + " \u2014 " + en(8, "key"));
        }
      };
    },

    /* --- Text: live preview + Replay + per-preset parameters --- */
    function (p, st) {
      main.appendChild(head(p));
      /* Per-preset demo copy. Showing the same word for all 25 effects makes
         the previews look dead — each one now demos copy that suits it. */
      var TEXT_DEMOS = {
        "hero-reveal": "PineappleFX", "slide-up": "PineappleFX", "slide": "PineappleFX",
        "scale-bounce": "Boom.", "color-scale": "Colorful", "skew-color": "Skewed",
        "word-stagger": "Word by word", "letter-stagger": "Letter by letter",
        "word-bounce": "Bouncy words", "burst": "Burst", "typewriter": "Typing...",
        "bounce-up": "Up we go", "bounce-rotate": "Twist", "soft-bounce": "Softly",
        "iris": "Iris", "number-counter": "100", "elastic-in": "Elastic",
        "scramble": "Xk#9Pineapple", "fade-chars": "Fade in", "fade-words": "Fade words",
        "rise-chars": "Rise", "drop-chars": "Drop", "scale-chars": "Scale",
        "spin-chars": "Spin", "blur-words": "Blurred"
      };
      var demoText = TEXT_DEMOS[p.id] || "PineappleFX";
      var s = stage('<div class="tx">' + demoText + "</div>", 170);
      main.appendChild(section(y("common.livePreview"), s, true));

      function play() {
        var t = s.querySelector(".tx"); if (!t) return;
        var label = (p.label + " " + p.subtitle).toLowerCase();
        var anim = /type|scramble/.test(label) ? "mType" : /bounce|burst|elastic|soft/.test(label) ? "mBounce" : /fade/.test(label) ? "mFade" : "mSlideUp";
        var mono = /type|scramble/.test(label);
        t.style.fontFamily = mono ? "ui-monospace,monospace" : "inherit";
        t.style.overflow = mono ? "hidden" : "visible";
        t.style.whiteSpace = mono ? "nowrap" : "normal";
        t.style.setProperty("--dist", (st.values.distance || 60) + "px");
        t.style.animation = "none"; void t.offsetWidth;
        t.style.animation = anim + " " + (st.values.duration || .9) + "s cubic-bezier(.3,1.3,.4,1) both";
      }
      var rw = el("div");
      rw.style.cssText = "display:flex;justify-content:flex-end;margin-top:10px;";
      rw.appendChild(replayBtn(y("common.replay"), play));
      main.appendChild(rw);

      main.appendChild(section(y("common.parameters"), paramsBlock(p, st)));
      play();

      applyState = {
        foot: y("text.footer.in"),
        label: y("action.apply"),
        run: function () { toast(y("common.applied") + " " + p.label + " \u2014 " + en(1, "layer")); }
      };
    },

    /* --- Transitions: preview at the playhead + duration --- */
    function (p, st) {
      main.appendChild(head(p, y("transitions.atPlayhead")));
      var s = stage('<div id="mCard" style="background:linear-gradient(135deg,#feca08,#ff8a3d);border-radius:12px;padding:20px 32px;font-weight:800;color:#241a04;">Pineapple</div>', 170);
      main.appendChild(section(y("common.livePreview"), s, true));
      var rw = el("div");
      rw.style.cssText = "display:flex;justify-content:flex-end;margin-top:10px;";
      rw.appendChild(replayBtn(y("common.replay"), play));
      main.appendChild(rw);
      function play() {
        var card = s.querySelector("#mCard"); if (!card || !card.animate) return;
        var label = p.label.toLowerCase();
        var keyframes = /spin/.test(label) ? [{ opacity: 0, transform: "rotate(-90deg) scale(.6)" }, { opacity: 1, transform: "none" }]
          : /blur/.test(label) ? [{ opacity: 0, filter: "blur(14px)" }, { opacity: 1, filter: "blur(0)" }]
          : /iris/.test(label) ? [{ opacity: 0, transform: "scale(.2)" }, { opacity: 1, transform: "none" }]
          : /side|slide/.test(label) ? [{ opacity: 0, transform: "translateX(-46px)" }, { opacity: 1, transform: "none" }]
          : /rise/.test(label) ? [{ opacity: 0, transform: "translateY(42px)" }, { opacity: 1, transform: "none" }]
          : [{ opacity: 0 }, { opacity: 1 }];
        var ms = (st.values.duration || .6) * 1000;
        var an = card.animate(keyframes, { duration: ms, easing: "cubic-bezier(.3,1.3,.4,1)", fill: "forwards" });
        if (an && an.finished) an.finished.then(function () { setTimeout(function () { card.animate([{ opacity: 1 }], { duration: 1, fill: "forwards" }); }, 400); });
      }
      main.appendChild(section(y("common.parameters"), paramsBlock(p, st)));
      play();

      applyState = {
        foot: y("transitions.footer"),
        label: y("action.apply"),
        run: function () { toast(y("common.applied") + " " + p.label + " \u2014 " + en(1, "layer")); }
      };
    },

    /* --- Glass: refracting card + rig parameters + Insert --- */
    function (p, st) {
      main.appendChild(head(p));
      var s = stage('<div id="mFrost" style="padding:24px 38px;font-weight:800;font-size:20px;color:#fff;border-radius:16px;">Glass</div>', 170);
      s.classList.add("mglassbg");
      main.appendChild(section(y("common.livePreview"), s, true));
      function paint() {
        var f = s.querySelector("#mFrost"); if (!f) return;
        var v = st.values;
        var blur = (v.blur !== undefined ? v.blur : 18);
        var sat = (v.saturation !== undefined ? v.saturation : 150);
        var tint = v.tint || "#88c0ff";
        f.style.background = tint.replace(")", "") && /^#/.test(tint) ? hexA(tint, .22) : "rgba(255,255,255,.14)";
        f.style.backdropFilter = "blur(" + blur + "px) saturate(" + sat + "%)";
        f.style.webkitBackdropFilter = f.style.backdropFilter;
        f.style.border = "1px solid rgba(255,255,255,.35)";
        f.style.boxShadow = "inset 0 1px 0 rgba(255,255,255,.4), 0 8px 24px rgba(0,0,0,.25)";
      }
      function hexA(hex, a) {
        var t = hex.replace("#", "");
        if (t.length === 3) t = t.split("").map(function (c) { return c + c; }).join("");
        var r = parseInt(t.slice(0, 2), 16), g = parseInt(t.slice(2, 4), 16), b = parseInt(t.slice(4, 6), 16);
        return "rgba(" + r + "," + g + "," + b + "," + a + ")";
      }
      main.appendChild(section(y("common.parameters"), paramsBlock(p, st, paint)));
      paint();

      applyState = {
        foot: y("glass.footer.hasComp"),
        label: y("glass.insert"),
        run: function () { toast(y("glass.added") + " " + p.label + " " + y("glass.toComp")); }
      };
    },

    /* --- Styles: graded art + style parameters --- */
    function (p, st) {
      main.appendChild(head(p));
      var s = stage('<div id="mArt" class="mart" style="width:220px;height:120px;border-radius:12px;"></div>', 170);
      main.appendChild(section(y("common.livePreview"), s, true));
      var label = (p.label + " " + p.subtitle).toLowerCase();
      function filter() {
        var a = s.querySelector("#mArt"); if (!a) return;
        var x = (st.values.intensity !== undefined ? st.values.intensity : 70) / 100;
        var d = st.values.distance !== undefined ? st.values.distance : 12;
        var soft = st.values.softness !== undefined ? st.values.softness : 35;
        var op = st.values.opacity !== undefined ? st.values.opacity : 30;
        if (/glow|sweep|streak|light/.test(label)) a.style.filter = "saturate(" + (1 + .3 * x) + ") brightness(" + (1 + .18 * x) + ")";
        else if (/duotone|tint/.test(label)) a.style.filter = "grayscale(.75) sepia(" + x + ") hue-rotate(" + (-14 * x * 10) + "deg)";
        else if (/saturation/.test(label)) a.style.filter = "saturate(" + (1 + x) + ")";
        else if (/shadow|hairline|highlight/.test(label)) a.style.filter = "contrast(" + (1 + .22 * x) + ") drop-shadow(0 " + (d / 4) + "px " + (soft / 3) + "px rgba(0,0,0," + (op / 100) + "))";
        else a.style.filter = "sepia(" + (.7 * x) + ") saturate(" + (1 + x) + ") contrast(" + (1 + .3 * x) + ")";
      }
      main.appendChild(section(y("common.parameters"), paramsBlock(p, st, filter)));
      filter();

      applyState = {
        foot: y("styles.footer.other"),
        label: y("action.apply"),
        run: function () { toast(y("common.applied") + " " + p.label + " \u2014 " + en(1, "layer")); }
      };
    },

    /* --- Expressions: live preview + the panel's own generated code --- */
    function (p, st) {
      main.appendChild(head(p));
      var s = stage('<div class="tx" style="font-size:28px;">Pineapple</div>', 130);
      main.appendChild(section(y("common.livePreview"), s, true));

      /* Live code — generated by the preset's real `generate` source */
      var code = "";
      try {
        var gen = new Function("V", "O", "uc", "return (" + p.generateSrc + ");")(V, O, uc);
        code = gen(st.values);
      } catch (e) { code = ""; }
      if (!code && p.signature) code = "// " + p.label + "\n" + p.signature + ";";
      var pre = el("pre", "mpre"); pre.textContent = code;
      var headWrap = el("div", "mcodehead");
      headWrap.innerHTML = '<span class="mcap" style="margin:0;">' + y("expr.liveCode") + "</span>";
      var cp = el("span", "mcopy"); cp.textContent = "Copy";
      cp.onclick = function () { copyText(pre.textContent, "Expression copied."); };
      headWrap.appendChild(cp);
      var codeWrap = el("div"); codeWrap.style.marginTop = "14px";
      codeWrap.appendChild(headWrap); codeWrap.appendChild(pre);
      main.appendChild(codeWrap);

      /* Target property */
      var tgt = el("div");
      tgt.style.marginTop = "14px";
      tgt.appendChild(el("p", "mcap", y("expr.target")));
      var chips = el("div", "mchips");
      var targets = ["auto"].concat(D.targets || []);
      targets.forEach(function (t) {
        var c = el("i", "mchip");
        c.textContent = t === "auto" ? y("expr.auto") : t.replace(/^ADBE /, "");
        if ((st.values.__target || "auto") === t) c.className = "mchip on";
        c.onclick = function () {
          st.values.__target = t;
          Array.prototype.forEach.call(chips.children, function (x) { x.classList.remove("on"); });
          c.classList.add("on");
          applyState.foot = t === "auto" ? y("expr.footer.auto") : y("expr.footer.target") + " " + t.replace(/^ADBE /, "") + ".";
          if (footEl) footEl.textContent = applyState.foot;
        };
        chips.appendChild(c);
      });
      tgt.appendChild(chips);
      main.appendChild(tgt);

      if (p.params && p.params.length) main.appendChild(section(y("common.parameters"), paramsBlock(p, st, function () { render(); })));

      applyState = {
        foot: y("expr.footer.auto"),
        label: y("action.apply"),
        run: function () { toast(y("common.applied") + " " + p.label + " \u2014 " + en(1, "prop")); }
      };
    },

    /* --- Numbers: animated counter + Format + the real AE expression --- */
    function (p, st) {
      main.appendChild(head(p));
      var s = stage('<div id="mNum" style="font-family:ui-monospace,monospace;font-size:44px;font-weight:800;color:#feca08;">0</div>', 150);
      main.appendChild(section(y("common.livePreview"), s, true));

      var fmt = st.values;
      function run() {
        var node = s.querySelector("#mNum"); if (!node) return;
        var from = st.values.reverse === "on" ? st.values.end : st.values.start;
        var to = st.values.reverse === "on" ? st.values.start : st.values.end;
        var dur = (st.values.duration || 2) * 1000, t0 = null;
        function frame(t) {
          if (t0 === null) t0 = t;
          var e = Y1(t - t0, dur, st.values.ease || "ease");
          node.textContent = pl(from + (to - from) * e, fmt);
          if (t - t0 < dur) requestAnimationFrame(frame);
        }
        if (window.requestAnimationFrame) requestAnimationFrame(frame);
        else node.textContent = pl(to, fmt);
      }
      var rw = el("div");
      rw.style.cssText = "display:flex;justify-content:flex-end;margin-top:10px;";
      rw.appendChild(replayBtn(y("common.replay"), run));
      main.appendChild(rw);

      main.appendChild(section(y("numbers.format"), paramsBlock(D.viewParams.numbers, st, run)));
      var pre = el("pre", "mpre"); pre.textContent = bf(fmt);
      var codeWrap = el("div"); codeWrap.style.marginTop = "14px";
      var headWrap = el("div", "mcodehead");
      headWrap.innerHTML = '<span class="mcap" style="margin:0;">' + y("numbers.expression") + "</span>";
      var cp = el("span", "mcopy"); cp.textContent = "Copy";
      cp.onclick = function () { copyText(pre.textContent, "Expression copied."); };
      headWrap.appendChild(cp);
      codeWrap.appendChild(headWrap); codeWrap.appendChild(pre);
      main.appendChild(codeWrap);
      run();

      applyState = {
        foot: y("numbers.footer"),
        label: y("action.apply"),
        run: function () { toast(y("numbers.applied") + " " + en(1, "layer")); run(); }
      };
    },

    /* --- Devices: the real frame + Frame parameters + Insert --- */
    function (p, st) {
      var h = el("div", "mhead");
      h.innerHTML = "<h4>" + p.label + ' <span style="font-family:ui-monospace,monospace;font-size:10px;color:var(--mock-dim);font-weight:400;">'
        + p.screenW + " \u00d7 " + p.screenH + " \u00b7 r" + p.screenRadius + "</span></h4><p>" + p.description + "</p>";
      main.appendChild(h);

      var box = el("div", "mock-curve");
      box.style.cssText += "display:flex;align-items:center;justify-content:center;padding:20px 0;";
      main.appendChild(section(y("devices.frame"), box, true));

      function paint() {
        box.innerHTML = "";
        var maxH = 250, scale = maxH / p.screenH;
        var w = p.screenW * scale, hgt = maxH;
        var bezel = (st.values.bezel !== undefined ? st.values.bezel : p.bezel) * scale;
        var round = (st.values.roundness !== undefined ? st.values.roundness : 60) / 100;
        var bodyR = (p.screenRadius + (st.values.bezel !== undefined ? st.values.bezel : p.bezel)) * scale * (0.4 + round * 0.9);
        var screenR = p.screenRadius * scale * (0.4 + round * 0.9);
        var iw = (st.values.islandW !== undefined ? st.values.islandW : (p.island ? p.island.width : 0)) * scale;
        var ih = (st.values.islandH !== undefined ? st.values.islandH : (p.island ? p.island.height : 0)) * scale;
        var itop = (st.values.islandTop !== undefined ? st.values.islandTop : (p.island ? p.island.top : 0)) * scale;
        var irad = (p.island ? p.island.radius : 12) * scale * (0.4 + round * 0.9);

        var outer = el("div", "mphone");
        outer.style.cssText = "width:" + (w + bezel * 2) + "px;height:" + (hgt + bezel * 2) + "px;border-radius:" + bodyR + "px;padding:" + bezel + "px;box-shadow:0 18px 40px rgba(0,0,0,.5);";
        var scr = el("div", "mscreen");
        scr.style.cssText = "inset:" + bezel + "px;border-radius:" + screenR + "px;background:linear-gradient(160deg,#2f6bff,#b14cff 55%,#ff5d7a);";
        if (p.island && iw > 0) {
          var isl = el("div", "misland");
          isl.style.cssText = "width:" + iw + "px;height:" + ih + "px;border-radius:" + irad + "px;top:" + itop + "px;";
          scr.appendChild(isl);
        }
        var time = el("div");
        time.style.cssText = "position:absolute;top:" + (itop + ih + 4) + "px;left:0;right:0;text-align:center;color:#fff;font-size:10px;font-weight:700;";
        time.textContent = "9:41";
        scr.appendChild(time);
        outer.appendChild(scr);
        box.appendChild(outer);
      }
      var fp = (D.viewParams.devices || []).filter(function (x) { return p.island || !/^island/.test(x.id); });
      main.appendChild(section(y("common.parameters"), paramsBlock(fp, st, paint)));
      paint();

      applyState = {
        foot: y("devices.footer.hasComp") + " " + (p.screenW * p.pixelScale) + "\u00d7" + (p.screenH * p.pixelScale) + " " + y("devices.footer.oneToOne"),
        label: y("glass.insert"),
        run: function () { toast(y("glass.added") + " " + p.label + " Screen precomp"); }
      };
    },

    /* --- Tools: what it does, its parameters, its own action button --- */
    function (p, st) {
      var h = el("div", "mhead");
      h.innerHTML = "<h4>" + p.label + "</h4><p>" + p.subtitle + "</p><p>" + p.description + "</p>";
      main.appendChild(h);
      if (p.params && p.params.length) main.appendChild(section(y("common.parameters"), paramsBlock(p, st)));

      applyState = {
        foot: y("tools.openCompAnd") + " " + String(p.requirement || "").toLowerCase(),
        label: p.actionLabel || y("action.apply"),
        run: function () { toast(p.label + " \u2014 " + en(1, "layer")); }
      };
    }
  ];

  /* VIEWS is positional against D.tabs; look views up by tab id so hiding a
     tab cannot shift the wrong view into place. */
  var VIEW_BY_ID = {
    easing: VIEWS[0], text: VIEWS[1], transitions: VIEWS[2], glass: VIEWS[3],
    styles: VIEWS[4], expressions: VIEWS[5], numbers: VIEWS[6], devices: VIEWS[7],
    tools: VIEWS[8]
  };
  /* Tabs hidden from the website's preview. The plugin itself still ships
     every tab — this only trims what the marketing page shows. */
  var HIDDEN_TABS = { expressions: true };
  function tabVisible(t) { return !HIDDEN_TABS[t.id]; }

  /* ---------- shared view pieces ---------- */
  function head(p, badge) {
    var h = el("div", "mhead");
    h.innerHTML = "<h4>" + p.label + (badge ? ' <span class="mbadge">' + badge + "</span>" : "") + "</h4><p>" + p.description + "</p>";
    return h;
  }
  /* Accepts either a param array (view-level lists) or a preset object. */
  function paramsBlock(src, st, onChange) {
    var wrap = el("div", "mock-params");
    var list = Object.prototype.toString.call(src) === "[object Array]" ? src : ((src && src.params) || []);
    list.forEach(function (p) {
      if (st.values[p.id] === undefined) st.values[p.id] = p.default;
      wrap.appendChild(paramRow(p, st.values[p.id], function (v) {
        st.values[p.id] = v;
        if (onChange) onChange(v);
      }));
    });
    return wrap;
  }

  /* ---------- shell: pills, list, main, footer ---------- */
  function presetsOf(i) { return D.presets[D.tabs[i].id] || []; }

  function renderPills() {
    root.innerHTML = "";
    D.tabs.forEach(function (t, i) {
      if (!tabVisible(t)) return;
      var k = el("i");
      k.textContent = t.label;
      if (i === cur.tab) k.className = "on";
      k.onclick = function () { select(i, 0); };
      root.appendChild(k);
    });
  }
  function renderList() {
    if (!listEl) return;
    listEl.innerHTML = "";
    presetsOf(cur.tab).forEach(function (p, i) {
      var it = el("i");
      it.innerHTML = "<span>" + p.label + '</span><span class="msub">' + (p.subtitle || "") + "</span>";
      if (i === cur.idx) it.className = "on";
      it.onclick = function () { select(cur.tab, i); };
      listEl.appendChild(it);
    });
  }
  function render() {
    var all = presetsOf(cur.tab);
    var p = all[cur.idx];
    if (!p) { main.innerHTML = ""; applyState = null; paintFoot(); return; }
    /* parameter values live per preset and reset when the selection changes */
    var key = D.tabs[cur.tab].id + ":" + p.id;
    if (!vals[key]) {
      var base = D.tabs[cur.tab].id === "numbers" ? (D.viewParams.numbers || []) : (p.params || []);
      /* defaults, then the template's own overrides on top — same as the panel */
      vals[key] = defaultsOf(base);
      if (p.overrides) for (var k in p.overrides) vals[key][k] = p.overrides[k];
      vals[key].__target = "auto";
    }
    main.innerHTML = "";
    applyState = null;
    var view = VIEW_BY_ID[D.tabs[cur.tab].id];
    if (view) view(p, { values: vals[key] });
    paintFoot();
  }
  function paintFoot() {
    if (footEl) footEl.textContent = applyState ? applyState.foot : "";
    if (!applyEl) return;
    applyEl.textContent = applyState ? applyState.label : y("action.apply");
    applyEl.title = (applyState && applyState.title) || "";
    applyEl.style.opacity = applyState ? "1" : ".45";
  }
  function select(tab, idx) {
    cur.tab = tab; cur.idx = idx;
    renderPills(); renderList(); render();
  }

  if (applyEl) {
    applyEl.style.cursor = "pointer";
    applyEl.onclick = function () { if (applyState && applyState.run) applyState.run(); };
  }
  /* ---- "Experience the full panel": the preview stays compact so the page
     keeps its Apple-style rhythm, and opens up on demand. ---- */
  (function () {
    var shell = document.getElementById("mockShell");
    var btn = document.getElementById("mockExpand");
    if (!shell || !btn) return;
    var lbl = btn.querySelector(".lbl");
    function paint() {
      var open = shell.classList.contains("is-expanded");
      if (lbl) lbl.textContent = open ? "Back to the compact view" : "Experience the full panel";
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    }
    btn.setAttribute("aria-controls", "mockShell");
    btn.onclick = function () {
      var open = shell.classList.toggle("is-expanded");
      shell.classList.toggle("is-collapsed", !open);
      paint();
      if (open) {
        var r = shell.getBoundingClientRect();
        if (r.top < 0 || r.bottom > window.innerHeight) {
          shell.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    };
    paint();
  })();
  select(0, 0);
})();
