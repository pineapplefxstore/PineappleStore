(function(){
  // Theme: saved choice wins, else system preference.
  var root = document.documentElement, KEY = "pineapplefx-site-theme";
  function current(){
    try { var s = localStorage.getItem(KEY); if (s === "light" || s === "dark") return s; } catch(e){}
    return (window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark";
  }
  function paint(){
    var t = current();
    root.setAttribute("data-theme", t);
    document.getElementById("themeBtn").textContent = (t === "dark") ? "☾" : "☀";
  }
  document.getElementById("themeBtn").onclick = function(){
    var next = (root.getAttribute("data-theme") === "dark") ? "light" : "dark";
    try { localStorage.setItem(KEY, next); } catch(e){}
    paint();
  };
  paint();

  /* ---------- Security hardening ---------- */
  function secGet(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }
  function secSet(k,v){ try { localStorage.setItem(k,v); } catch(e){} }
  function applySecurity(){
    var csp = secGet("pfx-sec-csp");
    if(csp === "true"){
      if(!document.querySelector("meta[http-equiv='Content-Security-Policy']")){
        var m = document.createElement("meta");
        m.httpEquiv = "Content-Security-Policy";
        m.content = "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.paypal.com https://www.paypalobjects.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https:; frame-src https://www.paypal.com https://www.paypalobjects.com; base-uri 'self'; form-action 'self';";
        document.head.insertBefore(m, document.head.firstChild);
      }
    }
    var sessMin = secGet("pfx-sec-session");
    if(sessMin){
      var lastAct = secGet("pfx-sec-last-act") || String(Date.now());
      var limit = parseInt(sessMin, 10) * 60 * 1000;
      if(Date.now() - parseInt(lastAct, 10) > limit){
        try {
          localStorage.removeItem("pfx-session");
          localStorage.removeItem("pfx-admin-token");
          localStorage.removeItem("pfx-is-admin");
        } catch(e){}
        secSet("pfx-sec-last-act", String(Date.now()));
      } else {
        secSet("pfx-sec-last-act", lastAct);
      }
    }
    document.addEventListener("click", function(){ secSet("pfx-sec-last-act", String(Date.now())); }, {passive:true});
    document.addEventListener("keypress", function(){ secSet("pfx-sec-last-act", String(Date.now())); }, {passive:true});
  }
  applySecurity();

  var rateLimitMap = {};
  function rateLimited(action, maxPerMin){
    var now = Date.now();
    var key = "rl:" + action;
    var wins = (rateLimitMap[key] || []).filter(function(t){ return now - t < 60000; });
    if(wins.length >= maxPerMin) return true;
    wins.push(now);
    rateLimitMap[key] = wins;
    return false;
  }
  window.PFXRateLimit = rateLimited;
  /* ---- Pineapple Store pricing: $30 regular, $20 launch special (Oct 2026) ---- */
  var PRICE_REGULAR = "30.00", PRICE_LAUNCH = "20.00";
  var LAUNCH_END = Date.parse("2026-11-01T00:00:00Z"); // 1-month launch window
  function launchActive(){ try { return Date.now() < LAUNCH_END; } catch(e){ return true; } }
  function basePrice(){ return launchActive() ? PRICE_LAUNCH : PRICE_REGULAR; }
  function halfPrice(){ return launchActive() ? "10.00" : "15.00"; }
  function priceNum(s){ return String(s).replace(/\.00$/, ""); }
  function priceHTML(amount, note){
    var n = priceNum(amount);
    if(launchActive()){
      return "$" + n + " <small>USD</small><span class=\"price-strike\">$30</span>"
        + "<span class=\"price-badge\">Launch Special — 33% Off</span>"
        + (note ? " <small>" + note + "</small>" : "");
    }
    return "$" + n + " <small>one-time — USD</small>";
  }
  var ME_FULL = "https://paypal.me/sxiiedits/20USD";
  var ME_FULL_REG = "https://paypal.me/sxiiedits/30USD";
  var ME_HALF = "https://paypal.me/sxiiedits/10USD";
  var ME_HALF_REG = "https://paypal.me/sxiiedits/15USD";
  function meLink(amount){
    if(amount === halfPrice()) return launchActive() ? ME_HALF : ME_HALF_REG;
    if(amount === basePrice()) return launchActive() ? ME_FULL : ME_FULL_REG;
    return "https://paypal.me/sxiiedits/" + priceNum(amount) + "USD"; // custom % coupons
  }
  var ADMIN_EMAIL = "pineapplefx.store@gmail.com";
  function isOwner(){
    var em = String(authSession() || "").trim().toLowerCase();
    return em === ADMIN_EMAIL.toLowerCase();
  }
  function isAdmin(){
    // The owner is always admin on their own device, including local mode
    // (no server). Live server actions still need the login token —
    // see window.PFXServer.live() in pfx-admin.js.
    return isOwner();
  }
  function isLiveAdmin(){
    if(!isOwner()) return false;
    var tok = "";
    try { tok = localStorage.getItem("pfx-admin-token") || ""; } catch(e){}
    var isAdm = false;
    try { isAdm = localStorage.getItem("pfx-is-admin") === "true"; } catch(e){}
    return !!(tok && isAdm);
  }
  /* Built-ins (price logic only — NOT panel unlock codes). Admin-created
     codes live in localStorage alongside these. */
  var BUILTIN_COUPONS = {
    "PINFX-#UB-)5>}": { kind: "percent", pct: 50, note: "Launch 50% off", builtin: true },
    "OWNPFX-UKVL&{4B": { kind: "free", note: "Owner", builtin: true }
  };
  function storeCoupons(){ return lsGet("pfx-coupons", {}); }
  function couponDef(raw){
    var c = String(raw || "").trim();
    if(!c) return null;
    if(BUILTIN_COUPONS[c]) return BUILTIN_COUPONS[c];
    var all = storeCoupons();
    if(all[c]) return all[c];
    var up = c.toUpperCase(), keys = Object.keys(BUILTIN_COUPONS).concat(Object.keys(all));
    for(var i = 0; i < keys.length; i++){ if(keys[i].toUpperCase() === up) return (BUILTIN_COUPONS[keys[i]] || all[keys[i]]); }
    return null;
  }
  function couponKindOf(raw){ var d = couponDef(raw); return d ? d.kind : null; }
  function couponUsable(raw){
    var d = couponDef(raw);
    if(!d) return false;
    if(d.maxUses != null && (d.uses || 0) >= d.maxUses) return false;
    return true;
  }
  function couponAmount(raw){
    var d = couponDef(raw);
    if(!d || d.kind === "free") return "0.00";
    var pct = Math.min(99, Math.max(1, +d.pct || 0));
    return (parseFloat(basePrice()) * (1 - pct / 100)).toFixed(2);
  }
  window.PFXCoupons = {
    all: function(){
      var out = {}, k;
      for(k in BUILTIN_COUPONS) out[k] = BUILTIN_COUPONS[k];
      var s = storeCoupons();
      for(k in s) out[k] = s[k];
      return out;
    },
    get: couponDef,
    usable: couponUsable,
    create: function(code, def){
      code = String(code || "").trim().toUpperCase();
      if(code.length < 4 || code.length > 24 || /[^A-Z0-9-]/.test(code)) return { ok: false, error: "Code: 4–24 chars, letters/numbers/dashes." };
      if(BUILTIN_COUPONS[code] || storeCoupons()[code]) return { ok: false, error: "That code already exists." };
      if(def.kind !== "free" && !(def.pct >= 1 && def.pct <= 99)) return { ok: false, error: "Percent must be 1–99." };
      var s = storeCoupons();
      s[code] = { kind: def.kind, pct: def.kind === "free" ? 0 : Math.round(def.pct), note: String(def.note || "").slice(0, 60), maxUses: def.maxUses || null, uses: 0, created: Date.now(),
        program: def.program || "normal", platform: def.platform || "", channelId: def.channelId || "" };
      lsSet("pfx-coupons", s);
      return { ok: true, code: code };
    },
    remove: function(code){
      var s = storeCoupons();
      if(!s[code]) return false;
      delete s[code];
      lsSet("pfx-coupons", s);
      return true;
    },
    use: function(raw){
      var c = String(raw || "").trim();
      var s = storeCoupons(), hit = null;
      if(s[c]) hit = c;
      else { var up = c.toUpperCase(); for(var k in s){ if(k.toUpperCase() === up){ hit = k; break; } } }
      if(!hit) return;
      s[hit].uses = (s[hit].uses || 0) + 1;
      lsSet("pfx-coupons", s);
    }
  };
  function couponGet(){ try { return localStorage.getItem("pineapplefx-coupon") || ""; } catch(e){ return ""; } }
  function couponSet(c){ try { localStorage.setItem("pineapplefx-coupon", c); } catch(e){} }
  /* Static registry fallback (coupons.json, served with the site). GitHub
     Pages has no backend, so /api/coupons is inert there and every admin-made
     code would read "That code did not work." The file is PUBLIC: it may only
     carry percent-off codes — 'free' (key-minting) codes must never be in it,
     and this loader refuses them anyway as defence in depth. */
  function couponLookupStatic(code){
    if(!window.fetch) return Promise.resolve(null);
    var done = false;
    /* /store resolves ./coupons.json to /coupons.json; /store/ would resolve
       it to /store/coupons.json — try the root path as a fallback. */
    var p = fetch("./coupons.json", { cache: "no-cache" })
      .then(function(r){ return r.ok ? r.json() : fetch("/coupons.json", { cache: "no-cache" }).then(function(r2){ return r2.ok ? r2.json() : null; }); })
      .then(function(j){ done = true; return j; })
      .catch(function(){ done = true; return null; });
    var timeout = new Promise(function(res){ setTimeout(function(){ if(!done) res(null); }, 3000); });
    return Promise.race([p, timeout]).then(function(map){
      if(!map || typeof map !== "object") return null;
      var up = String(code || "").trim().toUpperCase(), hit = null;
      Object.keys(map).forEach(function(k){
        if(k.charAt(0) === "_") return; // skip "_note" etc.
        if(k.toUpperCase() === up) hit = k;
      });
      var d = hit ? map[hit] : null;
      if(!d || d.kind !== "percent") return null; // percent-only, always
      var s = storeCoupons();
      s[hit] = { kind: "percent", pct: Math.min(99, Math.max(1, +d.pct || 0)), note: String(d.note || "").slice(0, 60), maxUses: d.maxUses == null ? null : d.maxUses, uses: d.uses || 0, remote: true };
      lsSet("pfx-coupons", s);
      return hit;
    });
  }
  /* Server lookup. Admin-created codes live in the server DB, so a buyer's
     browser cannot know them from localStorage alone — without this every
     admin-made code reads "That code did not work." The result is cached
     locally so the price repaints correctly offline afterwards. */
  function couponLookupRemote(code){
    if(!window.fetch) return Promise.resolve(null);
    var u;
    try { u = window.PFXApi ? window.PFXApi("/api/coupons") : "/api/coupons"; } catch(e){ u = "/api/coupons"; }
    var done = false;
    var p = fetch(u, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code })
    }).then(function(r){ done = true; return r.json().then(function(d){ return (r.ok && d && d.ok) ? d : null; }); })
      .catch(function(){ done = true; return null; });
    /* file:// and offline previews never answer — fail fast to local-only. */
    var timeout = new Promise(function(res){ setTimeout(function(){ if(!done) res(null); }, 3000); });
    return Promise.race([p, timeout]).then(function(d){
      if(!d) return null;
      var s = storeCoupons();
      s[d.code] = { kind: d.kind, pct: d.pct, note: "", maxUses: d.maxUses, uses: d.uses || 0, remote: true };
      lsSet("pfx-coupons", s);
      return d.code;
    });
  }

  /* ---- Pineapple Store accounts (localStorage; demo-grade auth) ----
     Passwords are SHA-256 hashed (salted per user) before storage — never
     stored in cleartext. NOTE: this is client-side convenience auth so buyers
     can recover keys on the same browser; pair with a real backend for
     cross-device accounts. */
  function lsGet(k, fb){ try { var v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch(e){ return fb; } }
  function lsSet(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} }
  function fnvHex(s){ var h = 0x811c9dc5; for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return ("0000000" + (h >>> 0).toString(16)).slice(-8); }
  function sha256hex(s){
    try {
      if(window.crypto && crypto.subtle && window.isSecureContext !== false){
        return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)).then(function(b){
          return Array.prototype.map.call(new Uint8Array(b), function(x){ return ("0" + x.toString(16)).slice(-2); }).join("");
        });
      }
    } catch(e){}
    return Promise.resolve("fnv$" + fnvHex("a" + s) + fnvHex("b" + s)); // non-secure-context fallback
  }
  var authListeners = [];
  function authUsers(){ return lsGet("pfx-users", {}); }
  function authSession(){ try { return localStorage.getItem("pfx-session") || ""; } catch(e){ return ""; } }
  function authFire(){ for(var i = 0; i < authListeners.length; i++){ try { authListeners[i](authSession()); } catch(e){} } }
  function authValidEmail(e){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim()); }
  window.PFXAuth = {
    session: authSession,
    onChange: function(fn){ authListeners.push(fn); },
    signup: function(email, pass){
      email = String(email || "").trim().toLowerCase();
      if(!authValidEmail(email)) return Promise.resolve({ ok: false, error: "Enter a valid email address." });
      if(String(pass || "").length < 8) return Promise.resolve({ ok: false, error: "Password needs at least 8 characters." });
      var users = authUsers();
      if(users[email]) return Promise.resolve({ ok: false, error: "Account exists — log in instead." });
      var salt = "";
      try {
        var r = new Uint32Array(4);
        (crypto.getRandomValues ? crypto.getRandomValues(r) : r.map(function(){ return Math.floor(Math.random() * 4294967296); }));
        salt = Array.prototype.join.call(r, "-");
      } catch(e){ salt = String(Date.now()) + Math.random(); }
      return sha256hex(salt + "::" + pass).then(function(hash){
        users[email] = { salt: salt, hash: hash, created: Date.now() };
        lsSet("pfx-users", users);
        try { localStorage.setItem("pfx-session", email); } catch(e){}
        authFire();
        return { ok: true, email: email };
      });
    },
    login: function(email, pass){
      email = String(email || "").trim().toLowerCase();
      return fetch(apiUrl("/api/auth"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "login", email: email, password: pass })
      }).then(function(r){
        return r.json().then(function(d){
          if(r.ok && d && d.ok){
            try {
              localStorage.setItem("pfx-session", d.email || email);
              if(d.is_admin){
                localStorage.setItem("pfx-admin-token", d.token);
                localStorage.setItem("pfx-is-admin", "true");
              } else {
                localStorage.removeItem("pfx-admin-token");
                localStorage.removeItem("pfx-is-admin");
              }
            } catch(e){}
            authFire();
            return { ok: true, email: d.email || email, is_admin: !!d.is_admin, token: d.token };
          }
          if(d && d.error === "bad-credentials") return { ok: false, error: "Wrong password — try again." };
          if(d && d.error === "account-disabled") return { ok: false, error: "This account has been deactivated." };
          throw new Error((d && d.error) || "login-failed");
        });
      }).catch(function(){
        var users = authUsers();
        if(!users[email]) return { ok: false, error: "No account for that email — sign up first." };
        return sha256hex(users[email].salt + "::" + pass).then(function(hash){
          if(hash !== users[email].hash) return { ok: false, error: "Wrong password — try again." };
          try {
            localStorage.setItem("pfx-session", email);
            localStorage.removeItem("pfx-admin-token");
            localStorage.removeItem("pfx-is-admin");
          } catch(e){}
          authFire();
          return { ok: true, email: email };
        });
      });
    },
    logout: function(){
      try {
        localStorage.removeItem("pfx-session");
        localStorage.removeItem("pfx-admin-token");
        localStorage.removeItem("pfx-is-admin");
      } catch(e){}
      authFire();
    },
    require: function(){ return !!authSession(); }
  };
  /* Per-account license vault: email -> { machineID -> {key, at, orderID, coupon} } */
  window.PFXVault = {
    get: function(email){ var v = lsGet("pfx-licenses", {}); return v[email] || {}; },
    all: function(){ return lsGet("pfx-licenses", {}); },
    existing: function(email, machine){
      var m = window.PFXVault.get(email);
      return m[String(machine || "").toUpperCase()] || null;
    },
    save: function(email, machine, entry){
      var v = window.PFXVault.all();
      machine = String(machine || "").toUpperCase();
      if(!v[email]) v[email] = {};
      if(v[email][machine]) return v[email][machine]; // 1 active license per machine: never duplicate
      v[email][machine] = entry;
      lsSet("pfx-licenses", v);
      return entry;
    }
  };
  window.PFXPricing = { basePrice: basePrice, halfPrice: halfPrice, launchActive: launchActive };
  /* External backend hook (GitHub Pages serves static files only): set
     window.PFX_API_BASE = "https://your-api-host" BEFORE these scripts load
     (e.g. tiny inline script) and every /api/* call follows it. Empty (the
     default) means same-origin /api/* with graceful local fallbacks. */
  window.PFX_API_BASE = window.PFX_API_BASE || "";
  window.PFXApi = function(p){
    var b = "";
    try { b = window.PFX_API_BASE || ""; } catch(e){}
    return String(b).replace(/\/$/, "") + p;
  };
  function apiUrl(p){ return window.PFXApi(p); }
  window.PFXCore = {
    lsGet: lsGet, lsSet: lsSet, authUsers: authUsers,
    couponDef: couponDef, couponUsable: couponUsable, couponAmount: couponAmount,
    basePrice: basePrice, halfPrice: halfPrice, launchActive: launchActive,
    priceNum: priceNum, paintCoupon: paintCoupon, renderPP: renderPP,
    ADMIN_EMAIL: ADMIN_EMAIL, isAdmin: isAdmin, isOwner: isOwner, isLiveAdmin: isLiveAdmin, refreshServerPricing: refreshServerPricing, setPricing: setPricing
  };
  /* Admin-controlled pricing override: try /api/pricing once (3s); fall back
     to baked-in defaults so file:// and offline previews keep working. */
  function refreshServerPricing(){
    if(location.protocol === "file:" || typeof fetch !== "function") return;
    try {
      var ctrl = ("AbortController" in window) ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function(){ try { ctrl.abort(); } catch(e){} }, 3000) : null;
      fetch(apiUrl("/api/pricing"), ctrl ? { signal: ctrl.signal } : {}).then(function(r){ return r.json(); }).then(function(d){
        if(timer) clearTimeout(timer);
        if(d && d.ok && d.pricing){
          if(d.pricing.regular) PRICE_REGULAR = Number(d.pricing.regular).toFixed(2);
          if(d.pricing.launch) PRICE_LAUNCH = Number(d.pricing.launch).toFixed(2);
          if(d.pricing.launchEnd && !Number.isNaN(Date.parse(d.pricing.launchEnd))) LAUNCH_END = Date.parse(d.pricing.launchEnd);
          paintCoupon();
        }
      }).catch(function(){ if(timer) clearTimeout(timer); });
    } catch(e){}
  }
  /* Admin-controlled pricing override that also works offline / in local mode.
     Saves to localStorage so the store price persists across reloads. */
  function setPricing(regular, launch, launchEnd){
    var changed = false;
    if(regular != null && String(regular).trim() !== ""){
      PRICE_REGULAR = Number(regular).toFixed(2); changed = true;
    }
    if(launch != null && String(launch).trim() !== ""){
      PRICE_LAUNCH = Number(launch).toFixed(2); changed = true;
    }
    if(launchEnd != null && String(launchEnd).trim() !== ""){
      var le = Date.parse(launchEnd);
      if(!Number.isNaN(le)){ LAUNCH_END = le; changed = true; }
    }
    if(changed){
      try { localStorage.setItem("pfx-price-regular", PRICE_REGULAR); } catch(e){}
      try { localStorage.setItem("pfx-price-launch", PRICE_LAUNCH); } catch(e){}
      try { localStorage.setItem("pfx-price-launchend", String(LAUNCH_END)); } catch(e){}
      paintCoupon();
    }
    return { ok: true, regular: PRICE_REGULAR, launch: PRICE_LAUNCH, launchEnd: new Date(LAUNCH_END).toISOString() };
  }
  function bindClear(){
    var cl = document.getElementById("couponClear"); if(!cl) return;
    var inp = document.getElementById("couponInput");
    cl.onclick = function(e){
      if(e && e.preventDefault) e.preventDefault();
      try { localStorage.removeItem("pineapplefx-coupon"); } catch(_){}
      if(inp) inp.value = "";
      paintCoupon();
    };
  }
  function ppBox(html){ ["ppHero", "ppPrice"].forEach(function(id){ var b = document.getElementById(id); if(b) b.innerHTML = html; }); }
  function ppToast(m){
    window.PFXToast = ppToast;
    window.ppToast = ppToast;
    var t = document.getElementById("mToast");
    if(!t){
      t = document.createElement("div"); t.id = "mToast";
      t.style.cssText = "position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#1e1e22;color:#f5f5f4;border:1px solid #feca08;border-radius:999px;padding:10px 22px;font-size:13px;font-weight:600;z-index:99;box-shadow:0 12px 30px rgba(0,0,0,.5);white-space:nowrap;";
      document.body.appendChild(t);
    }
    t.textContent = m; t.style.display = "block";
    clearTimeout(t.__h); t.__h = setTimeout(function(){ t.style.display = "none"; }, 4000);
  }
  function loginCTAHTML(label){
    return '<button class="btn btn-pay" data-login-cta="1" style="width:100%;">' + (label || "Log in to buy") + "</button>"
      + '<p class="trial-note" style="margin-top:8px;">A free Pineapple Store account keeps your keys recoverable.</p>';
  }
  function wireLoginCTAs(){
    Array.prototype.forEach.call(document.querySelectorAll("[data-login-cta]"), function(b){
      if(b.__wired) return; b.__wired = true;
      b.onclick = function(){ openAuth("signup"); };
    });
  }
  function renderPP(amount){
    if(!document.getElementById("ppHero") && !document.getElementById("ppPrice")) return; // store page only
    ppBox("");
    if(!window.PFXAuth.require()){
      ppBox(loginCTAHTML("Log in / Sign up to buy — $" + priceNum(amount)));
      wireLoginCTAs();
      return;
    }
    if(typeof paypal === "undefined" || !paypal.Buttons){
      ppBox('<a class="btn btn-pay" href="' + meLink(amount) + '">Buy with PayPal \u2014 $' + priceNum(amount) + ' USD</a>');
      return;
    }
    ["ppHero", "ppPrice"].filter(function(id){ return !!document.getElementById(id); }).forEach(function(id){
      paypal.Buttons({
        style:{ layout:"vertical", color:"gold", shape:"pill", label:"paypal" },
        createOrder:function(dt, actions){
          return actions.order.create({ purchase_units:[{ description:"PineappleFX license - one machine", amount:{ value:amount, currency_code:"USD" } }] });
        },
        onApprove:function(dt, actions){
          return actions.order.capture().then(function(det){
            var orderID = dt.orderID || (det && det.id) || "";
            var payerEmail = (det && det.payer && det.payer.email_address) || "";
            if(window.PineappleFXLic && window.PineappleFXLic.handleApproval){
              window.PineappleFXLic.handleApproval({ orderID:orderID, email:payerEmail, amount:amount });
            } else {
              // Fallback if the license script hasn't loaded: keep the legacy receipt page.
              var q = "order=" + encodeURIComponent(orderID)
                + "&txn=" + encodeURIComponent((det && det.id) || orderID)
                + "&amount=" + encodeURIComponent(amount)
                + "&email=" + encodeURIComponent(payerEmail);
              location.href = "success?" + q;
            }
          });
        },
        onCancel:function(){ ppToast("Payment cancelled - no charge made."); },
        onError:function(){ ppToast("PayPal had a hiccup - try again."); }
      }).render("#" + id);
    });
  }
  function claimOnly(){
    if(!window.PFXAuth.require()){ ppBox(loginCTAHTML("Log in to claim free license")); wireLoginCTAs(); return; }
    ppBox('<a class="btn btn-pay" href="#order">Claim free license</a>');
  }
  function paintPricingChrome(full, half){
    var hp = document.getElementById("heroPrice"), pp = document.getElementById("priceVal");
    var sub = document.getElementById("priceSub"), nav = document.getElementById("navBuy"), foot = document.getElementById("footPrice");
    if(hp) hp.innerHTML = priceHTML(full);
    if(pp) pp.innerHTML = priceHTML(full);
    if(sub){
      sub.innerHTML = launchActive()
        ? "$" + priceNum(full) + " USD (Launch Special — 33% Off, normal price $30). Free updates forever — every future version included. One license per machine."
        : "$30 USD one-time. Free updates forever — every future version included. One license per machine.";
    }
    if(nav) nav.textContent = "Buy — $" + priceNum(full) + " USD";
    if(foot) foot.textContent = launchActive() ? "$20 launch special (reg. $30)" : "$30 one-time";
  }
  function paintCoupon(){
    var c = couponGet(), msg = document.getElementById("couponMsg");
    var full = basePrice();
    var fld = document.getElementById("couponField");
    var def = couponDef(c);
    if(fld) fld.value = (def && couponUsable(c)) ? c : "";
    if(!msg){ paintPricingChrome(full, halfPrice()); renderPP(full); return; } // non-store page: chrome only
    if(def && couponUsable(c) && def.kind === "free"){
      var hp2 = document.getElementById("heroPrice"), pp2 = document.getElementById("priceVal");
      if(hp2) hp2.innerHTML = "$0 <small>coupon license</small>";
      if(pp2) pp2.innerHTML = "$0 <small>coupon license</small>";
      msg.style.color = "var(--label-2)"; msg.innerHTML = "Coupon accepted — no payment needed. Enter your Machine ID below to get your key instantly. <a href=\"#\" id=\"couponClear\" style=\"color:var(--accent);font-weight:700;\">remove</a>"; bindClear();
      claimOnly();
    } else if(def && couponUsable(c)){
      paintPricingChrome(full, halfPrice());
      var hp = document.getElementById("heroPrice"), pp = document.getElementById("priceVal");
      var amt = couponAmount(c);
      var sale = "$" + priceNum(amt) + " <small>USD — " + (+def.pct) + "% off</small>";
      if(hp) hp.innerHTML = sale;
      if(pp) pp.innerHTML = sale;
      msg.style.color = "var(--label-2)"; msg.innerHTML = (+def.pct) + "% off applied" + (def.maxUses != null ? " (" + (def.uses || 0) + "/" + def.maxUses + " used)" : "") + ". <a href=\"#\" id=\"couponClear\" style=\"color:var(--accent);font-weight:700;\">remove</a>"; bindClear();
      renderPP(amt);
    } else {
      if(c && !def){ try { localStorage.removeItem("pineapplefx-coupon"); } catch(e){} c = ""; }
      if(c && def && !couponUsable(c)){
        msg.style.color = "#e5484d"; msg.textContent = "That code is fully redeemed.";
        try { localStorage.removeItem("pineapplefx-coupon"); } catch(e){}
      }
      paintPricingChrome(full, halfPrice());
      renderPP(full);
    }
  }
  var couponApplyBtn = document.getElementById("couponApply");
  if(couponApplyBtn) couponApplyBtn.onclick = function(){
    var v = document.getElementById("couponInput").value.trim();
    var msg = document.getElementById("couponMsg");
    if(!v){ msg.style.color = "#e5484d"; msg.textContent = "Enter a code first."; return; }
    var def = couponDef(v);
    function accept(hit){
      var all = window.PFXCoupons.all();
      var up = hit.toUpperCase();
      Object.keys(all).forEach(function(k){ if(k.toUpperCase() === up) hit = k; });
      couponSet(hit); paintCoupon();
    }
    if(def && couponUsable(v)){ accept(v); return; }
    if(def && !couponUsable(v)){ msg.style.color = "#e5484d"; msg.textContent = "That code is fully redeemed."; return; }
    /* not in this browser — ask the server, then the published registry */
    msg.style.color = "var(--label-2)"; msg.textContent = "Checking code\u2026";
    couponApplyBtn.disabled = true;
    couponLookupRemote(v).then(function(hit){
      if(hit) return hit;
      return couponLookupStatic(v);
    }).then(function(hit){
      couponApplyBtn.disabled = false;
      if(hit){ accept(hit); return; }
      msg.style.color = "#e5484d";
      msg.textContent = "That code did not work.";
    });
  };
  /* ---- account modal + session chrome ---- */
  var authModal = document.getElementById("authModal");
  if(authModal){ // auth modal ships on every page; guard anyway
  var authMode = "login";
  function openAuth(mode){
    authMode = (mode === "signup") ? "signup" : "login";
    paintAuthMode();
    document.getElementById("authErr").textContent = "";
    authModal.classList.add("open");
    document.body.style.overflow = "hidden";
    setTimeout(function(){ document.getElementById("authEmail").focus(); }, 50);
  }
  function closeAuth(){ authModal.classList.remove("open"); document.body.style.overflow = ""; }
  window.PFXOpenAuth = openAuth;
  function paintAuthMode(){
    document.getElementById("tabLogin").className = authMode === "login" ? "on" : "";
    document.getElementById("tabSignup").className = authMode === "signup" ? "on" : "";
    document.getElementById("authGo").textContent = authMode === "login" ? "Log in" : "Create account";
  }
  document.getElementById("tabLogin").onclick = function(){ authMode = "login"; paintAuthMode(); };
  document.getElementById("tabSignup").onclick = function(){ authMode = "signup"; paintAuthMode(); };
  document.getElementById("authClose").onclick = closeAuth;
  authModal.addEventListener("click", function(e){ if(e.target === authModal) closeAuth(); });
  document.getElementById("authGo").onclick = function(){
    var em = document.getElementById("authEmail").value, pw = document.getElementById("authPass").value;
    var err = document.getElementById("authErr"), go = document.getElementById("authGo");
    err.textContent = "";
    go.disabled = true;
    go.textContent = authMode === "login" ? "Logging in…" : "Creating account…";
    var op = authMode === "login" ? window.PFXAuth.login(em, pw) : window.PFXAuth.signup(em, pw);
    op.then(function(r){
      go.disabled = false;
      paintAuthMode();
      if(!r.ok){ err.textContent = r.error; return; }
      document.getElementById("authPass").value = "";
      closeAuth();
      ppToast("Welcome, " + r.email + " — you're logged in.");
      var ordAfter = document.getElementById("order");
      if(ordAfter) ordAfter.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };
  document.getElementById("authPass").onkeydown = function(e){ if(e.key === "Enter") document.getElementById("authGo").click(); };
  }
  var acctBtnEl = document.getElementById("acctBtn");
  var acctMenu = document.getElementById("acctMenu");
  function closeMenu(){ if(acctMenu) acctMenu.classList.remove("open"); }
  if(acctBtnEl) acctBtnEl.onclick = function(e){
    if(e && e.stopPropagation) e.stopPropagation();
    if(!window.PFXAuth.require()){ openAuth("login"); return; }
    if(acctMenu) acctMenu.classList.toggle("open");
    else location.href = "dashboard";
  };
  document.addEventListener("click", function(e){
    if(acctMenu && acctMenu.classList.contains("open")) closeMenu();
  });
  var menuLogout = document.getElementById("menuLogout");
  if(menuLogout) menuLogout.onclick = function(e){
    if(e && e.preventDefault) e.preventDefault();
    closeMenu();
    window.PFXAuth.logout();
  };
  function paintSessionChrome(){
    var s = window.PFXAuth.session();
    var ab = document.getElementById("acctBtn");
    if(ab){
    ab.textContent = s ? ("👤 " + s.split("@")[0]) : "👤 Account";
    ab.title = s ? ("Logged in as " + s + " — open My Licenses") : "Log in / Sign up";
    }
    var gate = document.getElementById("orderGate");
    if(gate) gate.style.display = s ? "none" : "block";
    var admin = isAdmin();
    var navA = document.getElementById("navAdmin");
    if(navA) navA.style.display = admin ? "" : "none";
    var sec = document.getElementById("admin");
    if(sec) sec.style.display = admin ? "" : "none";
    if(admin && window.PFXAdmin) window.PFXAdmin.refresh();
    var menuA = document.getElementById("menuAdmin");
    if(menuA) menuA.style.display = admin ? "" : "none";
    paintAdminButton(admin, s);
  }
  /* Easy one-click button for the owner: shows on every page when the
     owner (pineapplefx.store@gmail.com) is logged in — next to My Licenses. */
  function paintAdminButton(admin, session){
    var isOwnerNow = false;
    try { isOwnerNow = window.PFXCore ? window.PFXCore.isOwner() : false; } catch(e){}
    if(!isOwnerNow) isOwnerNow = String(session || "").trim().toLowerCase() === ADMIN_EMAIL.toLowerCase();
    var show = !!(admin && isOwnerNow);
    // Never show the shortcut on the admin page itself.
    try { if(/\/admin$/.test(location.pathname)) show = false; } catch(e){}
    var b = document.getElementById("ownerAdminBtn");
    if(show && !b){
      b = document.createElement("a");
      b.id = "ownerAdminBtn";
      b.href = "admin";
      b.textContent = "⚙ Open Admin Panel";
      b.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:9990;background:#feca08;color:#111;font-weight:800;font-size:13.5px;padding:12px 20px;border-radius:999px;text-decoration:none;box-shadow:0 12px 30px rgba(0,0,0,.45);";
      document.body.appendChild(b);
    }
    if(b) b.style.display = show ? "" : "none";
  }
  /* One-tap email copy for every [data-copy-email] button (footer, help). */
  function bindContactCopy(){
    Array.prototype.forEach.call(document.querySelectorAll("[data-copy-email]"), function(b){
      if(b.__wired) return; b.__wired = true;
      b.onclick = function(){
        var mail = b.getAttribute("data-copy-email") || "";
        var orig = b.getAttribute("data-orig") || b.textContent;
        if(!b.getAttribute("data-orig")) b.setAttribute("data-orig", orig);
        function done(ok){
          b.textContent = ok ? "✓ Copied!" : mail;
          if(ok) setTimeout(function(){ b.textContent = b.getAttribute("data-orig"); }, 2000);
        }
        try {
          if(navigator.clipboard && navigator.clipboard.writeText){
            navigator.clipboard.writeText(mail).then(function(){ done(true); }, function(){ done(false); });
            return;
          }
          var ta = document.createElement("textarea");
          ta.value = mail; document.body.appendChild(ta);
          ta.select(); try { document.execCommand("copy"); done(true); } catch(e){ done(false); }
          document.body.removeChild(ta);
        } catch(e){ done(false); }
      };
    });
  }
  var orderLogin = document.getElementById("orderLogin");
  if(orderLogin) orderLogin.onclick = function(e){ if(e && e.preventDefault) e.preventDefault(); openAuth("signup"); };
  window.PFXAuth.onChange(function(){
    paintSessionChrome();
    paintCoupon(); // re-render PayPal buttons gated on login
    if(window.PineappleFXLic && window.PineappleFXLic.refreshDashboard) window.PineappleFXLic.refreshDashboard();
  });
  paintSessionChrome();
  paintCoupon();
  bindContactCopy();
  function verifyServerSession(){
    var tok = "";
    try { tok = localStorage.getItem("pfx-admin-token") || ""; } catch(e){}
    if(!tok) return;
    try {
      fetch(apiUrl("/api/auth"), {
        method: "GET",
        headers: { "Authorization": "Bearer " + tok }
      }).then(function(r){ return r.json(); }).then(function(d){
        if(!d || !d.ok || !d.is_admin || String(d.email || "").toLowerCase() !== ADMIN_EMAIL.toLowerCase()){
          try {
            localStorage.removeItem("pfx-admin-token");
            localStorage.removeItem("pfx-is-admin");
          } catch(e){}
          authFire();
        } else {
          try {
            localStorage.setItem("pfx-is-admin", "true");
            localStorage.setItem("pfx-session", ADMIN_EMAIL);
          } catch(e){}
          paintSessionChrome();
        }
      }).catch(function(){});
    } catch(e){}
  }
  verifyServerSession();

  refreshServerPricing(); // admin-controlled override; silent no-op offline
  // Legacy ?email=&device=&txn= links (e.g. from success.html) land on the
  // coupon-claim box now: prefill the Machine ID so one click finishes it.
  try {
    var q2 = new URLSearchParams(location.search || "");
    var dev = q2.get("device") || q2.get("machine_id") || "";
    if(dev){
      var cd = document.getElementById("claimDev");
      if(cd && !cd.value) cd.value = dev.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
      var ord = document.getElementById("order");
      if(ord && (q2.get("txn") || q2.get("order"))) ord.scrollIntoView();
    }
  } catch(e){}
})();

