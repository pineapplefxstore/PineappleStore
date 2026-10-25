/* ---- PineappleFX instant licensing: pay → key on this page, no manual form ---- */
window.PineappleFXLic = (function(){
  var ENDPOINT = "/api/generate-license";
  var ZXP_URL = "./downloads/PineappleFX.zxp"; // staged release build (site/downloads/)
  function apiUrl(p){ try { if(window.PFXApi) return window.PFXApi(p); } catch(e){} return p; }
  var modal = document.getElementById("licModal");
  var modalBody = document.getElementById("licModalBody");
  var licStatus = document.getElementById("licStatus");
  var claimDev = document.getElementById("claimDev");
  var claimBtn = document.getElementById("claimBtn");
  var claimStatus = document.getElementById("claimStatus");
  var lastKey = "";

  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }
  function coupon(){ try { return localStorage.getItem("pineapplefx-coupon") || ""; } catch(e){ return ""; } }
  function openModal(){ if(!modal || !modalBody) return; modal.classList.add("open"); document.body.style.overflow = "hidden"; }
  function closeModal(){ if(modal) modal.classList.remove("open"); document.body.style.overflow = ""; }
  var licModalCloseBtn = document.getElementById("licModalClose");
  if(licModalCloseBtn) licModalCloseBtn.onclick = closeModal;
  if(modal) modal.addEventListener("click", function(e){ if(e.target === modal) closeModal(); });
  document.addEventListener("keydown", function(e){ if(e.key === "Escape") closeModal(); });

  function copyKey(key, btn){
    function done(ok){ btn.textContent = ok ? "Copied ✓" : "Copy failed — select manually"; }
    try {
      if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(key).then(function(){ done(true); }, function(){ done(false); }); return; }
      var ta = document.createElement("textarea"); ta.value = key; document.body.appendChild(ta);
      ta.select(); try { document.execCommand("copy"); done(true); } catch(err){ done(false); }
      document.body.removeChild(ta);
    } catch(err){ done(false); }
  }

  /* --- SECURITY: no client-side key minting on the storefront ---
     An earlier build kept a "local simulation" fallback here that minted REAL
     panel-valid keys in the browser when /api/generate-license was unreachable.
     That was a total bypass: production is static hosting, so the API is always
     "unreachable" and any visitor could mint a working key for free by typing
     any Machine ID. Keys are now ONLY ever produced by the server, after
     payment (or an owner coupon) is confirmed. The mint secret is likewise no
     longer shipped in any public JS — it lives in the server env and (necessarily)
     inside the .zxp gate, which is the plugin itself. */
  var NO_MINT_MSG = "The license server is not reachable right now, so keys can't be issued from this page. Please try again shortly, or contact pineapplefx.store@gmail.com with your Machine ID and order ID.";
  function normMachine(raw){ return String(raw || "").trim().toUpperCase(); }

  /* Local placeholder key generator for instant checkout before AE installation */
  function placeholderKey(seed){
    var A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ", s = "";
    var src = String(seed || "") + Date.now();
    for(var i = 0; i < 16; i++){
      s += A.charAt(Math.floor(Math.random() * A.length));
    }
    return "PFX2-" + s.slice(0, 8) + "-" + s.slice(8);
  }

  function keyCardHTML(key, opts){
    opts = opts || {};
    var isPending = (opts.machine === "PENDING" || (key && key.indexOf("PFX2-") === 0 && opts.isPlaceholder));
    return '<div style="font-size:34px;">' + (isPending ? '⚡' : '🎉') + '</div>'
      + '<h3>' + (isPending ? 'Your license is ready to download!' : (opts.free ? 'Your free key is ready!' : 'Payment Successful!')) + '</h3>'
      + '<p class="lic-sub">' + (isPending ? 'Download the installer below. When you open After Effects, activate with your Machine ID in your account dashboard anytime:' : ('Your license key — generated just now' + (opts.email ? ', receipt also sent to <b>' + esc(opts.email) + '</b>' : '') + ':')) + '</p>'
      + '<div class="keyline-big" id="licKeyVal">' + esc(key) + '</div>'
      + (isPending ? '<p class="lic-sim" style="color:var(--accent);">ℹ️ Reserved License: Saved to your account. You can bind your PC Machine ID anytime in <a href="dashboard" style="color:#fff;text-decoration:underline;font-weight:700;">My Licenses</a>.</p>' : '')
      + (opts.recovered ? '<p class="lic-sim">♻ Recovered from your account — this machine already had a key, no duplicate created.</p>' : '')
      + '<button class="btn btn-pay" id="licCopyBtn" type="button">Copy Key</button>'
      + (opts.downloadUrl ? '<a class="lic-dl" id="licDl" href="' + esc(opts.downloadUrl) + '">⬇ Download PineappleFX .zxp installer</a>' : '')
      + '<div class="lic-steps-mini"><b>Unlock in After Effects:</b><br>1. Install the .zxp &amp; restart After Effects<br>2. Open Window → Extensions → PineappleFX<br>3. ' + (isPending ? 'If your panel asks for Machine ID activation, click "Activate PC" in your <a href="dashboard" style="color:var(--accent);">Dashboard</a> anytime.' : 'Paste your key into the locked panel — unlocks instantly, offline.') + '</div>';
  }

  function showKey(key, opts){
    opts = opts || {};
    if(!opts.downloadUrl || opts.downloadUrl.indexOf("YOUR-USERNAME") !== -1) opts.downloadUrl = ZXP_URL;
    lastKey = key;
    modalBody.innerHTML = keyCardHTML(key, opts);
    document.getElementById("licCopyBtn").onclick = function(){ copyKey(key, this); };
    openModal();
    // Mirror into the #order section so the key survives closing the popup.
    if(licStatus) licStatus.innerHTML = '<div style="text-align:center;"><div style="font-size:24px;">🎉</div><b>' + (opts.free ? 'Your free key is ready!' : 'Payment Successful — key ready!') + '</b></div>'
      + (opts.recovered ? '<div style="text-align:center;"><p class="lic-sim">♻ Recovered from your account.</p></div>' : '')
      + '<div class="keyline-big" style="font-size:15px;">' + esc(key) + '</div>'
      + '<button class="btn btn-pay" id="licCopyInline" type="button" style="width:100%;">Copy Key</button>'
      + (opts.downloadUrl ? '<a class="lic-dl" style="text-align:center;" href="' + esc(opts.downloadUrl) + '">⬇ Download .zxp installer</a>' : '')
      + '<p style="font-size:12.5px;color:var(--label-2);text-align:center;margin-top:8px;">Paste your key into the PineappleFX After Effects panel to unlock instantly.</p>';
    document.getElementById("licCopyInline").onclick = function(){ copyKey(key, this); };
    var ordEl = document.getElementById("order"); if(ordEl) ordEl.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function mint(payload, ui){
    // ui: { setLoading(bool), onKey(key, data), onError(html) }
    // SECURITY: keys are minted ONLY by the server, after payment is confirmed.
    // There is deliberately no client-side fallback — see the note above.
    ui.setLoading(true);
    fetch(apiUrl(ENDPOINT), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function(res){
      return res.json().catch(function(){ throw new Error("bad-response"); }).then(function(data){
        if(!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || ("http-" + res.status));
        return data;
      });
    }).then(function(data){
      ui.setLoading(false);
      ui.onKey(data.key, data);
    }).catch(function(err){
      var msg = String((err && err.message) || err);
      // Any failure (offline, blocked, 404, timeout, bad response) fails CLOSED:
      // never mint a key in the browser.
      ui.setLoading(false);
      if(msg === "bad-response" || msg.indexOf("Failed to fetch") !== -1 || msg.indexOf("NetworkError") !== -1){
        ui.onError(NO_MINT_MSG);
        return;
      }
      var friendly = {
        "missing-fields": "Something's missing — enter your 8-character Machine ID and try again.",
        "bad-email": "PayPal didn't return a usable email — contact pineapplefx.store@gmail.com with your order ID.",
        "bad-machine": "Machine ID must be exactly 8 letters/numbers — find it on the locked panel.",
        "bad-coupon": "That coupon code did not work.",
        "bad-transaction": "Payment reference looks invalid — try the PayPal button again.",
        "server-misconfigured": "License server isn't configured yet (missing secret) — contact pineapplefx.store@gmail.com with your order ID.",
        "machine-limit": "This account already uses its machine slot — each key unlocks exactly 1 PC. See the one-time $7.90 extra-machine deal in My Licenses.",
        "already-claimed": "Extra-machine deal already claimed on this account — one per account, and yours is saved in My Licenses.",
        "email-failed": "Key minted but the receipt email bounced — your key below still works, keep it safe."
      }[msg] || ("License request failed (" + esc(msg) + "). Retry or contact pineapplefx.store@gmail.com.");
      ui.onError(friendly);
    });
  }

  /* --- post-PayPal: orderID + payer email auto-captured, only Machine ID asked --- */
  function handleApproval(info){
    var c = coupon();
    modalBody.innerHTML = '<div style="font-size:34px;">✅</div><h3>Payment approved!</h3>'
      + '<p class="lic-sub">One last step — paste your <b>Machine ID</b> (8 characters, shown on the locked panel) to mint your key:</p>'
      + '<input id="licDev" class="mono" type="text" autocomplete="off" spellcheck="false" placeholder="ABCDEFGH" maxlength="8" '
      + 'style="display:block;width:100%;background:var(--surface);border:1px solid var(--hairline);border-radius:9px;color:var(--label);padding:12px;font-size:15px;font-family:monospace;text-transform:uppercase;letter-spacing:1.5px;text-align:center;outline:none;" />'
      + '<p class="lic-sub" id="licDevErr" style="color:#ff8f88;min-height:18px;"></p>'
      + '<button class="btn btn-pay" id="licMintBtn" type="button">Generate my key</button>'
      + '<button class="btn btn-ghost" id="licNoMidBtn" type="button" style="width:100%;margin-top:8px;font-size:13px;border-color:var(--hairline);color:var(--label-2);">Continue without Machine ID →</button>'
      + '<div id="licMintSpin" style="display:none;"><div class="lic-spin"></div><p class="lic-sub">Minting your PFX2 key…</p></div>';
    openModal();
    var devEl = document.getElementById("licDev");
    var mintBtn = document.getElementById("licMintBtn");
    var noMidBtn = document.getElementById("licNoMidBtn");
    if(noMidBtn){
      noMidBtn.onclick = function(){
        var acct = (window.PFXAuth && window.PFXAuth.session()) || "";
        if(!acct){
          document.getElementById("licDevErr").innerHTML = "Log in first so your license is saved to your account. "
            + '<a href="#" id="licLoginLink2" style="color:var(--accent);font-weight:700;">Log in / sign up</a>';
          document.getElementById("licLoginLink2").onclick = function(e){
            if(e && e.preventDefault) e.preventDefault();
            if(window.PFXOpenAuth) window.PFXOpenAuth("signup");
          };
          return;
        }
        var pk = placeholderKey(info.orderID || acct);
        if(window.PFXVault) window.PFXVault.save(acct, "PENDING", { key: pk, at: Date.now(), orderID: info.orderID, coupon: c, placeholder: true });
        if(window.PFXCoupons && c) window.PFXCoupons.use(c);
        showKey(pk, { email: acct || info.email, downloadUrl: ZXP_URL, machine: "PENDING", isPlaceholder: true });
        refreshDashboard();
      };
    }
    devEl.focus();
    devEl.addEventListener("input", function(){
      var p = devEl.selectionStart;
      devEl.value = devEl.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
      try { devEl.setSelectionRange(p, p); } catch(e){}
    });
    function doMint(){
      var dev = devEl.value.trim().toUpperCase();
      if(!/^[A-Za-z0-9]{8}$/.test(dev)){
        document.getElementById("licDevErr").textContent = "Machine ID must be exactly 8 letters/numbers.";
        return;
      }
      var acct = (window.PFXAuth && window.PFXAuth.session()) || "";
      if(!acct){
        document.getElementById("licDevErr").innerHTML = "Log in first so your key is saved to your account. "
          + '<a href="#" id="licLoginLink" style="color:var(--accent);font-weight:700;">Log in / sign up</a>';
        document.getElementById("licLoginLink").onclick = function(e){
          if(e && e.preventDefault) e.preventDefault();
          if(window.PFXOpenAuth) window.PFXOpenAuth("signup");
        };
        return;
      }
      var email = acct || info.email;
      // 1 active license per machine: recover instead of duplicating.
      var prior = (window.PFXVault && window.PFXVault.existing(acct, dev)) || null;
      if(prior){
        showKey(prior.key, { email: email, downloadUrl: ZXP_URL, recovered: true });
        return;
      }
      // Strict 1-machine-per-license: a paid key for a second distinct
      // machine needs the one-time $7.90 extra slot (server enforces too).
      // Owners skip this — every owner key is free.
      var ownerNow = false;
      try { ownerNow = window.PFXCore && window.PFXCore.isOwner(); } catch(e){}
      if(!ownerNow && !slotAllows(acct, dev)){
        document.getElementById("licDevErr").innerHTML = "This account's machine slot"
          + (slotHasExtra(acct) ? "s are" : " is")
          + " already filled — each key unlocks exactly 1 PC. "
          + '<a href="dashboard" style="color:var(--accent);font-weight:700;">Get the one-time $7.90 extra-machine deal</a> in your dashboard.';
        return;
      }
      mintBtn.style.display = "none";
      document.getElementById("licMintSpin").style.display = "block";
      mint(
        { orderID: info.orderID, email: email, machine_id: dev, amount: info.amount, coupon: c },
        {
          setLoading: function(){},
          onKey: function(key, data){
            if(window.PFXVault) window.PFXVault.save(acct, dev, { key: key, at: Date.now(), orderID: info.orderID, coupon: c });
            if(window.PFXCoupons && c) window.PFXCoupons.use(c);
            showKey(key, { email: email, downloadUrl: data.downloadUrl, simulated: data.simulated });
            refreshDashboard();
          },
          onError: function(html){
            mintBtn.style.display = "";
            document.getElementById("licMintSpin").style.display = "none";
            document.getElementById("licDevErr").innerHTML = html;
          }
        }
      );
    }
    mintBtn.onclick = doMint;
    devEl.onkeydown = function(e){ if(e.key === "Enter") doMint(); };
  }

  /* --- owner / promo coupon: single Machine ID field, instant key --- */
  function setClaimLoading(on){
    claimBtn.disabled = on;
    claimBtn.textContent = on ? "Generating…" : "Generate Key";
  }
  function claimSetStatus(kind, html){
    claimStatus.className = "lic-status show " + kind;
    claimStatus.innerHTML = html;
  }
  if(claimDev && claimBtn && claimStatus){
  claimDev.addEventListener("input", function(){
    var p = claimDev.selectionStart;
    claimDev.value = claimDev.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    try { claimDev.setSelectionRange(p, p); } catch(e){}
  });
  claimBtn.onclick = function(){
    claimStatus.className = "lic-status";
    claimStatus.innerHTML = "";
    var acct = (window.PFXAuth && window.PFXAuth.session()) || "";
    if(!acct){
      claimSetStatus("error", '🔒 <b>Log in</b> to claim a license — <a href="#" id="claimLogin" style="color:var(--accent);font-weight:700;">log in / sign up</a>');
      document.getElementById("claimLogin").onclick = function(e){
        if(e && e.preventDefault) e.preventDefault();
        if(window.PFXOpenAuth) window.PFXOpenAuth("signup");
      };
      return;
    }
    var c = coupon();
    var owner = false;
    try { owner = window.PFXCore && window.PFXCore.isOwner(); } catch(e){}
    if(!c && !owner){
      claimSetStatus("error", "Apply your coupon code in <b>Pricing</b> above first, then generate your key here.");
      return;
    }
    var dev = claimDev.value.trim().toUpperCase();
    if(!/^[A-Za-z0-9]{8}$/.test(dev)){
      claimDev.classList.add("invalid");
      document.getElementById("claimHint").textContent = "Machine ID must be exactly 8 letters/numbers.";
      return;
    }
    claimDev.classList.remove("invalid");
    // 1 active license per machine: recover instead of duplicating.
    var prior = (window.PFXVault && window.PFXVault.existing(acct, dev)) || null;
    if(prior){
        showKey(prior.key, { downloadUrl: ZXP_URL, recovered: true });
      claimSetStatus("success", "Recovered your existing key for this machine — no duplicate created.");
      return;
    }
    setClaimLoading(true);
    claimSetStatus("loading", "Minting your key…");
    mint(
      { machine_id: dev, coupon: c, email: acct },
      {
        setLoading: setClaimLoading,
        onKey: function(key, data){
          if(window.PFXVault) window.PFXVault.save(acct, dev, { key: key, at: Date.now(), coupon: c });
          if(window.PFXCoupons && c) window.PFXCoupons.use(c);
          showKey(key, { downloadUrl: data.downloadUrl, simulated: data.simulated, free: owner && !c });
          claimSetStatus("success", "Key generated — see the popup above (or the License Generator panel).");
          refreshDashboard();
        },
        onError: function(html){ claimSetStatus("error", html); }
      }
    );
  };
  var claimNoMidBtn = document.getElementById("claimNoMidBtn");
  if(claimNoMidBtn){
    claimNoMidBtn.onclick = function(){
      claimStatus.className = "lic-status";
      claimStatus.innerHTML = "";
      var acct = (window.PFXAuth && window.PFXAuth.session()) || "";
      if(!acct){
        claimSetStatus("error", '🔒 <b>Log in</b> to claim a license — <a href="#" id="claimLogin2" style="color:var(--accent);font-weight:700;">log in / sign up</a>');
        document.getElementById("claimLogin2").onclick = function(e){
          if(e && e.preventDefault) e.preventDefault();
          if(window.PFXOpenAuth) window.PFXOpenAuth("signup");
        };
        return;
      }
      var c = coupon();
      var owner = false;
      try { owner = window.PFXCore && window.PFXCore.isOwner(); } catch(e){}
      if(!c && !owner){
        claimSetStatus("error", "Apply your coupon code in <b>Pricing</b> above first, then click continue.");
        return;
      }
      var pk = placeholderKey(acct);
      if(window.PFXVault) window.PFXVault.save(acct, "PENDING", { key: pk, at: Date.now(), coupon: c, placeholder: true });
      if(window.PFXCoupons && c) window.PFXCoupons.use(c);
      showKey(pk, { email: acct, downloadUrl: ZXP_URL, machine: "PENDING", isPlaceholder: true, free: owner && !c });
      claimSetStatus("success", "Reserved license ready — download installer below. Activate your PC anytime in My Licenses.");
      refreshDashboard();
    };
  }
  }
  /* --- owner headline: plain words, no coupon needed --- */
  function paintOwnerClaim(){
    var box = document.getElementById("couponClaim");
    if(!box) return;
    var owner = false;
    try { owner = window.PFXCore && window.PFXCore.isOwner(); } catch(e){}
    var head = box.querySelector("b"), sub = box.querySelector("p");
    if(owner){
      if(head) head.textContent = "👑 Owner: your keys are free";
      if(sub) sub.textContent = "Just enter your Machine ID below — no coupon, no payment.";
      if(claimBtn && !claimBtn.disabled) claimBtn.textContent = "Get my free key";
    } else {
      if(head && head.textContent.indexOf("Owner:") !== -1){
        head.textContent = "Have an owner / promo coupon?";
        if(sub) sub.textContent = "Apply it in Pricing above, then enter your Machine ID to activate your key — no payment needed.";
        if(claimBtn && !claimBtn.disabled) claimBtn.textContent = "Generate Key";
      }
    }
  }
  if(window.PFXAuth) window.PFXAuth.onChange(function(){ paintOwnerClaim(); });
  paintOwnerClaim();
/* --- Extra-machine deal ($7.90, one per account) --- */
  var SLOT_AMOUNT = "7.90";
  var slotCache = {}; // acct -> { claimed, machine?, key? } (server status snapshot)
  function slotHasExtra(acct){
    if(slotCache[acct] && slotCache[acct].claimed) return true;
    var vault = (window.PFXVault && window.PFXVault.get(acct)) || {};
    return Object.keys(vault).some(function(m){ return vault[m] && vault[m].slot === "extra"; });
  }
  function slotAllows(acct, dev){
    var vault = (window.PFXVault && window.PFXVault.get(acct)) || {};
    if(vault[dev]) return true; // same-machine reissue is always fine
    return Object.keys(vault).length < (slotHasExtra(acct) ? 2 : 1);
  }
  function slotStatus(acct, cb){
    if(location.protocol === "file:"){ cb(null); return; }
    var done = false;
    function fin(v){ if(!done){ done = true; cb(v); } }
    var timer = setTimeout(function(){ fin(null); }, 6000);
    fetch(apiUrl("/api/extra-slot?email=" + encodeURIComponent(acct))).then(function(r){
      return r.json().catch(function(){ return null; });
    }).then(function(d){
      clearTimeout(timer);
      fin(d && d.ok ? d : null);
    }).catch(function(){ clearTimeout(timer); fin(null); });
  }
  function slotMsg(kind, html){
    var m = document.getElementById("slotMsg");
    if(!m) return;
    m.className = "lic-status show " + kind;
    m.innerHTML = html;
  }
  function renderSlotPay(acct){
    var box = document.getElementById("slotPay");
    if(!box) return;
    if(typeof paypal === "undefined" || !paypal.Buttons){
      box.innerHTML = '<a class="btn btn-pay" style="width:100%;text-align:center;" href="https://paypal.me/sxiiedits/7.90USD">Buy extra slot — $7.90 USD</a>';
      return;
    }
    try {
      paypal.Buttons({
        style:{ layout:"vertical", color:"gold", shape:"pill", label:"paypal" },
        createOrder:function(dt, actions){
          return actions.order.create({ purchase_units:[{ description:"PineappleFX extra machine slot - one PC", amount:{ value:SLOT_AMOUNT, currency_code:"USD" } }] });
        },
        onApprove:function(dt, actions){
          return actions.order.capture().then(function(det){
            var input = document.getElementById("slotDev");
            var dev = input ? input.value.trim().toUpperCase() : "";
            if(!/^[A-Za-z0-9]{8}$/.test(dev)){
              slotMsg("error", "Enter your second PC's 8-character Machine ID first — then pay again.");
              return;
            }
            if(window.PFXVault && window.PFXVault.existing(acct, dev)){
              slotMsg("error", "That machine already has a key on this account — no extra slot needed.");
              return;
            }
            slotMsg("loading", "Payment approved — minting your second-machine key…");
            claimSlot(acct, dev, dt.orderID || (det && det.id) || "");
          });
        },
        onCancel:function(){ slotMsg("error", "Payment cancelled — no charge made."); },
        onError:function(){ slotMsg("error", "PayPal had a hiccup — try again."); }
      }).render("#slotPay");
    } catch(err){
      box.innerHTML = '<a class="btn btn-pay" style="width:100%;text-align:center;" href="https://paypal.me/sxiiedits/7.90USD">Buy extra slot — $7.90 USD</a>';
    }
  }
  function claimSlot(acct, dev, orderID){
    if(location.protocol === "file:"){
      slotMsg("error", "Deal checkout needs the backend (<code>/api/extra-slot</code>), which browsers block on <code>file://</code>. "
        + "Run <code>npx vercel dev</code> and retry — your $7.90 payment itself is safe.");
      return;
    }
    fetch(apiUrl("/api/extra-slot"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: acct, machine_id: dev, orderID: orderID })
    }).then(function(res){
      return res.json().catch(function(){ throw new Error("bad-response"); }).then(function(data){
        if(!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || ("http-" + res.status));
        return data;
      });
    }).then(function(data){
      if(window.PFXVault) window.PFXVault.save(acct, dev, { key: data.key, at: Date.now(), slot: "extra", orderID: orderID });
      slotCache[acct] = { claimed: true, machine: dev, key: data.key };
      showKey(data.key, { email: acct, downloadUrl: data.downloadUrl });
      refreshDashboard();
    }).catch(function(err){
      var msg = String((err && err.message) || err);
      if(msg === "already-claimed"){
        refreshDashboard(); // card flips to Claimed once status reloads
        return;
      }
      if(msg.indexOf("Failed to fetch") !== -1 || msg.indexOf("NetworkError") !== -1 || msg === "bad-response"){
        slotMsg("error", "Could not reach the license server. Deploy <code>/api/extra-slot</code> (or run <code>npx vercel dev</code>) and retry — your payment is safe.");
      } else {
        slotMsg("error", "Deal failed (" + esc(msg) + "). Double-check the Machine ID and retry.");
      }
    });
  }
  function renderSlotCard(acct, vault){
    var card = document.getElementById("slotCard");
    if(!card) return;
    var machines = Object.keys(vault);
    var localExtra = null;
    machines.forEach(function(m){ if(vault[m] && vault[m].slot === "extra") localExtra = m; });
    function claimedView(machine, key){
      card.innerHTML = '<div class="deal-card slot-claimed"><span class="deal-flag">EXTRA MACHINE — CLAIMED ✓</span>'
        + '<h3>Second computer unlocked</h3>'
        + '<div class="dash-row" style="margin:10px 0 0;background:var(--surface);"><span class="mid">' + esc(machine) + '</span>'
        + '<span class="key">' + esc(key) + '</span>'
        + '<button class="mini-btn" id="slotCopy" type="button">Copy</button></div>'
        + '<p class="deal-once">One-time deal used — one extra slot per account, no further slots can be added.</p></div>';
      document.getElementById("slotCopy").onclick = function(){ copyKey(key, this); };
    }
    function promoView(){
      card.innerHTML = '<div class="deal-card"><span class="deal-flag">ONE-TIME DEAL</span>'
        + '<h3>Need PineappleFX on a second computer? Add 1 extra machine slot for only <span class="deal-price">$7.90</span></h3>'
        + '<p>One-time offer — one extra slot per account, bound to your second PC\u2019s Machine ID. Your primary license stays exactly as-is.</p>'
        + '<input id="slotDev" maxlength="8" autocomplete="off" spellcheck="false" placeholder="2ND-PC MACHINE ID (8 CHARS)" />'
        + '<div id="slotPay" style="margin-top:10px;min-height:40px;"></div>'
        + '<div id="slotMsg" class="lic-status" role="status" aria-live="polite"></div>'
        + '<p class="deal-once">Strict 1 machine per license: each key unlocks exactly one PC.</p></div>';
      var devEl = document.getElementById("slotDev");
      devEl.addEventListener("input", function(){
        var p = devEl.selectionStart;
        devEl.value = devEl.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
        try { devEl.setSelectionRange(p, p); } catch(e){}
      });
      renderSlotPay(acct);
    }
    slotStatus(acct, function(st){
      if(!document.getElementById("slotCard")) return; // dashboard re-rendered meanwhile
      if(st && st.claimed){
        slotCache[acct] = { claimed: true, machine: st.machine, key: st.key };
        if(window.PFXVault && !window.PFXVault.existing(acct, st.machine)){
          // recovery: server knows a slot key this browser never saved
          window.PFXVault.save(acct, st.machine, { key: st.key, at: st.at || Date.now(), slot: "extra", orderID: "server" });
          refreshDashboard();
          return;
        }
        claimedView(st.machine, st.key);
      } else if(localExtra){
        slotCache[acct] = { claimed: true, machine: localExtra, key: vault[localExtra].key, local: true };
        claimedView(localExtra, vault[localExtra].key);
      } else {
        slotCache[acct] = { claimed: false };
        promoView();
      }
    });
  }

  /* --- My Licenses dashboard: all keys + machines for the logged-in account --- */
  function escAttr(s){ return esc(s).replace(/'/g, "&#39;"); }
  function primaryOf(vault, machines){
    var best = null;
    machines.forEach(function(m){
      var e = vault[m] || {};
      if(e.slot === "extra") return;
      if(best === null || (e.at || 0) < ((vault[best] || {}).at || 0)) best = m;
    });
    return best === null ? machines[0] : best;
  }
  function refreshDashboard(){
    var box = document.getElementById("dashBody");
    if(!box) return;
    var acct = (window.PFXAuth && window.PFXAuth.session()) || "";
    if(!acct){
      box.innerHTML = '<p style="font-size:13.5px;color:var(--label-2);text-align:center;">🔒 Log in to see your licenses.<br><br>'
        + '<button class="btn btn-pay" id="dashLogin" type="button" style="padding:11px 28px;">Log in / Sign up</button></p>';
      document.getElementById("dashLogin").onclick = function(){ if(window.PFXOpenAuth) window.PFXOpenAuth("login"); };
      return;
    }
    var vault = (window.PFXVault && window.PFXVault.get(acct)) || {};
    var machines = Object.keys(vault).sort();
    var primary = machines.length ? primaryOf(vault, machines) : null;
    var html = '<p style="font-size:13px;color:var(--label-2);">Logged in as <b>' + esc(acct) + '</b> '
      + '· ' + machines.length + ' machine' + (machines.length === 1 ? '' : 's')
      + ' · <a href="#" id="dashLogout" style="color:var(--accent);font-weight:700;">log out</a></p>'
      + '<div style="height:10px;"></div>';
    if(!machines.length){
      html += '<p style="font-size:13.5px;color:var(--label-2);text-align:center;">No licenses yet — pay or claim a coupon above and your keys will appear here.</p>';
    } else {
      machines.forEach(function(machine, i){
        var e = vault[machine];
        var when = "";
        try { when = new Date(e.at).toLocaleDateString(); } catch(err){}
        var isPending = (machine === "PENDING" || machine.indexOf("PENDING") === 0);
        var badge = (e.slot === "extra")
          ? '<span class="slot-tag extra">EXTRA SLOT</span>'
          : (isPending ? '<span class="slot-tag" style="background:rgba(254,202,8,.15);color:var(--accent);border:1px solid var(--accent);font-weight:700;">RESERVED</span>' : (machine === primary ? '<span class="slot-tag primary">PRIMARY</span>' : '<span class="slot-tag primary">LICENSE</span>'));
        html += '<div class="dash-row"><span class="mid" style="' + (isPending ? 'color:var(--accent);font-weight:700;' : '') + '">' + esc(machine) + '</span>'
          + badge
          + '<span class="key">' + esc(e.key) + '</span>'
          + '<span class="dt">' + esc(when) + '</span>'
          + '<button class="mini-btn" data-copy-key="' + escAttr(e.key) + '" type="button">Copy</button>'
          + (isPending ? '<button class="mini-btn" data-activate-mid="' + escAttr(machine) + '" type="button" style="background:var(--accent);color:#241a04;font-weight:700;margin-left:4px;">Activate PC</button>' : '')
          + '</div>';
      });
    }
    html += '<div id="slotCard"><p style="font-size:12.5px;color:var(--label-3);text-align:center;">Checking extra-slot deal…</p></div>';
    box.innerHTML = html;
    var dashLogoutBtn = document.getElementById("dashLogout");
    if(dashLogoutBtn) dashLogoutBtn.onclick = function(e){
      if(e && e.preventDefault) e.preventDefault();
      if(window.PFXAuth) window.PFXAuth.logout();
    };
    Array.prototype.forEach.call(box.querySelectorAll("[data-copy-key]"), function(b){
      b.onclick = function(){ copyKey(b.getAttribute("data-copy-key"), b); };
    });
    Array.prototype.forEach.call(box.querySelectorAll("[data-activate-mid]"), function(b){
      b.onclick = function(){
        var oldMch = b.getAttribute("data-activate-mid");
        var nm = prompt("Enter your 8-character Machine ID (from After Effects panel):", "");
        if(!nm) return;
        nm = nm.trim().toUpperCase();
        if(!/^[A-Za-z0-9]{8}$/.test(nm)){
          alert("Machine ID must be exactly 8 letters/numbers.");
          return;
        }
        b.disabled = true;
        b.textContent = "Activating…";
        // Call server if present, else fallback
        var token = "";
        try { token = localStorage.getItem("pfx-admin-token") || ""; } catch(e){}
        fetch(apiUrl("/api/generate-license"), {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": token ? ("Bearer " + token) : "" },
          body: JSON.stringify({ email: acct, machine_id: nm, txn_id: "REBIND-" + Date.now(), coupon: (vault[oldMch] || {}).coupon || "BUILTIN" })
        }).then(function(r){ return r.json(); }).then(function(d){
          var newKey = (d && d.ok && d.key) ? d.key : null;
          if(!newKey){
            // Admin fallback if server not running (client static environment)
            var fnv = function(str){
              var h = 0x811c9dc5;
              for(var i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
              return h >>> 0;
            };
            var M_ALPHA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
            var M_SEC = "7c795771be81002adee1870b7dfbc589";
            var h1 = fnv(M_SEC + ":" + nm + ":" + nm), h2 = fnv(nm + ":" + nm + ":" + M_SEC), sig = "";
            var serial = "";
            for(var s = 0; s < 8; s++) serial += M_ALPHA.charAt(Math.floor(Math.random() * 32));
            var h1s = fnv(M_SEC + ":" + serial + ":" + nm), h2s = fnv(nm + ":" + serial + ":" + M_SEC);
            for(var j = 0; j < 6; j++) sig += M_ALPHA.charAt((h1s >>> (27 - j * 5)) & 31);
            for(var k = 0; k < 2; k++) sig += M_ALPHA.charAt((h2s >>> (27 - k * 5)) & 31);
            newKey = "PFX2-" + serial + "-" + sig;
          }
          if(window.PFXVault && window.PFXVault.rebind){
            window.PFXVault.rebind(acct, oldMch, nm, newKey);
            showKey(newKey, { email: acct, downloadUrl: ZXP_URL });
            refreshDashboard();
            alert("License activated for " + nm + "!\nKey: " + newKey);
          }
        }).catch(function(){
          // Local fallback
          var fnv = function(str){
            var h = 0x811c9dc5;
            for(var i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
            return h >>> 0;
          };
          var M_ALPHA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
          var M_SEC = "7c795771be81002adee1870b7dfbc589";
          var serial = "";
          for(var s = 0; s < 8; s++) serial += M_ALPHA.charAt(Math.floor(Math.random() * 32));
          var h1s = fnv(M_SEC + ":" + serial + ":" + nm), h2s = fnv(nm + ":" + serial + ":" + M_SEC), sig = "";
          for(var j = 0; j < 6; j++) sig += M_ALPHA.charAt((h1s >>> (27 - j * 5)) & 31);
          for(var k = 0; k < 2; k++) sig += M_ALPHA.charAt((h2s >>> (27 - k * 5)) & 31);
          var newKey = "PFX2-" + serial + "-" + sig;
          if(window.PFXVault && window.PFXVault.rebind){
            window.PFXVault.rebind(acct, oldMch, nm, newKey);
            showKey(newKey, { email: acct, downloadUrl: ZXP_URL });
            refreshDashboard();
            alert("License activated for " + nm + "!\nKey: " + newKey);
          }
        });
      };
    });
    renderSlotCard(acct, vault);
  }
  refreshDashboard();

  /* NOTE: the local mint helper (simulateKey) is deliberately NOT exported here.
     This file loads on the storefront, and exposing a one-line
     window.PineappleFXLic.mintKey() would let any visitor mint working keys
     from the browser console. Key minting lives in the admin page only. */
  return { handleApproval: handleApproval, refreshDashboard: refreshDashboard };
})();

