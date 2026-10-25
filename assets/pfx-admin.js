/* PineappleFX admin panel (admin page only). Requires pfx-core.js. */
(function(){
  var lsGet = window.PFXCore.lsGet, lsSet = window.PFXCore.lsSet;
  var authUsers = window.PFXCore.authUsers, couponDef = window.PFXCore.couponDef;
  var basePrice = window.PFXCore.basePrice, paintCoupon = window.PFXCore.paintCoupon;
  var ADMIN_EMAIL = window.PFXCore.ADMIN_EMAIL || "pineapplefx.store@gmail.com";
  var isAdmin = window.PFXCore.isAdmin;

  function apiUrl(p){
    try { if(window.PFXApi) return window.PFXApi(p); } catch(e){}
    return p;
  }

  /* ---- Admin-only local key mint (backup when the server is down) ----
     Deliberately lives here (admin.html only) and NOT in pfx-licensing.js,
     which loads on the public storefront — exposing a mint helper there would
     let any visitor generate working keys from the browser console.
     Same FNV-1a scheme as the panel gate, so minted keys unlock the panel. */
  var ADMIN_MINT_SECRET = "7c795771be81002adee1870b7dfbc589";
  var MINT_ALPHA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  function mintFnv(str){
    var h = 0x811c9dc5;
    for(var i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  function mintSig(serial, device){
    var h1 = mintFnv(ADMIN_MINT_SECRET + ":" + serial + ":" + device),
        h2 = mintFnv(device + ":" + serial + ":" + ADMIN_MINT_SECRET), s = "";
    for(var i = 0; i < 6; i++){ s += MINT_ALPHA.charAt((h1 >>> (27 - i * 5)) & 31); }
    for(var j = 0; j < 2; j++){ s += MINT_ALPHA.charAt((h2 >>> (27 - j * 5)) & 31); }
    return s;
  }
  function adminMintKey(machineId){
    var dev = String(machineId || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if(dev.length !== 8) return "";
    var serial = "";
    for(var i = 0; i < 8; i++){ serial += MINT_ALPHA.charAt(Math.floor(Math.random() * 32)); }
    return "PFX2-" + serial + "-" + mintSig(serial, dev);
  }

  /* ---- UI Toast notifications ---- */
  function showToast(msg){
    var t = document.getElementById("mToast");
    if(!t){
      t = document.createElement("div");
      t.id = "mToast";
      t.style.cssText = "position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#1e1e22;color:#f5f5f4;border:1px solid #feca08;border-radius:999px;padding:10px 24px;font-size:13px;font-weight:600;z-index:9999;box-shadow:0 12px 30px rgba(0,0,0,.6);white-space:nowrap;transition:opacity 0.2s ease;";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.display = "block";
    t.style.opacity = "1";
    clearTimeout(t.__timer);
    t.__timer = setTimeout(function(){
      t.style.opacity = "0";
      setTimeout(function(){ t.style.display = "none"; }, 200);
    }, 3500);
  }
  window.PFXToast = showToast;

  /* ---- Confirmation Modal Helper ---- */
  function openConfirmModal(opts){
    // opts: { title, message, requireText, confirmText, isDanger }
    return new Promise(function(resolve){
      var modal = document.getElementById("confirmModal");
      if(!modal){
        // fallback to standard confirm/prompt if modal not present
        if(opts.requireText){
          var val = prompt(opts.title + "\n\n" + (opts.message || "").replace(/<[^>]+>/g, "") + "\n\nType " + opts.requireText + " to confirm:");
          resolve(val === opts.requireText);
        } else {
          resolve(confirm(opts.title + "\n\n" + (opts.message || "").replace(/<[^>]+>/g, "")));
        }
        return;
      }
      var titleEl = document.getElementById("confirmTitle");
      var msgEl = document.getElementById("confirmMessage");
      var inputWrap = document.getElementById("confirmInputWrap");
      var input = document.getElementById("confirmInput");
      var inputErr = document.getElementById("confirmInputErr");
      var cancelBtn = document.getElementById("confirmCancelBtn");
      var proceedBtn = document.getElementById("confirmProceedBtn");

      if(titleEl) titleEl.textContent = opts.title || "Confirm Action";
      if(msgEl) msgEl.innerHTML = opts.message || "Are you sure you want to proceed?";
      if(proceedBtn){
        proceedBtn.textContent = opts.confirmText || "Confirm";
        proceedBtn.className = (opts.isDanger !== false) ? "danger-btn" : "btn btn-pay";
      }

      if(inputWrap && input){
        if(opts.requireText){
          inputWrap.style.display = "block";
          input.value = "";
          if(inputErr) inputErr.textContent = "";
          setTimeout(function(){ input.focus(); }, 60);
        } else {
          inputWrap.style.display = "none";
        }
      }

      modal.style.display = "flex";
      modal.classList.add("open");

      function cleanup(){
        modal.style.display = "none";
        modal.classList.remove("open");
        if(cancelBtn) cancelBtn.onclick = null;
        if(proceedBtn) proceedBtn.onclick = null;
        if(input) input.onkeydown = null;
      }

      if(cancelBtn){
        cancelBtn.onclick = function(){
          cleanup();
          resolve(false);
        };
      }

      function onProceed(){
        if(opts.requireText && input){
          if(input.value.trim() !== opts.requireText){
            if(inputErr) inputErr.textContent = 'Please type "' + opts.requireText + '" exactly to confirm.';
            input.focus();
            return;
          }
        }
        cleanup();
        resolve(true);
      }

      if(proceedBtn) proceedBtn.onclick = onProceed;
      if(input){
        input.onkeydown = function(e){
          if(e.key === "Enter") onProceed();
          if(e.key === "Escape"){ cleanup(); resolve(false); }
        };
      }
    });
  }

  function randomCouponCode(){
    var A = "ABCDEFGHJKMNPQRSTVWXYZ23456789", s = "";
    for(var i = 0; i < 8; i++) s += A.charAt(Math.floor(Math.random() * A.length));
    return "PFX-" + s.slice(0, 4) + "-" + s.slice(4);
  }

  function paidEstimate(){
    var v = lsGet("pfx-licenses", {}), n = 0;
    Object.keys(v).forEach(function(em){
      Object.keys(v[em]).forEach(function(mch){
        var e = v[em][mch] || {};
        var d = e.coupon ? couponDef(e.coupon) : null;
        if(!d || d.kind !== "free") n++;
      });
    });
    return n;
  }

  /* ---- server-backed admin (live DB) with local-mode fallback ---- */
  window.PFXServer = {
    token: function(){ try { return localStorage.getItem("pfx-admin-token") || ""; } catch(e){ return ""; } },
    live: function(){ return !!window.PFXServer.token(); },
    api: function(action, payload){
      payload = payload || {};
      payload.action = action;
      return fetch(apiUrl("/api/admin"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + window.PFXServer.token() },
        body: JSON.stringify(payload)
      }).then(function(r){
        return r.json().then(function(d){
          if(r.status === 401 || r.status === 403){ window.PFXServer.drop(); throw new Error("session-expired"); }
          return d;
        });
      });
    },
    deleteCoupon: function(code){
      return fetch(apiUrl("/api/admin/coupons"), {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + window.PFXServer.token() },
        body: JSON.stringify({ code: code })
      }).then(function(r){
        return r.json().then(function(d){
          if(r.status === 401 || r.status === 403){ window.PFXServer.drop(); throw new Error("session-expired"); }
          return d;
        });
      });
    },
    drop: function(){
      try {
        localStorage.removeItem("pfx-admin-token");
        localStorage.removeItem("pfx-is-admin");
      } catch(e){}
      paintServerChrome();
      paintLockState();
      renderAdmin();
    }
  };

  function paintLockState(){
    var adm = false;
    try { adm = window.PFXCore && window.PFXCore.isAdmin(); } catch(e){}
    var locked = document.getElementById("adminLocked");
    if(locked) locked.style.display = adm ? "none" : "";
    var sec = document.getElementById("admin");
    if(sec) sec.style.display = adm ? "" : "none";
    var navA = document.getElementById("navAdmin");
    if(navA) navA.style.display = adm ? "" : "none";
    var menuA = document.getElementById("menuAdmin");
    if(menuA) menuA.style.display = adm ? "" : "none";
  }

  function paintServerChrome(){
    var live = window.PFXServer.live() && (window.PFXCore ? window.PFXCore.isAdmin() : true);
    var badge = document.getElementById("srvBadge");
    if(badge){
      badge.textContent = live ? "🟢 connected" : "○ local mode";
      badge.style.color = live ? "#22c55e" : "var(--label-2)";
      badge.style.borderColor = live ? "#22c55e" : "var(--hairline)";
    }
    var form = document.getElementById("srvForm");
    if(form) form.style.display = live ? "none" : "";
    var disc = document.getElementById("srvDisconnect");
    if(disc) disc.style.display = live ? "" : "none";
    var hint = document.getElementById("srvHint");
    if(hint){
      hint.textContent = live
        ? "Connected — the lists below are live shop data. Changes work right away."
        : "Local mode: you only see this browser's data. Type your admin password to see live shop data on all devices.";
    }
    var pc = document.getElementById("priceCard");
    if(pc) pc.style.display = live ? "" : "none";
  }

  function connectWithPassword(pw, errEl, btnEl){
    if(!pw){
      if(errEl) errEl.textContent = "Enter the server admin password.";
      return;
    }
    if(errEl) errEl.textContent = "";
    if(btnEl){
      btnEl.disabled = true;
      btnEl.textContent = "Connecting…";
    }
    fetch(apiUrl("/api/auth"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "login", email: ADMIN_EMAIL, password: pw })
    }).then(function(r){
      return r.json().then(function(d){ return { status: r.status, body: d }; });
    }).then(function(x){
      if(btnEl){
        btnEl.disabled = false;
        btnEl.textContent = btnEl.getAttribute("data-orig-text") || "Connect to server";
      }
      if(!x.body || !x.body.ok || !x.body.is_admin){
        if(errEl){
          errEl.textContent = x.body && x.body.error === "bad-credentials"
            ? "Wrong password (or not an admin account on the server)."
            : "Login failed (" + ((x.body && x.body.error) || ("http-" + x.status)) + "). Is the API deployed?";
        }
        return;
      }
      try {
        localStorage.setItem("pfx-admin-token", x.body.token);
        localStorage.setItem("pfx-session", ADMIN_EMAIL);
        localStorage.setItem("pfx-is-admin", "true");
      } catch(e){}
      var passInput = document.getElementById("srvPass");
      if(passInput) passInput.value = "";
      var lockedInput = document.getElementById("adminLockedPass");
      if(lockedInput) lockedInput.value = "";

      paintLockState();
      paintServerChrome();
      renderAdmin();
      refreshServerPricing();
      showToast("🟢 Connected to server as Admin");
    }).catch(function(){
      if(btnEl){
        btnEl.disabled = false;
        btnEl.textContent = btnEl.getAttribute("data-orig-text") || "Connect to server";
      }
      if(errEl) errEl.textContent = "No API here — deploy the backend or run it locally first.";
    });
  }

  // Bind server connect in #srvCard
  var srvBtn = document.getElementById("srvConnect");
  if(srvBtn){
    srvBtn.setAttribute("data-orig-text", "Connect to server");
    srvBtn.onclick = function(){
      var pw = document.getElementById("srvPass").value;
      connectWithPassword(pw, document.getElementById("srvErr"), srvBtn);
    };
  }
  var srvPassEl = document.getElementById("srvPass");
  if(srvPassEl){
    srvPassEl.onkeydown = function(e){
      if(e.key === "Enter" && srvBtn) srvBtn.click();
    };
  }

  // Bind locked area quick login
  var lockedSubmit = document.getElementById("adminLockedSubmit");
  if(lockedSubmit){
    lockedSubmit.setAttribute("data-orig-text", "Connect & Authenticate");
    lockedSubmit.onclick = function(){
      var pw = (document.getElementById("adminLockedPass") || {}).value;
      connectWithPassword(pw, document.getElementById("adminLockedErr"), lockedSubmit);
    };
  }
  var lockedPassEl = document.getElementById("adminLockedPass");
  if(lockedPassEl){
    lockedPassEl.onkeydown = function(e){
      if(e.key === "Enter" && lockedSubmit) lockedSubmit.click();
    };
  }

  var srvDiscBtn = document.getElementById("srvDisconnect");
  if(srvDiscBtn) srvDiscBtn.onclick = function(){ window.PFXServer.drop(); };

  var prSaveBtn = document.getElementById("prSave");
  if(prSaveBtn){
    prSaveBtn.onclick = function(){
      var err = document.getElementById("prErr");
      err.textContent = "";
      window.PFXServer.api("pricing-set", {
        regular: document.getElementById("prReg").value || undefined,
        launch: document.getElementById("prLaunch").value || undefined,
        launchEnd: document.getElementById("prEnd").value || undefined
      }).then(function(d){
        if(!d.ok){ err.textContent = "Save failed (" + (d.error || "?") + ")."; return; }
        showToast("Pricing saved successfully");
        refreshServerPricing();
        renderAdmin();
      }).catch(function(e){
        err.textContent = String(e && e.message) === "session-expired" ? "Session expired — reconnect." : "Save failed.";
      });
    };
  }

  function renderAdminServer(){
    var box = document.getElementById("adminStats");
    if(box) box.innerHTML = '<p style="font-size:13px;color:var(--label-2);">Loading live data…</p>';
    window.PFXServer.api("overview", {}).then(function(o){
      if(!o.ok) throw new Error(o.error || "?");
      if(box){
        box.innerHTML =
          statCard(o.users, "accounts")
          + statCard(o.active + " / " + o.licenses, "active / issued")
          + statCard(o.coupons, "coupons")
          + statCard("$" + o.revenueEst, "est. revenue")
          + (o.ephemeral ? '<p class="lic-sim">⚠ Server DB is ephemeral here — set DATA_DIR to persist.</p>' : "");
      }
      var ab = document.getElementById("auditBox");
      if(ab){
        ab.innerHTML = "<b style=\"font-size:13px;\">Live audit log</b>" + ((o.audit || []).map(function(a){
          return '<div class="dash-row" style="margin:6px 0 0;"><span class="dt">' + escHtml((a.at || "").slice(0, 16).replace("T", " ")) + '</span>'
            + '<span class="key">' + escHtml(a.actor + " · " + a.action + (a.detail ? " · " + a.detail : "")) + '</span></div>';
        }).join("") || '<p style="font-size:12.5px;color:var(--label-3);">No events yet.</p>');
      }
      var prReg = document.getElementById("prReg");
      if(prReg) prReg.value = (o.pricing && o.pricing.regular) || "";
    }).catch(function(){
      if(box) box.innerHTML = '<p style="font-size:13px;color:#ff8f88;">Server unreachable — reconnect.</p>';
    });

    // coupons (server)
    window.PFXServer.api("coupons", {}).then(function(d){
      var cl = document.getElementById("couponList"), html = "";
      var all = Object.assign({}, d.builtin || {}, d.coupons || {});
      Object.keys(all).sort().forEach(function(code){
        var c = all[code];
        var tag = c.kind === "free" ? "FREE" : (c.pct + "% OFF");
        var uses = c.builtin ? "built-in" : ((c.uses || 0) + (c.maxUses != null ? "/" + c.maxUses : " uses") + " · server");
        html += '<div class="coupon-row"><code>' + escHtml(code) + '</code><span class="tag">' + tag + '</span>'
          + '<span class="note">' + escHtml(c.note || "") + ' · ' + escHtml(uses) + '</span>'
          + (c.builtin ? "" : '<button class="danger-btn del-cpn-btn" data-sdel-coupon="' + escHtml(code) + '" type="button" title="Delete Coupon">🗑 Delete Coupon</button>')
          + '</div>';
      });
      if(cl){
        cl.innerHTML = html || '<p style="font-size:13px;color:var(--label-2);">No coupons yet.</p>';
        Array.prototype.forEach.call(cl.querySelectorAll("[data-sdel-coupon]"), function(b){
          b.onclick = function(){
            var code = b.getAttribute("data-sdel-coupon");
            openConfirmModal({
              title: "Delete Coupon",
              message: "Are you sure you want to permanently delete coupon code <code>" + escHtml(code) + "</code>?<br><br>This will purge the code from both server DB state and local cache, preventing future redemptions.",
              confirmText: "Delete Coupon",
              isDanger: true
            }).then(function(confirmed){
              if(!confirmed) return;
              window.PFXServer.deleteCoupon(code).then(function(r){
                if(!r.ok){ showToast("Delete failed (" + (r.error || "?") + ")"); return; }
                // Purge local cache too
                if(window.PFXCoupons && window.PFXCoupons.remove) window.PFXCoupons.remove(code);
                try {
                  var lc = localStorage.getItem("pineapplefx-coupon");
                  if(lc && lc.toUpperCase() === code.toUpperCase()) localStorage.removeItem("pineapplefx-coupon");
                } catch(e){}
                showToast("Coupon deleted successfully");
                renderAdmin();
                paintCoupon();
              }).catch(function(){ showToast("Server unreachable."); });
            });
          };
        });
      }
    }).catch(function(){});

    // users + licenses (server)
    window.PFXServer.api("users", {}).then(function(d){
      window.PFXServer.api("licenses", {}).then(function(l){
        var ub = document.getElementById("adminUsers"), uh = "";
        var byUser = {};
        (l.licenses || []).forEach(function(r){
          if(!byUser[r.email]) byUser[r.email] = [];
          byUser[r.email].push(r);
        });
        (d.users || []).forEach(function(u){
          var rows = byUser[u.email] || [];
          var isOwner = (u.email === ADMIN_EMAIL);
          var statusBadge = u.disabled
            ? '<span class="tag" style="background:rgba(255,77,79,0.15);color:#ff4d4f;border:1px solid #ff4d4f;font-size:10px;font-weight:700;">DEACTIVATED</span>'
            : '<span class="tag" style="background:rgba(34,197,94,0.15);color:#22c55e;border:1px solid #22c55e;font-size:10px;font-weight:700;">ACTIVE</span>';

          uh += '<div class="user-block" style="padding:14px;border:1px solid var(--hairline);border-radius:10px;margin-bottom:12px;background:var(--card-bg, #1a1a1e);">'
            + '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">'
            + '<div><b>' + escHtml(u.email) + '</b> '
            + (u.is_admin ? '<span class="tag" style="font-size:10px;font-weight:800;">ADMIN</span> ' : '')
            + statusBadge
            + ' <span style="color:var(--label-3);font-size:12px;">· ' + rows.length + ' key' + (rows.length === 1 ? '' : 's') + '</span></div>'
            + '<div style="display:flex;gap:6px;">'
            + (!isOwner ? (u.disabled
                ? '<button class="mini-btn activate-btn" data-sactivate="' + escHtml(u.email) + '" type="button">Reactivate Account</button>'
                : '<button class="mini-btn deactivate-btn" data-sdeactivate="' + escHtml(u.email) + '" type="button">Deactivate Account</button>') : '')
            + (!isOwner ? '<button class="danger-btn del-user-btn" data-sdelete-user="' + escHtml(u.email) + '" type="button">Delete Account</button>' : '')
            + '</div>'
            + '</div>';

          rows.forEach(function(r){
            uh += '<div class="dash-row" style="margin:10px 0 0;padding:8px;background:rgba(0,0,0,0.18);border-radius:6px;">'
              + '<span class="mid" style="font-family:monospace;font-size:12px;">' + escHtml(r.machine || "?") + '</span>'
              + '<span class="key" style="font-family:monospace;font-size:12px;">' + escHtml(r.key) + (r.revoked ? ' <b style="color:#ff8f88;">(REVOKED)</b>' : '') + '</span>'
              + '<div style="display:flex;gap:6px;">'
              + (r.revoked ? "" : '<button class="mini-btn" data-sreset="' + escHtml(r.key) + '" type="button">Reset PC</button>')
              + (r.revoked ? "" : '<button class="danger-btn revoke-lic-btn" data-srevoke="' + escHtml(r.key) + '" type="button">Revoke License</button>')
              + '</div>'
              + '</div>';
          });
          uh += '<div style="margin-top:10px;"><button class="mini-btn" data-sgen="' + escHtml(u.email) + '" type="button">+ Generate key</button></div></div>';
        });
        if(ub){
          ub.innerHTML = uh || '<p style="font-size:13px;color:var(--label-2);">No accounts yet.</p>';
          wireServerUserButtons(ub);
        }
      }).catch(function(){});
    }).catch(function(){});
  }

  function wireServerUserButtons(ub){
    // Revoke License
    Array.prototype.forEach.call(ub.querySelectorAll("[data-srevoke]"), function(b){
      b.onclick = function(){
        var key = b.getAttribute("data-srevoke");
        openConfirmModal({
          title: "Revoke License",
          message: "Are you sure you want to revoke license key <code>" + escHtml(key) + "</code>?<br><br><b>Notice:</b> Revoking immediately flags the key as revoked on the server. Subsequent validation checks (/api/verify-license) will hard-lock the panel in After Effects.",
          confirmText: "Revoke License",
          isDanger: true
        }).then(function(confirmed){
          if(!confirmed) return;
          window.PFXServer.api("license-revoke", { key: key }).then(function(r){
            if(!r.ok){ showToast("Revoke failed (" + (r.error || "?") + ")"); return; }
            showToast("License revoked successfully");
            renderAdmin();
          }).catch(function(){ showToast("Server unreachable."); });
        });
      };
    });

    // Deactivate Account
    Array.prototype.forEach.call(ub.querySelectorAll("[data-sdeactivate]"), function(b){
      b.onclick = function(){
        var email = b.getAttribute("data-sdeactivate");
        openConfirmModal({
          title: "Deactivate Account",
          message: "Temporarily deactivate account for <b>" + escHtml(email) + "</b>?<br><br>This disables the user's ability to log in, generate keys, or claim extra slots without deleting their historical records.",
          confirmText: "Deactivate Account",
          isDanger: true
        }).then(function(confirmed){
          if(!confirmed) return;
          window.PFXServer.api("user-deactivate", { email: email, disabled: true }).then(function(r){
            if(!r.ok){ showToast("Deactivate failed (" + (r.error || "?") + ")"); return; }
            showToast("Account deactivated");
            renderAdmin();
          }).catch(function(){ showToast("Server unreachable."); });
        });
      };
    });

    // Reactivate Account
    Array.prototype.forEach.call(ub.querySelectorAll("[data-sactivate]"), function(b){
      b.onclick = function(){
        var email = b.getAttribute("data-sactivate");
        window.PFXServer.api("user-deactivate", { email: email, disabled: false }).then(function(r){
          if(!r.ok){ showToast("Reactivate failed (" + (r.error || "?") + ")"); return; }
          showToast("Account reactivated");
          renderAdmin();
        }).catch(function(){ showToast("Server unreachable."); });
      };
    });

    // Delete Account
    Array.prototype.forEach.call(ub.querySelectorAll("[data-sdelete-user]"), function(b){
      b.onclick = function(){
        var email = b.getAttribute("data-sdelete-user");
        openConfirmModal({
          title: "Delete Account",
          message: "Are you sure you want to permanently delete account <b>" + escHtml(email) + "</b>?<br><br><b>Warning:</b> This completely purges the user profile, associated machine bindings, and license keys from the system.",
          requireText: "DELETE",
          confirmText: "Delete Account",
          isDanger: true
        }).then(function(confirmed){
          if(!confirmed) return;
          window.PFXServer.api("user-delete", { email: email }).then(function(r){
            if(!r.ok){ showToast("Delete failed (" + (r.error || "?") + ")"); return; }
            showToast("Account deleted successfully");
            renderAdmin();
          }).catch(function(){ showToast("Server unreachable."); });
        });
      };
    });

    // Reset Hardware PC
    Array.prototype.forEach.call(ub.querySelectorAll("[data-sreset]"), function(b){
      b.onclick = function(){
        var key = b.getAttribute("data-sreset");
        var nm = prompt("New Machine ID for " + key + " (8 chars, e.g. after a PC switch):", "");
        if(!nm) return;
        nm = nm.trim().toUpperCase();
        if(!/^[A-Za-z0-9]{8}$/.test(nm)){ alert("Machine ID must be exactly 8 letters/numbers."); return; }
        window.PFXServer.api("license-reset", { key: key, machine: nm }).then(function(r){
          if(!r.ok){ showToast("Reset failed (" + (r.error || "?") + ")"); return; }
          showToast("New key minted for " + nm);
          alert("New key for " + nm + ":\n" + r.key);
          renderAdmin();
        }).catch(function(){ showToast("Server unreachable."); });
      };
    });

    // Mint Key
    Array.prototype.forEach.call(ub.querySelectorAll("[data-sgen]"), function(b){
      b.onclick = function(){
        var email = b.getAttribute("data-sgen");
        var nm = prompt("Machine ID to mint a key for (" + email + "):", "");
        if(!nm) return;
        nm = nm.trim().toUpperCase();
        if(!/^[A-Za-z0-9]{8}$/.test(nm)){ alert("Machine ID must be exactly 8 letters/numbers."); return; }
        window.PFXServer.api("license-generate", { email: email, machine: nm }).then(function(r){
          if(!r.ok){ showToast("Generate failed (" + (r.error || "?") + ")"); return; }
          showToast("Minted key successfully");
          alert("Minted key:\n" + r.key);
          renderAdmin();
        }).catch(function(){ showToast("Server unreachable."); });
      };
    });
  }

  window.PFXAdmin = { refresh: function(){ renderAdmin(); } };

  function renderAdmin(){
    paintLockState();
    if(!isAdmin()) return;
    paintServerChrome();
    if(window.PFXPartners && window.PFXPartners.refresh){ try { window.PFXPartners.refresh(); } catch(e){} }
    if(window.PFXServer.live()){ renderAdminServer(); return; }

    // Fallback local mode
    var users = authUsers(), vault = lsGet("pfx-licenses", {}), coupons = window.PFXCoupons.all();
    var nLic = 0, emails = Object.keys(users), nComputers = 0;
    emails.forEach(function(em){
      var ms = vault[em] || {};
      nLic += Object.keys(ms).length;
      nComputers += Object.keys(ms).length;
    });
    var paid = paidEstimate();
    var rev = (paid * parseFloat(basePrice())).toFixed(2);
    var adminStats = document.getElementById("adminStats");
    if(adminStats){
      adminStats.innerHTML =
        statCard(users ? emails.length : 0, "people")
        + statCard(nLic, "keys made")
        + statCard(nComputers, "computers using keys")
        + statCard(Object.keys(coupons).length, "discount codes")
        + statCard("$" + rev, "about earned");
    }

    // local coupons
    var cl = document.getElementById("couponList"), html = "";
    Object.keys(coupons).sort().forEach(function(code){
      var d = coupons[code];
      var tag = d.kind === "free" ? "FREE" : (d.pct + "% OFF");
      var uses = d.builtin ? "built-in" : ((d.uses || 0) + (d.maxUses != null ? "/" + d.maxUses : " uses"));
      var shared = window.PFXCoupons.isShareable(code);
      var shareCode = shared ? code : window.PFXCoupons.shareable(code, d.pct, d.kind);
      var scope = "";
      if(!d.builtin){
        scope = shared
          ? '<span class="tag" style="border-color:#22c55e;color:#22c55e;" title="Verifies itself on any device — no publish step">🌍 all devices</span>'
          : '<span class="tag" style="border-color:#f59e0b;color:#f59e0b;" title="Click Copy or Make shareable to get the code for other devices">⚠ local name</span>';
      }
      html += '<div class="coupon-row"><code>' + escHtml(code) + '</code><span class="tag">' + tag + '</span>' + scope
        + '<span class="note">' + escHtml(d.note || "") + ' · ' + escHtml(uses) + '</span>'
        + (d.builtin ? "" : '<button class="mini-btn copy-cpn-btn" data-copy-coupon="' + escHtml(shareCode || code) + '" type="button" title="Copy code for any device">Copy</button>')
        + (!d.builtin && !shared ? '<button class="mini-btn share-cpn-btn" data-share-coupon="' + escHtml(code) + '" type="button" title="Convert to permanent cross-device code">Make shareable</button>' : '')
        + (d.builtin ? "" : '<button class="danger-btn del-cpn-btn" data-del-coupon="' + escHtml(code) + '" type="button" title="Delete Coupon">🗑 Delete Coupon</button>')
        + '</div>';
    });
    if(cl){
      cl.innerHTML = html || '<p style="font-size:13px;color:var(--label-2);">No coupons.</p>';
      Array.prototype.forEach.call(cl.querySelectorAll("[data-copy-coupon]"), function(b){
        b.onclick = function(){
          var c = b.getAttribute("data-copy-coupon");
          try { if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(c); } catch(e){}
          showToast("Copied " + c);
        };
      });
      Array.prototype.forEach.call(cl.querySelectorAll("[data-share-coupon]"), function(b){
        b.onclick = function(){
          var old = b.getAttribute("data-share-coupon");
          var all = window.PFXCoupons.all(), d = all[old];
          if(!d) return;
          var next = window.PFXCoupons.shareable(old, d.pct, d.kind);
          if(!next){ showToast("That code can't be made shareable."); return; }
          var r = window.PFXCoupons.create(next, { kind: d.kind, pct: d.kind === "free" ? 0 : d.pct, note: d.note || "", maxUses: d.maxUses == null ? null : d.maxUses });
          if(!r.ok){ showToast(r.error || "Could not upgrade that code."); return; }
          window.PFXCoupons.remove(old);
          try { if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(next); } catch(e){}
          showToast("New code " + next + " copied — works on every device");
          renderAdmin();
          paintCoupon();
        };
      });
      Array.prototype.forEach.call(cl.querySelectorAll("[data-del-coupon]"), function(b){
        b.onclick = function(){
          var code = b.getAttribute("data-del-coupon");
          openConfirmModal({
            title: "Delete Coupon",
            message: "Delete coupon <code>" + escHtml(code) + "</code> from local cache?",
            confirmText: "Delete Coupon",
            isDanger: true
          }).then(function(confirmed){
            if(!confirmed) return;
            window.PFXCoupons.remove(code);
            showToast("Coupon deleted successfully");
            renderAdmin();
            paintCoupon();
          });
        };
      });
    }

    // local users
    var ub = document.getElementById("adminUsers"), uh = "";
    if(!emails.length) uh = '<p style="font-size:13px;color:var(--label-2);">No people yet. When buyers sign up on this device, they show up here.</p>';
    emails.sort().forEach(function(em){
      var ms = vault[em] || {}, keys = Object.keys(ms).sort();
      uh += '<div class="user-block"><b>' + escHtml(em) + '</b> <span style="color:var(--label-3);font-size:12px;">· ' + keys.length + ' computer' + (keys.length === 1 ? "" : "s") + '</span>'
        + ' <button class="mini-btn" data-reset-pw="' + escHtml(em) + '" type="button" style="margin-left:8px;">Reset Password</button>'
        + ' <button class="danger-btn del-cpn-btn" data-del-person="' + escHtml(em) + '" type="button" title="Remove this person and all their keys on this device">Remove person</button>';
      keys.forEach(function(mch){
        var isPending = (mch === "PENDING" || mch.indexOf("PENDING") === 0);
        uh += '<div class="dash-row" style="margin:8px 0 0;"><span class="mid" style="' + (isPending ? 'color:var(--accent);font-weight:700;' : '') + '">' + escHtml(mch) + '</span>'
          + '<span class="key">' + escHtml(ms[mch].key || "") + '</span>'
          + '<button class="mini-btn bind-btn" data-rebind-local="' + escHtml(em + "|" + mch) + '" type="button">' + (isPending ? 'Activate PC' : 'Change PC') + '</button>'
          + '<button class="danger-btn revoke-lic-btn" data-revoke="' + escHtml(em + "|" + mch) + '" type="button">Revoke License</button></div>';
      });
      uh += "</div>";
    });
    if(ub){
      ub.innerHTML = uh;
      Array.prototype.forEach.call(ub.querySelectorAll("[data-reset-pw]"), function(b){
        b.onclick = function(){
          var em = b.getAttribute("data-reset-pw");
          var np = prompt("Enter new password for " + em + " (minimum 8 characters):", "");
          if(np === null) return;
          np = np.trim();
          if(np.length < 8){
            alert("Password must be at least 8 characters long.");
            return;
          }
          if(window.PFXAuth && window.PFXAuth.setPassword){
            window.PFXAuth.setPassword(em, np).then(function(res){
              if(res && res.ok){
                showToast("Password updated for " + em);
              } else {
                alert("Error setting password: " + (res && res.error ? res.error : "Unknown error"));
              }
            });
          }
        };
      });
      Array.prototype.forEach.call(ub.querySelectorAll("[data-del-person]"), function(b){
        b.onclick = function(){
          var em = b.getAttribute("data-del-person");
          openConfirmModal({
            title: "Remove person",
            message: "Remove <b>" + escHtml(em) + "</b> and all their keys on this device? They can sign up again later.",
            confirmText: "Remove person",
            isDanger: true
          }).then(function(confirmed){
            if(!confirmed) return;
            var usersNow = authUsers();
            delete usersNow[em];
            lsSet("pfx-users", usersNow);
            var v = lsGet("pfx-licenses", {});
            delete v[em];
            lsSet("pfx-licenses", v);
            showToast("Person removed");
            renderAdmin();
            if(window.PineappleFXLic && window.PineappleFXLic.refreshDashboard) window.PineappleFXLic.refreshDashboard();
          });
        };
      });
      Array.prototype.forEach.call(ub.querySelectorAll("[data-rebind-local]"), function(b){
        b.onclick = function(){
          var parts = b.getAttribute("data-rebind-local").split("|");
          var em = parts[0], oldMch = parts[1];
          var nm = prompt("Enter Machine ID for " + em + " (8 characters from After Effects panel):", "");
          if(!nm) return;
          nm = nm.trim().toUpperCase();
          if(!/^[A-Za-z0-9]{8}$/.test(nm)){
            alert("Machine ID must be exactly 8 letters/numbers.");
            return;
          }
          var newKey = adminMintKey(nm);
          if(!newKey){
            alert("Failed to calculate key for that Machine ID.");
            return;
          }
          if(window.PFXVault && window.PFXVault.rebind){
            window.PFXVault.rebind(em, oldMch, nm, newKey);
            showToast("License bound to " + nm);
            renderAdmin();
            if(window.PineappleFXLic && window.PineappleFXLic.refreshDashboard) window.PineappleFXLic.refreshDashboard();
            alert("New key for " + nm + ":\n" + newKey + "\n\n(Key updated in user vault)");
          }
        };
      });
      Array.prototype.forEach.call(ub.querySelectorAll("[data-revoke]"), function(b){
        b.onclick = function(){
          var parts = b.getAttribute("data-revoke").split("|");
          openConfirmModal({
            title: "Revoke License",
            message: "Revoke key for " + escHtml(parts[0]) + " / " + escHtml(parts[1]) + "?",
            confirmText: "Revoke License",
            isDanger: true
          }).then(function(confirmed){
            if(!confirmed) return;
            var v = lsGet("pfx-licenses", {});
            if(v[parts[0]]) delete v[parts[0]][parts[1]];
            lsSet("pfx-licenses", v);
            showToast("License revoked successfully");
            renderAdmin();
            if(window.PineappleFXLic && window.PineappleFXLic.refreshDashboard) window.PineappleFXLic.refreshDashboard();
          });
        };
      });
    }
    renderAffSuggestions();
    renderAffBeta();
    renderAffApps();
  }

  function statCard(n, label){ return '<div class="stat-card"><b>' + n + '</b><span>' + label + '</span></div>'; }
  function escHtml(s){ return String(s == null ? "" : s).replace(/[&<>"]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }

  var cpRandom = document.getElementById("cpRandom");
  if(cpRandom) cpRandom.onclick = function(){ document.getElementById("cpCode").value = randomCouponCode(); };
  var cpType = document.getElementById("cpType");
  if(cpType){
    cpType.onchange = function(){
      document.getElementById("cpPct").disabled = (document.getElementById("cpType").value === "free");
    };
  }

  var cpCreate = document.getElementById("cpCreate");
  if(cpCreate){
    cpCreate.onclick = function(){
      var err = document.getElementById("cpErr");
      err.textContent = "";
      if(!isAdmin()){ err.textContent = "Admin only."; return; }
      var code = document.getElementById("cpCode").value;
      var program = document.getElementById("cpProgram").value;
      var platform = document.getElementById("cpPlatform").value;
      var channelId = document.getElementById("cpChannelId").value.trim();
      var type = document.getElementById("cpType").value;
      var pct = parseInt(document.getElementById("cpPct").value, 10);
      var maxRaw = document.getElementById("cpMax").value;
      var note = document.getElementById("cpNote").value;
      if(program === "affiliate" && !channelId){ err.textContent = "Affiliate codes need a channel/user ID."; return; }
      var payload = {
        kind: type, pct: pct,
        maxUses: maxRaw === "" ? null : Math.max(1, parseInt(maxRaw, 10) || 1),
        note: note,
        program: program,
        platform: platform,
        channelId: channelId
      };
      // Auto-fill affiliate code if empty
      if(program === "affiliate" && !code){
        var A = "ABCDEFGHJKMNPQRSTVWXYZ23456789", s = "";
        for(var i = 0; i < 8; i++) s += A.charAt(Math.floor(Math.random() * A.length));
        code = "PFX-" + platform.slice(0,3).toUpperCase() + "-" + s.slice(4);
        document.getElementById("cpCode").value = code;
      }
      if(!code){ err.textContent = "Enter a code (or leave blank for affiliate auto-code)."; return; }
      code = code.toUpperCase();
      /* Every code is self-verifying so it works on ANY device with no server
         and no publish step: "SUMMER25" becomes "SUMMER25-XXXXXXXX".
         A free code still needs the server to actually mint a key. */
      var signedCode = window.PFXCoupons.shareable(code, payload.pct, payload.kind);
      if(!signedCode){ err.textContent = "Code needs at least 2 letters/numbers."; return; }
      code = signedCode;
      function createdOk(label){
        document.getElementById("cpCode").value = "";
        document.getElementById("cpChannelId").value = "";
        document.getElementById("cpNote").value = "";
        document.getElementById("cpMax").value = "";
        try { if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(label); } catch(e){}
        showToast("Coupon " + label + " created & copied — works on every device");
        renderAdmin();
        paintCoupon();
      }
      if(window.PFXServer.live()){
        window.PFXServer.api("coupon-create", {
          code: code, kind: payload.kind, pct: payload.pct, maxUses: payload.maxUses, note: payload.note,
          program: payload.program, platform: payload.platform, channelId: payload.channelId
        }).then(function(r){
          if(!r.ok){ err.textContent = r.error === "exists" ? "That code already exists." : "Create failed (" + (r.error || "?") + ")."; return; }
          createdOk(r.code);
        }).catch(function(e){
          err.textContent = String(e && e.message) === "session-expired" ? "Session expired — reconnect." : "Server unreachable.";
        });
        return;
      }
      var r = window.PFXCoupons.create(code, payload);
      if(!r.ok){ err.textContent = r.error; return; }
      createdOk(r.code);
    };
  }

  /* Publish percent-off codes as a static coupons.json the store site can
     validate against without a backend (GitHub Pages). Free codes are
     deliberately excluded — this file is served to every visitor. */
  var cpPublish = document.getElementById("cpPublish");
  if(cpPublish){
    cpPublish.onclick = function(){
      var err = document.getElementById("cpErr");
      err.textContent = "";
      if(!isAdmin()){ err.textContent = "Admin only."; return; }
      var all = window.PFXCoupons.all(), out = {}, n = 0;
      Object.keys(all).forEach(function(k){
        var d = all[k];
        if(d.kind !== "percent") return; // percent-only, always
        out[k] = { kind: "percent", pct: Math.min(99, Math.max(1, +d.pct || 0)) };
        if(d.note) out[k].note = String(d.note).slice(0, 60);
        if(d.maxUses != null) out[k].maxUses = d.maxUses;
        n++;
      });
      var body = {
        _note: "Public discount codes only. Percent-off entries live here so buyers can redeem them on the static site. NEVER put 'free' (key-minting) codes in this file - it is served to everyone. Add codes via the admin panel's 'Publish codes to website' button, then commit."
      };
      Object.keys(out).forEach(function(k){ body[k] = out[k]; });
      var blob = new Blob([JSON.stringify(body, null, 2) + "\n"], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "coupons.json";
      document.body.appendChild(a); a.click();
      setTimeout(function(){ URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 500);
      showToast(n + (n === 1 ? " code published" : " codes published"));
    };
  }

  /* ---- Make a key by hand (backup tool) ----
     Mints a working, panel-valid key from the buyer's Machine ID alone.
     Server when connected (so it lands in the shared DB and audit log),
     local FNV-1a mint when not — same scheme, so both unlock the panel. */
  var mkCreate = document.getElementById("mkCreate");
  if(mkCreate){
    mkCreate.onclick = function(){
      var err = document.getElementById("mkErr");
      var out = document.getElementById("mkResult");
      err.textContent = "";
      if(!isAdmin()){ err.textContent = "Admin only."; return; }
      var email = document.getElementById("mkEmail").value.trim();
      var nm = document.getElementById("mkMachine").value.trim().toUpperCase();
      if(!/^[A-Za-z0-9]{8}$/.test(nm)){ err.textContent = "Machine ID must be exactly 8 letters/numbers."; return; }
      if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ err.textContent = "That email doesn't look right."; return; }
      function showKey(key, where){
        document.getElementById("mkKey").textContent = key;
        document.getElementById("mkKey").setAttribute("data-key", key);
        document.getElementById("mkWhere").textContent = where;
        out.style.display = "";
      }
      if(window.PFXServer.live()){
        mkCreate.disabled = true;
        window.PFXServer.api("license-generate", { email: email || "manual@" + nm.toLowerCase() + ".local", machine: nm })
          .then(function(r){
            mkCreate.disabled = false;
            if(!r.ok){ err.textContent = "Server refused (" + (r.error || "?") + ")."; return; }
            showKey(r.key, "Saved to the server for " + (email || nm) + ".");
            showToast("Key made for " + nm);
            renderAdmin();
          }).catch(function(e){
            mkCreate.disabled = false;
            err.textContent = String(e && e.message) === "session-expired" ? "Session expired — reconnect." : "Server unreachable — minting locally instead.";
            if(String(e && e.message) !== "session-expired"){
              var k = adminMintKey(nm);
              if(k) showKey(k, "Made offline — the server was unreachable, so save this key somewhere yourself.");
            }
          });
        return;
      }
      var k = adminMintKey(nm);
      if(!k){ err.textContent = "Local mint unavailable."; return; }
      showKey(k, "Made offline (no server connected) — save this key somewhere yourself.");
      showToast("Key made for " + nm);
    };
  }
  var mkCopy = document.getElementById("mkCopy");
  if(mkCopy) mkCopy.onclick = function(){
    var k = document.getElementById("mkKey").getAttribute("data-key") || "";
    if(!k) return;
    if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(k).then(function(){ showToast("Key copied"); }, function(){}); return; }
    var ta = document.createElement("textarea"); ta.value = k; document.body.appendChild(ta);
    ta.select(); try { document.execCommand("copy"); } catch(e){}
    document.body.removeChild(ta); showToast("Key copied");
  };
  var mkReveal = document.getElementById("mkReveal");
  if(mkReveal) mkReveal.onclick = function(){
    var n = document.getElementById("mkKey");
    n.style.webkitMaskImage = n.style.webkitMaskImage ? "" : "linear-gradient(#000,#000)";
    n.style.filter = n.style.filter ? "" : "blur(7px)";
  };

  /* ---------- Affiliate Suggestions & Requests ---------- */
  var affSuggestRefresh = document.getElementById("affSuggestRefresh");
  if(affSuggestRefresh){
    affSuggestRefresh.onclick = function(){ renderAffSuggestions(); };
  }
  function renderAffSuggestions(){
    var box = document.getElementById("affSuggestions");
    if(!box) return;
    box.innerHTML = '<p style="font-size:13px;color:var(--label-2);">Loading…</p>';
    var all = lsGet("pfx-aff-suggestions", {});
    var items = Object.values(all).sort(function(a,b){ return (b.at||0) - (a.at||0); });
    var html = "";
    if(!items.length){ html = '<p style="font-size:13px;color:var(--label-2);">No suggestions yet. Affiliates can apply and send feedback from the website.</p>'; }
    else {
      items.forEach(function(s){
        var statusTag = s.status === "done" ? '<span class="tag" style="background:rgba(34,197,94,0.15);color:#22c55e;border:1px solid #22c55e;">done</span>'
          : s.status === "rejected" ? '<span class="tag" style="background:rgba(229,72,77,0.15);color:#ff4d4f;border:1px solid #ff4d4f;">rejected</span>'
          : '<span class="tag" style="background:rgba(254,202,8,0.15);color:#feca08;border:1px solid #feca08;">open</span>';
        var betaTag = s.beta ? ' <span class="tag" style="font-size:10px;background:rgba(254,202,8,0.15);color:#feca08;border:1px solid #feca08;">beta</span>' : '';
        html += '<div class="coupon-row"><div style="flex:1;min-width:200px;">'
          + '<b>' + escHtml(s.name) + '</b> ' + statusTag + betaTag + '<br>'
          + '<span style="color:var(--label-3);font-size:11px;">' + escHtml(s.email || "no email") + ' · ' + new Date(s.at||0).toLocaleString() + '</span><br>'
          + '<span style="color:var(--label-2);font-size:12px;">' + escHtml(s.type) + ': ' + escHtml(s.message || "") + '</span>'
          + '</div>'
          + '<div style="display:flex;gap:6px;">'
          + (s.status !== "done" ? '<button class="mini-btn" data-aff-done="' + escHtml(s.id) + '" type="button">Mark Done</button>' : '')
          + (s.status !== "rejected" ? '<button class="danger-btn del-cpn-btn" data-aff-rej="' + escHtml(s.id) + '" type="button">Reject</button>' : '')
          + '<button class="mini-btn" data-aff-beta="' + escHtml(s.id) + '" type="button">' + (s.beta ? 'Revoke Beta' : 'Grant Beta') + '</button>'
          + '</div></div>';
      });
    }
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll("[data-aff-done]"), function(b){
      b.onclick = function(){ setAffStatus(b.getAttribute("data-aff-done"), "done"); };
    });
    Array.prototype.forEach.call(box.querySelectorAll("[data-aff-rej]"), function(b){
      b.onclick = function(){ setAffStatus(b.getAttribute("data-aff-rej"), "rejected"); };
    });
    Array.prototype.forEach.call(box.querySelectorAll("[data-aff-beta]"), function(b){
      b.onclick = function(){ toggleAffBeta(b.getAttribute("data-aff-beta"), !JSON.parse(b.getAttribute("data-aff-beta") === "true" || b.getAttribute("data-aff-beta"))); };
    });
  }
  function setAffStatus(id, status){
    var all = lsGet("pfx-aff-suggestions", {});
    if(all[id]){ all[id].status = status; all[id].at = Date.now(); lsSet("pfx-aff-suggestions", all); showToast("Updated"); renderAffSuggestions(); renderAffBeta(); }
  }
  function toggleAffBeta(id, grant){
    var all = lsGet("pfx-aff-suggestions", {});
    if(all[id]){ all[id].beta = grant; all[id].at = Date.now(); lsSet("pfx-aff-suggestions", all); showToast(grant ? "Beta granted" : "Beta revoked"); renderAffSuggestions(); renderAffBeta(); }
  }

  /* ---------- Beta Access List ---------- */
  var affBetaRefresh = document.getElementById("affBetaRefresh");
  if(affBetaRefresh){ affBetaRefresh.onclick = function(){ renderAffBeta(); }; }
  function renderAffBeta(){
    var box = document.getElementById("affBetaList");
    if(!box) return;
    var all = lsGet("pfx-aff-suggestions", {});
    var betas = Object.values(all).filter(function(s){ return s.beta === true; });
    var html = "";
    if(!betas.length){ html = '<p style="font-size:13px;color:var(--label-2);">No affiliates have beta access yet.</p>'; }
    else {
      betas.forEach(function(s){
        html += '<div class="coupon-row"><b>' + escHtml(s.name) + '</b> <span style="color:var(--label-3);font-size:11px;">' + escHtml(s.email || "") + '</span>'
          + '<button class="mini-btn" data-aff-revoke-beta="' + escHtml(s.id) + '" type="button">Revoke Beta</button></div>';
      });
    }
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll("[data-aff-revoke-beta]"), function(b){
      b.onclick = function(){ toggleAffBeta(b.getAttribute("data-aff-revoke-beta"), false); };
    });
  }

  /* ---------- Affiliate Applications Review ---------- */
  var affAppsRefresh = document.getElementById("affAppsRefresh");
  if(affAppsRefresh){ affAppsRefresh.onclick = function(){ renderAffApps(); }; }
  function renderAffApps(){
    var box = document.getElementById("affApps");
    if(!box) return;
    box.innerHTML = '<p style="font-size:13px;color:var(--label-2);">Loading…</p>';
    var all = JSON.parse(localStorage.getItem("pfx-aff-applications") || "{}");
    var items = Object.values(all).sort(function(a,b){ return (b.created||0) - (a.created||0); });
    var html = "";
    if(!items.length){ html = '<p style="font-size:13px;color:var(--label-2);">No affiliate applications yet.</p>'; }
    else {
      items.forEach(function(app){
        var statusTag = app.status === "approved" ? '<span class="tag" style="background:rgba(34,197,94,0.15);color:#22c55e;border:1px solid #22c55e;">approved</span>'
          : app.status === "rejected" ? '<span class="tag" style="background:rgba(229,72,77,0.15);color:#ff4d4f;border:1px solid #ff4d4f;">rejected</span>'
          : '<span class="tag" style="background:rgba(254,202,8,0.15);color:#feca08;border:1px solid #feca08;">pending</span>';
        html += '<div class="coupon-row"><div style="flex:1;min-width:220px;">'
          + '<b>' + escHtml(app.name) + '</b> ' + statusTag + '<br>'
          + '<span style="color:var(--label-3);font-size:11px;">' + escHtml(app.email) + ' · ' + escHtml(app.platform) + ' · ' + escHtml(app.channelId) + '</span><br>'
          + '<span style="color:var(--label-2);font-size:12px;">' + app.subs + ' subs · ' + new Date(app.created||0).toLocaleString() + '</span><br>'
          + '<span style="color:var(--label-2);font-size:11px;">' + escHtml(app.insights || "") + '</span>'
          + '</div>'
          + '<div style="display:flex;gap:6px;">'
          + (app.status === "pending" ? '<button class="mini-btn" data-aff-approve="' + escHtml(app.id) + '" type="button">Approve</button>' : '')
          + (app.status === "pending" ? '<button class="danger-btn del-cpn-btn" data-aff-reject-app="' + escHtml(app.id) + '" type="button">Reject</button>' : '')
          + (app.status === "approved" && app.couponCode ? '<button class="mini-btn" data-aff-resend="' + escHtml(app.id) + '" type="button">Resend Code</button>' : '')
          + '</div></div>';
        if(app.status === "approved" && app.couponCode){
          html += '<div style="margin:8px 0 0;padding:10px;background:var(--grouped);border-radius:10px;font-size:12px;color:var(--label-2);">'
            + '<b>Coupon sent:</b> <code style="color:#feca08;">' + escHtml(app.couponCode) + '</code> → ' + escHtml(app.email)
            + '</div>';
        }
      });
    }
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll("[data-aff-approve]"), function(b){
      b.onclick = function(){ approveAffApp(b.getAttribute("data-aff-approve")); };
    });
    Array.prototype.forEach.call(box.querySelectorAll("[data-aff-reject-app]"), function(b){
      b.onclick = function(){ rejectAffApp(b.getAttribute("data-aff-reject-app")); };
    });
    Array.prototype.forEach.call(box.querySelectorAll("[data-aff-resend]"), function(b){
      b.onclick = function(){ resendAffCode(b.getAttribute("data-aff-resend")); };
    });
  }
  function approveAffApp(id){
    var all = JSON.parse(localStorage.getItem("pfx-aff-applications") || "{}");
    var app = all[id];
    if(!app) return;
    if(app.status !== "pending"){ showToast("Already processed."); return; }
    // Generate a free affiliate coupon code: AFX-{username}-{random}
    var A = "ABCDEFGHJKMNPQRSTVWXYZ23456789", s = "";
    for(var i = 0; i < 8; i++) s += A.charAt(Math.floor(Math.random() * A.length));
    var uname = String(app.name || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "PARTNER";
    var code = "AFX-" + uname + "-" + s.slice(4);
    // Sign it so the partner can use the code on their own device (and so the
    // code validates for buyers on other devices) — minting still needs the server.
    if(window.PFXCoupons && window.PFXCoupons.shareable){
      var signedAff = window.PFXCoupons.shareable(code, 0, "free");
      if(signedAff) code = signedAff;
    }
    var coupons = window.PFXCoupons ? window.PFXCoupons.all() : {};
    if(coupons[code]){ showToast("Code collision, retry."); return; }
    var def = { kind: "free", pct: 0, note: "Affiliate: " + escHtml(app.name) + " (" + escHtml(app.platform) + ")", maxUses: null, uses: 0, created: Date.now(), program: "affiliate", platform: app.platform, channelId: app.channelId };
    var r = window.PFXCoupons.create(code, def);
    if(!r.ok){ showToast("Coupon create failed: " + r.error); return; }
    app.status = "approved";
    app.couponCode = code;
    app.approvedAt = Date.now();
    all[id] = app;
    localStorage.setItem("pfx-aff-applications", JSON.stringify(all));
    showToast("Approved! Coupon " + code + " ready for " + app.email);
    renderAffApps();
    renderAffSuggestions();
    renderAffBeta();
    paintCoupon();
  }
  function rejectAffApp(id){
    var all = JSON.parse(localStorage.getItem("pfx-aff-applications") || "{}");
    var app = all[id];
    if(!app) return;
    app.status = "rejected";
    app.rejectedAt = Date.now();
    all[id] = app;
    localStorage.setItem("pfx-aff-applications", JSON.stringify(all));
    showToast("Application rejected.");
    renderAffApps();
  }
  function resendAffCode(id){
    var all = JSON.parse(localStorage.getItem("pfx-aff-applications") || "{}");
    var app = all[id];
    if(!app || !app.couponCode){ showToast("No code to resend."); return; }
    showToast("Coupon " + app.couponCode + " would be re-sent to " + app.email + " (configure your SMTP to actually send email).");
  }

  /* ---------- Installer Update ---------- */
  var instUpdate = document.getElementById("instUpdate");
  if(instUpdate){
    instUpdate.onclick = function(){
      var err = document.getElementById("instErr");
      var out = document.getElementById("instResult");
      err.textContent = ""; out.style.display = "none";
      var file = document.getElementById("instFile").files && document.getElementById("instFile").files[0];
      var ver = (document.getElementById("instVersion").value || "").trim();
      if(!file){ err.textContent = "Pick a .zxp file first."; return; }
      if(!/\.zxp$/i.test(file.name)){ err.textContent = "File must be a .zxp."; return; }
      if(!ver){ err.textContent = "Enter a version (e.g. 2.1.0)."; return; }
      var reader = new FileReader();
      reader.onload = function(){
        var ab = reader.result;
        // Validate it looks like a zip/zxp (starts with PK)
        var bytes = new Uint8Array(ab.slice(0,4));
        if(bytes[0]!==0x50||bytes[1]!==0x4b){ err.textContent = "That doesn't look like a valid .zxp (zip)."; return; }
        // Save as base64 data URL so the site can serve/re-download it offline
        var b64 = btoa(String.fromCharCode.apply(null, new Uint8Array(ab)));
        var dataUrl = "data:application/zip;base64," + b64;
        try {
          localStorage.setItem("pfx-installer-zxp", dataUrl);
          localStorage.setItem("pfx-installer-version", ver);
          localStorage.setItem("pfx-installer-updated", String(Date.now()));
        } catch(e){ err.textContent = "Could not save locally."; return; }
        out.style.display = "";
        out.innerHTML = '<p style="color:#22c55e;">Installer updated to <b>' + escHtml(ver) + '</b> (' + Math.round(ab.byteLength/1024) + ' KB).</p>'
          + '<button class="mini-btn" id="instDownload" type="button">Download updated .zxp</button>';
        document.getElementById("instDownload").onclick = function(){
          var a = document.createElement("a"); a.href = dataUrl; a.download = "PineappleFX-" + ver + ".zxp";
          document.body.appendChild(a); a.click(); setTimeout(function(){ document.body.removeChild(a); }, 200);
        };
        showToast("Installer updated to " + ver);
      };
      reader.readAsArrayBuffer(file);
    };
  }

  /* ---------- Security Settings ---------- */
  var secSave = document.getElementById("secSave");
  if(secSave){
    secSave.onclick = function(){
      var err = document.getElementById("secErr");
      err.textContent = "";
      var rl = document.getElementById("secRateLimit").value;
      var sess = document.getElementById("secSession").value;
      var csp = document.getElementById("secCSP").checked;
      if(!rl || rl < 1){ err.textContent = "Enter a valid rate limit."; return; }
      if(!sess || sess < 5){ err.textContent = "Enter a valid session timeout."; return; }
      try {
        localStorage.setItem("pfx-sec-ratelimit", rl);
        localStorage.setItem("pfx-sec-session", sess);
        localStorage.setItem("pfx-sec-csp", String(csp));
      } catch(e){ err.textContent = "Could not save."; return; }
      showToast("Security settings saved");
    };
  }

  var adminExport = document.getElementById("adminExport");
  if(adminExport){    adminExport.onclick = function(){
      var data = { exportedAt: new Date().toISOString(), users: authUsers(), licenses: lsGet("pfx-licenses", {}), coupons: window.PFXCoupons.all() };
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "pineapplefx-backup.json";
      document.body.appendChild(a); a.click();
      setTimeout(function(){ URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 500);
    };
  }

  // Initial render check
  paintLockState();
  if(window.PFXServer.live()) paintServerChrome();
})();
