/* PineappleFX live panel preview (index page) — self-contained, no page deps. */
  /* ---- live panel preview: all 9 tabs, each with its own working view ---- */
  (function(){
    var pills = document.getElementById("mPills"); if(!pills) return;
    var main = document.querySelector(".mock-main"); if(!main) return;
    var EASING_HTML = main.innerHTML;
    var NS = "http://www.w3.org/2000/svg";
    var GX = 20, GY = 130, GW = 320, GH = 110;
    var cur = { tab:"Easing", idx:0 };

    /* shared bits */
    function toast(msg){
      var t = document.getElementById("mToast");
      if(!t){
        t = document.createElement("div"); t.id = "mToast";
        t.style.cssText = "position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#1e1e22;color:#f5f5f4;border:1px solid #feca08;border-radius:999px;padding:10px 22px;font-size:13px;font-weight:600;z-index:99;box-shadow:0 12px 30px rgba(0,0,0,.5);white-space:nowrap;";
        document.body.appendChild(t);
      }
      t.textContent = msg; t.style.display = "block";
      clearTimeout(t.__h); t.__h = setTimeout(function(){ t.style.display = "none"; }, 2600);
    }
    function slider(id, vid, min, max, fmt, get, set){
      var s = document.getElementById(id); if(!s) return function(){};
      function paint(){
        var v = get(), t = (v-min)/(max-min);
        s.style.setProperty("--f", (t*100).toFixed(1) + "%");
        var vv = document.getElementById(vid); if(vv) vv.textContent = fmt(v);
      }
      function fromEvent(e){
        var r = s.getBoundingClientRect();
        set(min + Math.max(0, Math.min(1, (e.clientX-r.left)/r.width))*(max-min));
        paint();
      }
      s.style.cursor = "pointer"; s.style.touchAction = "none";
      s.addEventListener("pointerdown", function(e){
        try { s.setPointerCapture(e.pointerId); } catch(_){}
        fromEvent(e);
        function mv(ev){ fromEvent(ev); }
        function up(){ s.removeEventListener("pointermove", mv); s.removeEventListener("pointerup", up); }
        s.addEventListener("pointermove", mv); s.addEventListener("pointerup", up);
      });
      paint(); return paint;
    }
    function segWire(id, cb){
      var seg = document.getElementById(id); if(!seg) return;
      var kids = seg.querySelectorAll("i");
      Array.prototype.forEach.call(kids, function(k){
        k.style.cursor = "pointer";
        k.onclick = function(){
          Array.prototype.forEach.call(kids, function(x){ x.classList.remove("on"); });
          k.classList.add("on"); cb(k.textContent);
        };
      });
    }
    function copyText(txt, doneMsg){
      function done(){ toast(doneMsg || "Copied."); }
      try {
        if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(txt).then(done, done); return; }
        var ta = document.createElement("textarea"); ta.value = txt; document.body.appendChild(ta);
        ta.select(); try { document.execCommand("copy"); } catch(e){}
        document.body.removeChild(ta); done();
      } catch(e){ done(); }
    }

    /* one-shot CSS for the demo stages */
    (function(){
      if(document.getElementById("mDemoCss")) return;
      var st = document.createElement("style"); st.id = "mDemoCss";
      st.textContent = ".mstage{background:#202024;border:1px solid #3a3a3f;border-radius:12px;min-height:150px;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;}"
        + ".mstage .tx{font-size:34px;font-weight:800;letter-spacing:-1px;color:#f2f2f0;}"
        + "@keyframes mSlideUp{from{opacity:0;transform:translateY(var(--dist,60px));}to{opacity:1;transform:none;}}"
        + "@keyframes mFade{from{opacity:0;}to{opacity:1;}}"
        + "@keyframes mBounce{0%{opacity:0;transform:translateY(var(--dist,60px));}60%{opacity:1;transform:translateY(calc(var(--dist,60px) * -.25));}80%{transform:translateY(calc(var(--dist,60px) * .1));}100%{opacity:1;transform:none;}}"
        + "@keyframes mType{from{width:0;}to{width:9ch;}}"
        + ".mglassbg{background:linear-gradient(135deg,#ff9f0a,#ff375f 40%,#5e5ce6 75%,#0a84ff);}"
        + ".mart{background:conic-gradient(from 40deg,#ff9f0a,#ff375f,#bf5af2,#0a84ff,#30d158,#ff9f0a);}"
        + ".mphone{background:#000;border:1px solid #3a3a3f;border-radius:28px;padding:10px;box-shadow:0 18px 40px rgba(0,0,0,.5);}"
        + ".mscreen{border-radius:20px;overflow:hidden;position:relative;background:linear-gradient(180deg,#2c2c30,#101014);}"
        + ".misland{background:#000;border-radius:999px;position:absolute;top:8px;left:50%;transform:translateX(-50%);}"
        + ".mtoolbtn{cursor:pointer;background:#202024;border:1px solid #3a3a3f;color:#f2f2f0;border-radius:10px;padding:10px;font-size:12px;font-weight:600;text-align:center;}"
        + ".mtoolbtn:hover{border-color:#feca08;}"
        + ".mpre{background:#141416;border:1px solid #3a3a3f;border-radius:10px;padding:12px;font-family:monospace;font-size:11px;line-height:1.6;color:#e8e8e6;white-space:pre;overflow:auto;max-height:220px;margin:0;}";
      document.head.appendChild(st);
    })();

    /* preset data */
    var TABS = {
      Easing: ["Apple Standard","Emphasized","Decelerated","Spring - Soft","Spring - Bouncy","Snap","Anticipate","Bouncy"],
      Text: ["Slide Up","Typewriter","Word Bounce","Fade Words"],
      Transitions: ["Fade Chars","Rise Chars","Drop Chars","Spin Chars"],
      Glass: ["Liquid Glass","Frost","Tint","Glow"],
      Styles: ["Grade Warm","Noir","Vintage","Clean"],
      Expressions: ["Wiggle","Bounce Out","Loop Out","Orbit"],
      Numbers: ["Counter","Timer","Percentage","Score"],
      Devices: ["iPhone 15 Pro","iPhone 15 Pro Max","iPad Pro 11"],
      Tools: ["Sequence Layers","Center Anchor","Add Text Box","Shuffle Colors","Remove FX"]
    };
    var ECURVES = {
      "Apple Standard":[.4,0,.2,1], "Emphasized":[.2,0,0,1], "Decelerated":[0,0,.2,1],
      "Snap":[.3,1.3,.4,1], "Anticipate":[.6,-.4,.4,1]
    };
    var ESPRINGS = { "Spring - Soft":{f:1.2,dmp:6}, "Spring - Bouncy":{f:1.8,dmp:4}, "Bouncy":{f:2.2,dmp:3} };
    var EPARAMS = { "Apple Standard":[1.5,21], "Emphasized":[1.2,18], "Decelerated":[1.0,14], "Spring - Soft":[1.6,24], "Spring - Bouncy":[1.4,20], "Snap":[.8,12], "Anticipate":[1.1,16], "Bouncy":[1.3,22] };
    var TEX = {
      "Slide Up":{a:"mSlideUp"}, "Typewriter":{a:"mType", mono:1},
      "Word Bounce":{a:"mBounce"}, "Fade Words":{a:"mFade"}
    };
    var GLASS = {
      "Liquid Glass":{b:18,s:150,t:"#88c0ff"}, "Frost":{b:32,s:120,t:"#ffffff"},
      "Tint":{b:8,s:170,t:"#ffb020"}, "Glow":{b:4,s:140,t:"#ff5f9e"}
    };
    var STYLES = {
      "Grade Warm":function(x){ return "sepia("+(.7*x)+") saturate("+(1+x)+") contrast("+(1+.3*x)+")"; },
      "Noir":function(x){ return "grayscale(1) contrast("+(1+.5*x)+") brightness("+(1-.1*x)+")"; },
      "Vintage":function(x){ return "sepia("+(.9*x)+") hue-rotate(" + (-18*x) + "deg) contrast("+(1+.1*x)+")"; },
      "Clean":function(x){ return "saturate("+(1+.4*x)+") contrast("+(1+.08*x)+")"; }
    };
    var EXPR = {
      "Wiggle":{t:"Position", code:function(p){ return "// PineappleFX - Wiggle\nfreq = "+p.f+";\namp = "+p.a+";\nwiggle(freq, amp);"; }},
      "Bounce Out":{t:"Position", code:function(p){ return "// PineappleFX - Bounce Out\namp = 0.5;\nfreq = "+p.f+";\ndecay = 5;\nn = 0;\nif (numKeys > 0) {\n    n = nearestKey(time).index;\n    if (key(n).time > time) n--;\n}\nif (n >= 2) {\n    t = time - key(n).time;\n    delta = key(n).value - key(n - 1).value;\n    value + delta * amp * Math.sin(freq * t * 2 * Math.PI) / Math.exp(decay * t);\n} else {\n    value;\n}"; }},
      "Loop Out":{t:"Any transform", code:function(p){ return "// PineappleFX - Loop Out\nloopOut(\"cycle\");"; }},
      "Orbit":{t:"Position", code:function(p){ return "// PineappleFX - Orbit\nr = "+p.a+";\nspeed = "+p.f+";\na = time * 2 * Math.PI * speed;\n[value[0] + Math.cos(a) * r, value[1] + Math.sin(a) * r];"; }}
    };
    var DEVICES = {
      "iPhone 15 Pro":{w:120, h:248, spec:"393 x 852 pt", island:1},
      "iPhone 15 Pro Max":{w:132, h:272, spec:"430 x 932 pt", island:1},
      "iPad Pro 11":{w:190, h:252, spec:"834 x 1194 pt", island:0}
    };

    /* ---------- EASING (original curve editor, rewired per render) ---------- */
    var est = { curve:[.4,0,.2,1], spring:null, dur:1.5, blur:21, color:"#FECA08" };
    function X(x){ return GX + x*GW; }
    function Y(y){ return GY - y*GH; }
    function sEl(n, attrs){ var e = document.createElementNS(NS, n); for(var k in attrs) e.setAttribute(k, attrs[k]); return e; }
    function springPath(f, dmp){
      var pts = [];
      for(var g = 0; g <= 60; g++){
        var v = g/60*1.35, b = 1 - Math.exp(-dmp*v)*Math.cos(f*2*Math.PI*v);
        pts.push((GX+v/1.35*GW).toFixed(1) + "," + (GY-b*GH*0.85).toFixed(1));
      }
      return "M" + pts.join(" L");
    }
    function drawCurve(){
      var box = document.getElementById("mCurve"); if(!box) return;
      box.innerHTML = "";
      var svg = sEl("svg", {viewBox:"0 0 360 150", width:"100%", height:"120", preserveAspectRatio:"xMidYMid meet"});
      var grid = sEl("g", {stroke:"#3a3a3f", "stroke-width":1});
      grid.appendChild(sEl("line", {x1:20, y1:20, x2:20, y2:130}));
      grid.appendChild(sEl("line", {x1:20, y1:130, x2:340, y2:130}));
      svg.appendChild(grid);
      if(est.spring){
        svg.appendChild(sEl("path", {d:springPath(est.spring.f, est.spring.dmp), fill:"none", stroke:"#feca08", "stroke-width":3, "stroke-linecap":"round"}));
      } else {
        var c = est.curve, h1x = X(c[0]), h1y = Y(c[1]), h2x = X(c[2]), h2y = Y(c[3]);
        svg.appendChild(sEl("line", {x1:GX, y1:GY, x2:h1x, y2:h1y, stroke:"#717171", "stroke-dasharray":"3 3"}));
        svg.appendChild(sEl("line", {x1:GX+GW, y1:GY-GH, x2:h2x, y2:h2y, stroke:"#717171", "stroke-dasharray":"3 3"}));
        svg.appendChild(sEl("path", {d:"M "+GX+" "+GY+" C "+h1x+" "+h1y+" "+h2x+" "+h2y+" "+(GX+GW)+" "+(GY-GH), fill:"none", stroke:"#feca08", "stroke-width":3, "stroke-linecap":"round"}));
        [[h1x,h1y,1],[h2x,h2y,2]].forEach(function(pt){
          var g = sEl("circle", {cx:pt[0], cy:pt[1], r:11, fill:"transparent", style:"cursor:grab;touch-action:none"});
          svg.appendChild(g);
          svg.appendChild(sEl("circle", {cx:pt[0], cy:pt[1], r:5, fill:"#feca08", "pointer-events":"none"}));
          g.addEventListener("pointerdown", function(e){
            e.preventDefault();
            try { g.setPointerCapture(e.pointerId); } catch(_){}
            function mv(ev){
              var r = svg.getBoundingClientRect();
              var sc = Math.min(r.width/360, r.height/150);
              var px = (ev.clientX - r.left - (r.width-360*sc)/2)/sc;
              var py = (ev.clientY - r.top - (r.height-150*sc)/2)/sc;
              var nx = Math.max(0, Math.min(1, (px-GX)/GW));
              var ny = Math.max(-.6, Math.min(1.6, (GY-py)/GH));
              if(pt[2] === 1){ est.curve[0] = +nx.toFixed(3); est.curve[1] = +ny.toFixed(3); }
              else { est.curve[2] = +nx.toFixed(3); est.curve[3] = +ny.toFixed(3); }
              drawCurve();
            }
            function up(){ g.removeEventListener("pointermove", mv); g.removeEventListener("pointerup", up); }
            g.addEventListener("pointermove", mv); g.addEventListener("pointerup", up);
          });
        });
      }
      svg.appendChild(sEl("circle", {cx:GX, cy:GY, r:4, fill:"#f2f2f0"}));
      svg.appendChild(sEl("circle", {cx:GX+GW, cy:GY-GH, r:4, fill:"#f2f2f0"}));
      box.appendChild(svg);
      var fm = document.getElementById("mFormula");
      if(fm) fm.textContent = est.spring ? ("spring f=" + est.spring.f + " d=" + est.spring.dmp) : ("cubic-bezier(" + est.curve.join(", ") + ")");
    }
    function wireEasing(){
      var nm = document.getElementById("mName");
      var label = TABS.Easing[cur.idx];
      if(nm) nm.textContent = label;
      if(ECURVES[label]){ est.curve = ECURVES[label].slice(); est.spring = null; }
      else if(ESPRINGS[label]){ est.spring = ESPRINGS[label]; est.curve = null; }
      var pr = EPARAMS[label] || [1.2, 18];
      est.dur = pr[0]; est.blur = pr[1];
      slider("mDurS", "mDurV", .2, 3, function(v){ return v.toFixed(2) + " s"; },
        function(){ return est.dur; }, function(v){ est.dur = +v.toFixed(2); });
      slider("mBlurS", "mBlurV", 0, 60, function(v){ return Math.round(v) + " px"; },
        function(){ return est.blur; }, function(v){ est.blur = Math.round(v); });
      segWire("mSeg", function(){});
      var sw = document.getElementById("mSw"), hx = document.getElementById("mHex");
      if(sw){
        var ci = document.createElement("input");
        ci.type = "color"; ci.value = "#feca08"; ci.style.display = "none";
        document.body.appendChild(ci);
        sw.style.cursor = "pointer"; sw.title = "Click to pick a color";
        sw.onclick = function(){ ci.click(); };
        ci.oninput = function(){
          est.color = ci.value.toUpperCase();
          sw.style.background = ci.value;
          if(hx) hx.textContent = est.color;
        };
      }
      drawCurve();
    }

    /* ---------- other views ---------- */
    var vst = { tDur:1.2, tDist:60, dir:"In", gB:18, gS:150, gT:"#88c0ff",
      sInt:70, eF:1.5, eA:40, nFrom:0, nTo:1000, nDur:2, dev:"iPhone 15 Pro" };

    function rowHTML(label, inner){
      return '<div class="prow"><b>' + label + '</b>' + inner + '</div>';
    }
    function sliderRow(id, vid, label){
      return rowHTML(label, '<span class="mslider" id="' + id + '"></span><span id="' + vid + '"></span>');
    }

    var VIEWS = {
      Text: function(){
        main.innerHTML = '<div class="mstage" style="min-height:170px;"><div class="tx" id="mTx">Pineapple</div></div>'
          + '<div class="mock-params" style="margin-top:12px;">'
          + sliderRow("mTDur", "mTDurV", "Duration")
          + sliderRow("mTDist", "mTDistV", "Distance")
          + rowHTML("", '<button id="mReplay" class="apply" style="border:none;">Replay</button>')
          + '</div>';
        function play(){
          var t = document.getElementById("mTx"); if(!t) return;
          var key = TABS.Text[cur.idx], cfg = TEX[key] || {a:"mFade"};
          t.style.fontFamily = cfg.mono ? "monospace" : "inherit";
          t.style.overflow = cfg.mono ? "hidden" : "visible";
          t.style.whiteSpace = cfg.mono ? "nowrap" : "normal";
          t.style.setProperty("--dist", vst.tDist + "px");
          t.style.animation = "none"; void t.offsetWidth;
          t.style.animation = cfg.a + " " + vst.tDur + "s cubic-bezier(.3,1.4,.4,1) both";
        }
        slider("mTDur", "mTDurV", .3, 3, function(v){ return v.toFixed(1) + " s"; },
          function(){ return vst.tDur; }, function(v){ vst.tDur = +v.toFixed(1); });
        slider("mTDist", "mTDistV", 0, 200, function(v){ return Math.round(v) + " px"; },
          function(){ return vst.tDist; }, function(v){ vst.tDist = Math.round(v); });
        document.getElementById("mReplay").onclick = play;
        play();
      },
      Transitions: function(){
        main.innerHTML = '<div class="mstage" style="min-height:170px;"><div id="mCard" style="background:linear-gradient(135deg,#feca08,#ff8a3d);border-radius:12px;padding:22px 34px;font-weight:800;color:#241a04;">Pineapple</div></div>'
          + '<div class="mock-params" style="margin-top:12px;">'
          + rowHTML("Direction", '<span class="seg" id="mDirSeg"><i class="on">In</i><i>Out</i></span>')
          + sliderRow("mTrDur", "mTrDurV", "Duration")
          + rowHTML("", '<button id="mTrGo" class="apply" style="border:none;">Replay transition</button>')
          + '</div>';
        slider("mTrDur", "mTrDurV", .2, 2, function(v){ return v.toFixed(2) + " s"; },
          function(){ return vst.tDur; }, function(v){ vst.tDur = +v.toFixed(2); });
        segWire("mDirSeg", function(v){ vst.dir = v; });
        var names = TABS.Transitions;
        document.getElementById("mTrGo").onclick = function(){
          var card = document.getElementById("mCard"); if(!card || !card.animate) return;
          var name = names[cur.idx] || names[0], ms = vst.tDur*1000, into = (vst.dir === "In");
          var fx = { "Fade Chars":[{opacity:0},{opacity:1}],
            "Rise Chars":[{opacity:0,transform:"translateY(40px)"},{opacity:1,transform:"none"}],
            "Drop Chars":[{opacity:0,transform:"translateY(-40px)"},{opacity:1,transform:"none"}],
            "Spin Chars":[{opacity:0,transform:"rotate(-90deg) scale(.6)"},{opacity:1,transform:"none"}] }[name] || [{opacity:0},{opacity:1}];
          var seq = into ? fx : fx.slice().reverse();
          var an = card.animate(seq, {duration:ms, easing:"cubic-bezier(.3,1.3,.4,1)", fill:"forwards"});
          if(an && an.finished){ an.finished.then(function(){
            setTimeout(function(){ card.animate(into ? seq : fx, {duration:1, fill:"forwards"}); }, 350);
          }); }
        };
      },
      Glass: function(){
        main.innerHTML = '<div class="mstage mglassbg" style="min-height:170px;"><div id="mFrost" style="background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.35);border-radius:16px;padding:26px 40px;font-weight:800;font-size:20px;color:#fff;">Glass</div></div>'
          + '<div class="mock-params" style="margin-top:12px;">'
          + sliderRow("mGB", "mGBV", "Blur")
          + sliderRow("mGS", "mGSV", "Saturation")
          + rowHTML("Tint", '<span class="swatch" id="mGT"></span><span id="mGTV">#88C0FF</span>')
          + '</div>';
        function paint(){
          var f = document.getElementById("mFrost"); if(!f) return;
          f.style.backdropFilter = "blur(" + vst.gB + "px) saturate(" + vst.gS + "%)";
          f.style.webkitBackdropFilter = f.style.backdropFilter;
          f.style.background = "rgba(255,255,255,.14)";
          f.style.boxShadow = "inset 0 1px 0 rgba(255,255,255,.4), 0 8px 24px rgba(0,0,0,.25)";
          var t = document.getElementById("mGT"), tv = document.getElementById("mGTV");
          if(t){ t.style.background = vst.gT; if(tv) tv.textContent = vst.gT.toUpperCase(); }
          var bv = document.getElementById("mGBV"); if(bv) bv.textContent = Math.round(vst.gB) + " px";
          var sv = document.getElementById("mGSV"); if(sv) sv.textContent = Math.round(vst.gS) + " %";
        }
        function applyPreset(){
          var g = GLASS[TABS.Glass[cur.idx]] || GLASS["Liquid Glass"];
          vst.gB = g.b; vst.gS = g.s; vst.gT = g.t;
          var bs = document.getElementById("mGB"), ss = document.getElementById("mGS");
          if(bs) bs.style.setProperty("--f", (vst.gB/40*100) + "%");
          if(ss) ss.style.setProperty("--f", ((vst.gS-100)/100*100) + "%");
          paint();
        }
        slider("mGB", "mGBV", 0, 40, function(v){ return Math.round(v) + " px"; },
          function(){ return vst.gB; }, function(v){ vst.gB = Math.round(v); paint(); });
        slider("mGS", "mGSV", 100, 200, function(v){ return Math.round(v) + " %"; },
          function(){ return vst.gS; }, function(v){ vst.gS = Math.round(v); paint(); });
        var t = document.getElementById("mGT");
        if(t){
          var ci = document.createElement("input");
          ci.type = "color"; ci.value = "#88c0ff"; ci.style.display = "none";
          document.body.appendChild(ci);
          t.style.cursor = "pointer";
          t.onclick = function(){ ci.click(); };
          ci.oninput = function(){ vst.gT = ci.value; paint(); };
        }
        applyPreset();
      },
      Styles: function(){
        main.innerHTML = '<div class="mstage" style="min-height:170px;"><div id="mArt" class="mart" style="width:220px;height:120px;border-radius:12px;"></div></div>'
          + '<div class="mock-params" style="margin-top:12px;">'
          + sliderRow("mSI", "mSIV", "Intensity")
          + '</div>';
        function paint(){
          var a = document.getElementById("mArt"); if(!a) return;
          var fn = STYLES[TABS.Styles[cur.idx]] || STYLES["Grade Warm"];
          a.style.filter = fn(vst.sInt/100);
        }
        slider("mSI", "mSIV", 0, 100, function(v){ return Math.round(v) + " %"; },
          function(){ return vst.sInt; }, function(v){ vst.sInt = Math.round(v); paint(); });
        paint();
      },
      Expressions: function(){
        main.innerHTML = '<pre class="mpre" id="mCode"></pre>'
          + '<div class="mock-params" style="margin-top:12px;">'
          + rowHTML("Applies to", '<span style="color:#f2f2f0;" id="mTarget">Position</span>')
          + sliderRow("mEF", "mEFV", "Frequency")
          + sliderRow("mEA", "mEAV", "Amplitude")
          + rowHTML("", '<button id="mCopy" class="apply" style="border:none;">Copy expression</button>')
          + '</div>';
        function paint(){
          var spec = EXPR[TABS.Expressions[cur.idx]] || EXPR.Wiggle;
          var code = spec.code({f:vst.eF, a:Math.round(vst.eA)});
          document.getElementById("mCode").textContent = code;
          document.getElementById("mTarget").textContent = spec.t;
        }
        slider("mEF", "mEFV", .1, 10, function(v){ return (+v).toFixed(1) + " Hz"; },
          function(){ return vst.eF; }, function(v){ vst.eF = +(+v).toFixed(1); paint(); });
        slider("mEA", "mEAV", 0, 200, function(v){ return Math.round(v) + " px"; },
          function(){ return vst.eA; }, function(v){ vst.eA = Math.round(v); paint(); });
        document.getElementById("mCopy").onclick = function(){
          copyText(document.getElementById("mCode").textContent, "Expression copied.");
        };
        paint();
      },
      Numbers: function(){
        main.innerHTML = '<div class="mstage" style="min-height:150px;"><div id="mNum" style="font-family:monospace;font-size:52px;font-weight:800;color:#feca08;">0</div></div>'
          + '<div class="mock-params" style="margin-top:12px;">'
          + sliderRow("mNFrom", "mNFromV", "From")
          + sliderRow("mNTo", "mNToV", "To")
          + sliderRow("mNDur", "mNDurV", "Duration")
          + rowHTML("", '<button id="mNGo" class="apply" style="border:none;">Run counter</button>')
          + '</div>';
        slider("mNFrom", "mNFromV", 0, 500, function(v){ return "" + Math.round(v); },
          function(){ return vst.nFrom; }, function(v){ vst.nFrom = Math.round(v); });
        slider("mNTo", "mNToV", 100, 1000, function(v){ return "" + Math.round(v); },
          function(){ return vst.nTo; }, function(v){ vst.nTo = Math.round(v); });
        slider("mNDur", "mNDurV", .5, 5, function(v){ return (+v).toFixed(1) + " s"; },
          function(){ return vst.nDur; }, function(v){ vst.nDur = +(+v).toFixed(1); });
        document.getElementById("mNGo").onclick = function(){
          var n0 = vst.nFrom, n1 = vst.nTo, dur = vst.nDur*1000, t0 = null;
          var elN = document.getElementById("mNum");
          function frame(t){
            if(t0 === null) t0 = t;
            var p = Math.min(1, (t-t0)/dur), e = 1-Math.pow(1-p, 3);
            elN.textContent = Math.round(n0 + (n1-n0)*e);
            if(p < 1) requestAnimationFrame(frame);
          }
          if(window.requestAnimationFrame) requestAnimationFrame(frame);
          else elN.textContent = n1;
        };
      },
      Devices: function(){
        main.innerHTML = '<div class="mstage" style="min-height:300px;" id="mDevStage"></div>'
          + '<div class="mock-params" style="margin-top:12px;">'
          + rowHTML("Size", '<span style="color:#f2f2f0;" id="mDevSpec"></span>')
          + '</div>';
        function paint(){
          var key = TABS.Devices[cur.idx] || "iPhone 15 Pro";
          var d = DEVICES[key];
          var st = document.getElementById("mDevStage"); if(!st) return;
          st.innerHTML = '<div class="mphone" style="width:' + d.w + 'px;">'
            + '<div class="mscreen" style="height:' + d.h + 'px;">'
            + (d.island ? '<div class="misland" style="width:52px;height:16px;"></div>' : '')
            + '<div style="position:absolute;top:26px;left:0;right:0;text-align:center;color:#fff;font-size:11px;font-weight:700;">9:41</div>'
            + '<div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(254,202,8,.35),rgba(255,55,95,.25) 60%,rgba(10,132,255,.3));"></div>'
            + '<div style="position:absolute;bottom:14px;left:0;right:0;text-align:center;color:#fff;font-size:10px;font-weight:700;">Pineapple</div>'
            + '</div></div>';
          document.getElementById("mDevSpec").textContent = d.spec;
        }
        paint();
      },
      Tools: function(){
        var names = TABS.Tools;
        var html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">';
        names.forEach(function(n){ html += '<div class="mtoolbtn" data-t="' + n + '">' + n + '</div>'; });
        main.innerHTML = html + '</div>';
        Array.prototype.forEach.call(main.querySelectorAll(".mtoolbtn"), function(b){
          b.onclick = function(){ toast(b.getAttribute("data-t") + " runs inside After Effects."); };
        });
      }
    };

    /* shell */
    var list = document.getElementById("mList");
    function renderList(){
      if(!list) return;
      list.innerHTML = "";
      TABS[cur.tab].forEach(function(label, i){
        var it = document.createElement("i");
        it.textContent = label;
        if(i === cur.idx) it.className = "on";
        it.onclick = function(){ select(cur.tab, i); };
        list.appendChild(it);
      });
    }
    function renderPills(){
      Array.prototype.forEach.call(pills.children, function(k){
        if(k.textContent === cur.tab) k.classList.add("on");
        else k.classList.remove("on");
      });
    }
    function renderMain(){
      if(cur.tab === "Easing"){
        main.innerHTML = EASING_HTML;
        wireEasing();
      } else {
        VIEWS[cur.tab]();
      }
    }
    function select(tab, idx){
      cur.tab = tab; cur.idx = idx;
      renderPills(); renderList(); renderMain();
    }
    Array.prototype.forEach.call(pills.children, function(k){
      k.style.cursor = "pointer";
      k.onclick = function(){ if(TABS[k.textContent]) select(k.textContent, 0); };
    });
    var ap = document.getElementById("mApply");
    if(ap){ ap.style.cursor = "pointer"; ap.onclick = function(){ toast("Live demo - Apply works inside After Effects once activated."); }; }
    select("Easing", 0);
  })();

