/* Pineapple Store — Partner Program (easy affiliate tracking).
   Add a person you sponsor, link them to one discount code,
   then see how many buyers used that code. Simple words, no hard terms.
   Works live with the server, or on this device when offline. */
(function () {
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function lsGet(k, fb) {
    try { var v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); }
    catch (e) { return fb; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function uid() {
    return "pt-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e9).toString(36);
  }
  function live() {
    try { return !!(window.PFXServer && window.PFXServer.live()); } catch (e) { return false; }
  }
  function couponUses(code) {
    code = String(code || "").toUpperCase();
    try {
      var all = window.PFXCoupons ? window.PFXCoupons.all() : {};
      for (var k in all) {
        if (String(k).toUpperCase() === code) return (all[k] && all[k].uses) || 0;
      }
    } catch (e) {}
    return 0;
  }

  function renderLocal() {
    var box = document.getElementById("partnerList");
    var stats = document.getElementById("partnerStats");
    var parts = Object.values(lsGet("pfx-partners", {}));
    parts.sort(function (a, b) { return (b.uses || couponUses(b.code)) - (a.uses || couponUses(a.code)); });
    var total = 0;
    parts.forEach(function (p) { total += couponUses(p.code); });
    if (stats) {
      var best = parts.length ? parts.slice().sort(function (a, b) { return couponUses(b.code) - couponUses(a.code); })[0] : null;
      stats.innerHTML = "<b>" + parts.length + "</b> partners · <b>" + total + "</b> code uses total"
        + (best ? " · Top: <b>" + esc(best.name) + "</b> (" + couponUses(best.code) + " uses)" : "");
    }
    if (!box) return;
    if (!parts.length) {
      box.innerHTML = '<p style="font-size:13px;color:var(--label-2);">No partners yet. Add your first person below — it takes 10 seconds.</p>';
      return;
    }
    box.innerHTML = parts.map(function (p) {
      var uses = couponUses(p.code);
      return '<div class="coupon-row"><code>' + esc(p.code) + '</code>'
        + '<span class="tag">' + uses + ' uses</span>'
        + '<span class="note">' + esc(p.name) + (p.email ? " · " + esc(p.email) : "") + '</span>'
        + '<button class="danger-btn del-cpn-btn" data-del-partner="' + esc(p.id) + '" type="button">Remove</button></div>';
    }).join("");
    Array.prototype.forEach.call(box.querySelectorAll("[data-del-partner]"), function (b) {
      b.onclick = function () {
        var id = b.getAttribute("data-del-partner");
        var all = lsGet("pfx-partners", {});
        delete all[id];
        lsSet("pfx-partners", all);
        renderLocal();
        if (window.PFXToast) window.PFXToast("Partner removed");
      };
    });
  }

  function renderServer() {
    var box = document.getElementById("partnerList");
    var stats = document.getElementById("partnerStats");
    if (box) box.innerHTML = '<p style="font-size:13px;color:var(--label-2);">Loading partners…</p>';
    window.PFXServer.api("partners", {}).then(function (d) {
      if (!d.ok) throw new Error(d.error || "?");
      var rows = d.partners || [];
      if (stats) {
        var best = rows[0] || null;
        stats.innerHTML = "<b>" + rows.length + "</b> partners · <b>" + (d.totalUses || 0) + "</b> code uses total"
          + (best ? " · Top: <b>" + esc(best.name) + "</b> (" + (best.uses || 0) + " uses of " + esc(best.code) + ")" : "");
      }
      if (!box) return;
      if (!rows.length) {
        box.innerHTML = '<p style="font-size:13px;color:var(--label-2);">No partners yet. Add your first person below — it takes 10 seconds.</p>';
        return;
      }
      box.innerHTML = rows.map(function (p) {
        return '<div class="coupon-row"><code>' + esc(p.code) + '</code>'
          + '<span class="tag">' + (p.uses || 0) + ' uses</span>'
          + '<span class="note">' + esc(p.name) + (p.email ? " · " + esc(p.email) : "")
          + ' · sales found: ' + (p.sales || 0) + '</span>'
          + '<button class="danger-btn del-cpn-btn" data-sdel-partner="' + esc(p.id) + '" type="button">Remove</button></div>';
      }).join("");
      Array.prototype.forEach.call(box.querySelectorAll("[data-sdel-partner]"), function (b) {
        b.onclick = function () {
          var id = b.getAttribute("data-sdel-partner");
          if (!confirm("Remove this partner? Their code keeps working, but you stop tracking it here.")) return;
          window.PFXServer.api("partner-delete", { id: id }).then(function (r) {
            if (!r.ok) { if (window.PFXToast) window.PFXToast("Remove failed"); return; }
            if (window.PFXToast) window.PFXToast("Partner removed");
            refresh();
          }).catch(function () { if (window.PFXToast) window.PFXToast("Server not reachable."); });
        };
      });
    }).catch(function () {
      if (box) box.innerHTML = '<p style="font-size:13px;color:#ff8f88;">Server not reachable — showing this-device data.</p>';
      renderLocal();
    });
  }

  function refresh() {
    if (live()) renderServer();
    else renderLocal();
  }

  function bind() {
    var add = document.getElementById("ptAdd");
    if (!add || add.__wired) return;
    add.__wired = true;
    var dice = document.getElementById("ptRandom");
    if (dice) dice.onclick = function () {
      var A = "ABCDEFGHJKMNPQRSTVWXYZ23456789", s = "";
      for (var i = 0; i < 8; i++) s += A.charAt(Math.floor(Math.random() * A.length));
      document.getElementById("ptCode").value = "PFX-" + s.slice(0, 4) + "-" + s.slice(4);
    };
    add.onclick = function () {
      var err = document.getElementById("ptErr");
      if (err) err.textContent = "";
      var name = (document.getElementById("ptName").value || "").trim();
      var email = (document.getElementById("ptEmail").value || "").trim();
      var code = (document.getElementById("ptCode").value || "").trim().toUpperCase();
      if (!name) { if (err) err.textContent = "Type the person's name first."; return; }
      if (!/^[A-Z0-9-]{4,24}$/.test(code)) { if (err) err.textContent = "Code: 4–24 letters, numbers, dashes."; return; }
      if (live()) {
        add.disabled = true;
        window.PFXServer.api("partner-add", { name: name, email: email, code: code }).then(function (r) {
          add.disabled = false;
          if (!r.ok) {
            if (err) err.textContent = r.error === "code-taken" ? "That code is already linked to someone." : "Could not save (" + (r.error || "?") + ").";
            return;
          }
          document.getElementById("ptName").value = "";
          document.getElementById("ptEmail").value = "";
          document.getElementById("ptCode").value = "";
          if (window.PFXToast) window.PFXToast("Partner added: " + name);
          refresh();
        }).catch(function () {
          add.disabled = false;
          if (err) err.textContent = "Server not reachable. Try again.";
        });
        return;
      }
      var all = lsGet("pfx-partners", {});
      for (var k in all) {
        if (String(all[k].code || "").toUpperCase() === code) {
          if (err) err.textContent = "That code is already linked to someone.";
          return;
        }
      }
      var id = uid();
      all[id] = { id: id, name: name, email: email, code: code, created: Date.now() };
      lsSet("pfx-partners", all);
      document.getElementById("ptName").value = "";
      document.getElementById("ptEmail").value = "";
      document.getElementById("ptCode").value = "";
      if (window.PFXToast) window.PFXToast("Partner added: " + name);
      renderLocal();
    };
  }

  window.PFXPartners = { refresh: refresh, bind: bind };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { bind(); refresh(); });
  else { bind(); refresh(); }
})();
