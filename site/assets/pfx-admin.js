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
        ? "Connected — tables below are live database data. Revokes, deletes, and pricing take effect immediately."
        : "Local mode: this browser's data only. Connect to the backend for live multi-device data, revocation, and pricing control.";
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
    if(window.PFXServer.live()){ renderAdminServer(); return; }

    // Fallback local mode
    var users = authUsers(), vault = lsGet("pfx-licenses", {}), coupons = window.PFXCoupons.all();
    var nLic = 0, emails = Object.keys(users);
    emails.forEach(function(em){ nLic += Object.keys(vault[em] || {}).length; });
    var paid = paidEstimate();
    var rev = (paid * parseFloat(basePrice())).toFixed(2);
    var adminStats = document.getElementById("adminStats");
    if(adminStats){
      adminStats.innerHTML =
        statCard(users ? emails.length : 0, "accounts")
        + statCard(nLic, "licenses issued")
        + statCard(Object.keys(coupons).length, "coupons")
        + statCard("$" + rev, "est. revenue");
    }

    // local coupons
    var cl = document.getElementById("couponList"), html = "";
    Object.keys(coupons).sort().forEach(function(code){
      var d = coupons[code];
      var tag = d.kind === "free" ? "FREE" : (d.pct + "% OFF");
      var uses = d.builtin ? "built-in" : ((d.uses || 0) + (d.maxUses != null ? "/" + d.maxUses : " uses"));
      html += '<div class="coupon-row"><code>' + escHtml(code) + '</code><span class="tag">' + tag + '</span>'
        + '<span class="note">' + escHtml(d.note || "") + ' · ' + escHtml(uses) + '</span>'
        + (d.builtin ? "" : '<button class="danger-btn del-cpn-btn" data-del-coupon="' + escHtml(code) + '" type="button" title="Delete Coupon">🗑 Delete Coupon</button>')
        + '</div>';
    });
    if(cl){
      cl.innerHTML = html || '<p style="font-size:13px;color:var(--label-2);">No coupons.</p>';
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
    if(!emails.length) uh = '<p style="font-size:13px;color:var(--label-2);">No accounts yet.</p>';
    emails.sort().forEach(function(em){
      var ms = vault[em] || {}, keys = Object.keys(ms).sort();
      uh += '<div class="user-block"><b>' + escHtml(em) + '</b> <span style="color:var(--label-3);font-size:12px;">· ' + keys.length + ' machine' + (keys.length === 1 ? "" : "s") + '</span>';
      keys.forEach(function(mch){
        uh += '<div class="dash-row" style="margin:8px 0 0;"><span class="mid">' + escHtml(mch) + '</span>'
          + '<span class="key">' + escHtml(ms[mch].key || "") + '</span>'
          + '<button class="danger-btn revoke-lic-btn" data-revoke="' + escHtml(em + "|" + mch) + '" type="button">Revoke License</button></div>';
      });
      uh += "</div>";
    });
    if(ub){
      ub.innerHTML = uh;
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
      var type = document.getElementById("cpType").value;
      var pct = parseInt(document.getElementById("cpPct").value, 10);
      var maxRaw = document.getElementById("cpMax").value;
      var payload = {
        kind: type, pct: pct,
        maxUses: maxRaw === "" ? null : Math.max(1, parseInt(maxRaw, 10) || 1),
        note: document.getElementById("cpNote").value
      };
      function createdOk(label){
        document.getElementById("cpCode").value = "";
        document.getElementById("cpNote").value = "";
        document.getElementById("cpMax").value = "";
        showToast("Coupon " + label + " created");
        renderAdmin();
        paintCoupon();
      }
      if(window.PFXServer.live()){
        window.PFXServer.api("coupon-create", {
          code: code, kind: payload.kind, pct: payload.pct, maxUses: payload.maxUses, note: payload.note
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

  var adminExport = document.getElementById("adminExport");
  if(adminExport){
    adminExport.onclick = function(){
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
