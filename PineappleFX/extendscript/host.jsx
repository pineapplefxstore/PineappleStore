/**
 * PineappleFX · ExtendScript host.
 *
 * Loaded once when the CEP panel opens (see CSXS/manifest.xml → ScriptPath).
 * All public functions:
 *  - Are exposed as top-level globals so they can be called by name from the
 *    panel via `__adobe_cep__.evalScript("pineapplefx_xxx({...})")`.
 *  - Accept native ExtendScript objects/values (the JS bridge serializes args
 *    as ES literals, so we don't need JSON.parse on input).
 *  - Return JSON strings shaped `{ ok: true, payload }` or `{ ok: false, error }`.
 *  - Wrap any AE mutation in app.beginUndoGroup / app.endUndoGroup so a single
 *    Apply collapses to one undo step.
 */

(function () {
    // Path of THIS script, captured at load time (the manifest ScriptPath loads
    // host.jsx, so $.fileName here is the host.jsx path). Used to locate bundled
    // resources like the Chrome gradient animation preset. Captured at load
    // because $.fileName changes to the evalScript string when functions run.
    var HOST_FILE = (function () {
        try { return $.fileName; } catch (e) { return null; }
    })();

    // Resolve a file bundled next to host.jsx under extendscript/<rel>. Prefers
    // an explicit extension path passed from the panel (getSystemPath), then
    // falls back to the captured host.jsx folder. Returns a File or null.
    function bundledFile(rel, extPath) {
        // 1) explicit extension root from the panel: <ext>/extendscript/<rel>
        if (extPath) {
            try {
                var f1 = new File(String(extPath) + '/extendscript/' + rel);
                if (f1.exists) return f1;
            } catch (e) {}
        }
        // 2) folder of host.jsx: <...>/extendscript/<rel>
        if (HOST_FILE) {
            try {
                var dir = File(HOST_FILE).parent;
                var f2 = new File(dir.fsName + '/' + rel);
                if (f2.exists) return f2;
            } catch (e) {}
        }
        return null;
    }

    // --- JSON (self-contained) -------------------------------------------
    // Two problems forced this: ExtendScript had no JSON at all before AE
    // 2026, and AE 2026's built-in JSON global is BROKEN for objects - it
    // drops keys, string values and closing braces, so
    // JSON.stringify({a:"b"}) returns "{: }". Every {ok:true,...} reply then
    // failed JSON.parse() on the panel side and Direct mode reported
    // "After Effects ran but the PineappleFX engine did not load."
    // Ship our own implementation; ok()/err() always use it, and the global
    // JSON is replaced as well whenever the native one is missing or wrong.
    var pfxJSON = (function () {
        function quote(s) {
            var out = '"';
            for (var i = 0; i < s.length; i++) {
                var c = s.charAt(i);
                var code = s.charCodeAt(i);
                if (c === '"') out += '\\"';
                else if (c === '\\') out += '\\\\';
                else if (c === '\b') out += '\\b';
                else if (c === '\f') out += '\\f';
                else if (c === '\n') out += '\\n';
                else if (c === '\r') out += '\\r';
                else if (c === '\t') out += '\\t';
                else if (code < 32 || code === 0x2028 || code === 0x2029) {
                    var hex = code.toString(16);
                    while (hex.length < 4) hex = '0' + hex;
                    out += '\\u' + hex;
                } else out += c;
            }
            return out + '"';
        }

        function stringify(value, replacer, space) {
            var indent = '';
            if (typeof space === 'number') {
                for (var si = 0; si < space && si < 10; si++) indent += ' ';
            } else if (typeof space === 'string') {
                indent = space.length > 10 ? space.slice(0, 10) : space;
            }
            var gap = indent ? ' ' : '';
            var rep = (replacer && typeof replacer === 'function') ? replacer : null;
            var stack = [];

            function str(key, holder) {
                var v = holder[key];
                var k, s, i, ks, partial, member;
                if (v && typeof v === 'object' && typeof v.toJSON === 'function') v = v.toJSON(key);
                if (rep) v = rep.call(holder, key, v);
                switch (typeof v) {
                    case 'string': return quote(v);
                    case 'number': return isFinite(v) ? String(v) : 'null';
                    case 'boolean': return String(v);
                    case 'null': return 'null';
                    case 'object':
                        if (v === null) return 'null';
                        for (s = 0; s < stack.length; s++) {
                            if (stack[s] === v) throw new TypeError('Converting circular structure to JSON');
                        }
                        stack.push(v);
                        var out = '';
                        if (Object.prototype.toString.call(v) === '[object Array]') {
                            partial = [];
                            for (i = 0; i < v.length; i++) {
                                partial[i] = str(i, v) || 'null';
                            }
                            out = (partial.length === 0)
                                ? '[]'
                                : (gap ? '[\n' + indent + partial.join(',\n' + indent) + '\n' + gap + ']'
                                       : '[' + partial.join(',') + ']');
                            stack.pop();
                            return out;
                        }
                        ks = [];
                        for (k in v) if (Object.prototype.hasOwnProperty.call(v, k)) ks.push(k);
                        partial = [];
                        for (i = 0; i < ks.length; i++) {
                            k = ks[i];
                            member = str(k, v);
                            if (member !== undefined) partial.push((gap ? indent : '') + quote(k) + ':' + (gap ? ' ' : '') + member);
                        }
                        out = (partial.length === 0)
                            ? '{}'
                            : (gap ? '{\n' + indent + partial.join(',\n' + indent) + '\n' + gap + '}'
                                   : '{' + partial.join(',') + '}');
                        stack.pop();
                        return out;
                }
                return undefined;
            }
            return str('', { '': value });
        }

        // Recursive-descent JSON parser (ES3, no regex backtracking).
        function parse(text) {
            var i = 0;
            var s = String(text);

            function error(msg) { throw new SyntaxError('JSON ' + msg + ': ' + s.slice(0, 40)); }
            function ws() {
                while (i < s.length) {
                    var c = s.charAt(i);
                    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++;
                    else break;
                }
            }
            function lit(word) {
                if (s.substr(i, word.length) === word) { i += word.length; return; }
                error('unexpected token');
            }
            function strLit() {
                if (s.charAt(i) !== '"') error('expected string');
                i++;
                var out = '';
                while (i < s.length) {
                    var c = s.charAt(i++);
                    if (c === '"') return out;
                    if (c === '\\') {
                        var e = s.charAt(i++);
                        if (e === '"') out += '"';
                        else if (e === '\\') out += '\\';
                        else if (e === '/') out += '/';
                        else if (e === 'b') out += '\b';
                        else if (e === 'f') out += '\f';
                        else if (e === 'n') out += '\n';
                        else if (e === 'r') out += '\r';
                        else if (e === 't') out += '\t';
                        else if (e === 'u') {
                            out += String.fromCharCode(parseInt(s.substr(i, 4), 16));
                            i += 4;
                        } else error('bad escape');
                    } else out += c;
                }
                error('unterminated string');
            }
            function value() {
                ws();
                var c = s.charAt(i);
                if (c === '{') {
                    i++;
                    var obj = {};
                    ws();
                    if (s.charAt(i) === '}') { i++; return obj; }
                    for (;;) {
                        ws();
                        var k = strLit();
                        ws();
                        if (s.charAt(i) !== ':') error('expected ":"');
                        i++;
                        obj[k] = value();
                        ws();
                        if (s.charAt(i) === ',') { i++; continue; }
                        if (s.charAt(i) === '}') { i++; return obj; }
                        error('expected "," or "}"');
                    }
                }
                if (c === '[') {
                    i++;
                    var arr = [];
                    ws();
                    if (s.charAt(i) === ']') { i++; return arr; }
                    for (;;) {
                        arr.push(value());
                        ws();
                        if (s.charAt(i) === ',') { i++; continue; }
                        if (s.charAt(i) === ']') { i++; return arr; }
                        error('expected "," or "]"');
                    }
                }
                if (c === '"') return strLit();
                if (s.substr(i, 4) === 'true') { i += 4; return true; }
                if (s.substr(i, 5) === 'false') { i += 5; return false; }
                if (s.substr(i, 4) === 'null') { i += 4; return null; }
                var m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(s.slice(i));
                if (m) { i += m[0].length; return Number(m[0]); }
                error('unexpected token');
            }
            var v = value();
            ws();
            if (i !== s.length) error('trailing characters');
            return v;
        }

        return { stringify: stringify, parse: parse };
    })();

    // Prefer our implementation whenever the engine's one is missing or wrong.
    try {
        var __jsonBroken = (typeof JSON === 'undefined') || !JSON ||
            (typeof JSON.stringify !== 'function') ||
            (JSON.stringify({ a: 'b' }) !== '{"a":"b"}') ||
            (JSON.stringify(['x', 1]) !== '["x",1]') ||
            (JSON.stringify(null) !== 'null') ||
            (JSON.stringify('q"') !== '"q\\""');
        if (__jsonBroken) $.global.JSON = pfxJSON;
    } catch (e) {
        try { $.global.JSON = pfxJSON; } catch (e2) {}
    }

    // --- small helpers ----------------------------------------------------
    function ok(payload) {
        return pfxJSON.stringify({ ok: true, payload: payload === undefined ? null : payload });
    }
    function err(message) {
        return pfxJSON.stringify({ ok: false, error: String(message && message.message ? message.message : message) });
    }
    function activeComp() {
        // 1) Primary: what AE reports as the active item.
        var item = null;
        try { item = app.project ? app.project.activeItem : null; } catch (e) { item = null; }
        if (item && (item instanceof CompItem)) {
            $.global.__pineapplefx_lastComp = item;
            return item;
        }

        // app.project.activeItem can be null when a CEP panel is the focused
        // window (a long-standing Adobe quirk — and on some AE 2026 setups it
        // returns null even more aggressively, e.g. Windows + AE 26). Fall back
        // through robust signals so the panel still finds the user's comp.

        // Validate any cached comp (the last one we saw) is still alive.
        var cached = null;
        try {
            cached = $.global.__pineapplefx_lastComp;
            if (cached && (cached instanceof CompItem)) { var _probe = cached.numLayers; }
            else cached = null;
        } catch (e2) { cached = null; }

        // 2) Cached comp that still has a selection — almost certainly still active.
        if (cached) {
            try { if (cached.selectedLayers && cached.selectedLayers.length > 0) return cached; } catch (e3) {}
        }

        // 3) ANY comp that currently has selected layers. The user's selection
        //    points at the comp they're working in, so this finds the active comp
        //    even when app.project.activeItem is null.
        try {
            var proj = app.project;
            if (proj) {
                for (var i = 1; i <= proj.numItems; i++) {
                    var it = proj.item(i);
                    if (it instanceof CompItem) {
                        try {
                            if (it.selectedLayers && it.selectedLayers.length > 0) {
                                $.global.__pineapplefx_lastComp = it;
                                return it;
                            }
                        } catch (e4) {}
                    }
                }
            }
        } catch (e5) {}

        // 4) Last resort: the cached comp even without a current selection.
        if (cached) return cached;
        return null;
    }

    // Collect every selected keyframe across selected layers' selected properties.
    // Layered fallbacks, in order of specificity:
    //   1. Property has explicit selectedKeys → apply to those
    //   2. Property is selected but no keys → apply to all keys on it
    //   3. Layer is selected with NO highlighted properties → scan transform
    //      group for any property that has keyframes
    function collectKeyTargets(comp, opts) {
        var out = []; // [{ prop, keys: [1,2,...] }]
        var layers = comp.selectedLayers;
        // separateSpatial: true when the caller's curve has overshoot/undershoot
        // (y outside [0,1]). On Position / Anchor Point that visible undershoot
        // is impossible while the property is spatial (the motion path clamps
        // values between endpoints), so we auto-separate dimensions ONLY in
        // that case. For normal eases (Apple Standard, Decelerated, etc.) we
        // leave Position spatial — which is what most users want by default.
        var separateSpatial = !!(opts && opts.separateSpatial);

        // Whether a keyframed property is worth attempting to set a temporal
        // ease on. We intentionally cast a WIDE net here: anything the user has
        // selected keyframes for, we try. setEaseRobust below is non-throwing,
        // so if AE refuses a particular property type (some structured values
        // like layer-style gradient stops can refuse), we just count it as
        // "skipped" — we never abort the whole apply on it. The only thing we
        // hard-reject is property GROUPS (NO_VALUE, no actual keys), which are
        // never selectable as keyframes anyway but show up as parents in
        // selectedProperties. Critically, CUSTOM_VALUE is NOT rejected:
        // gradient stops, source-text, etc. CAN be keyed and may or may not
        // accept ease depending on AE build — letting setEaseRobust try is the
        // right call.
        function isEaseable(p) {
            try {
                if (!p) return false;
                if (!p.canVaryOverTime) return false;
                if (!p.numKeys || p.numKeys < 1) return false;
                try {
                    if (p.propertyValueType === PropertyValueType.NO_VALUE) return false;
                } catch (_e) {}
                return true;
            } catch (e) { return false; }
        }

        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            var props = layer.selectedProperties;

            if (!props || props.length === 0) {
                // Fallback 3: walk common transform properties. Spatial leaders
                // (Position / Anchor Point) get auto-separated only when the
                // caller's curve actually needs it (overshoot/undershoot).
                var posP = null, ancP = null;
                try { posP = layer.transform.property('ADBE Position'); } catch (_e) {}
                try { ancP = layer.transform.property('ADBE Anchor Point'); } catch (_e) {}
                var posFollowers = (separateSpatial && posP) ? trySeparateDimensions(posP) : null;
                if (posFollowers) { for (var pi = 0; pi < posFollowers.length; pi++) pushAllKeys(out, posFollowers[pi]); }
                else pushIfHasKeys(out, posP);

                pushIfHasKeys(out, layer.transform.property('ADBE Scale'));
                pushIfHasKeys(out, layer.transform.property('ADBE Opacity'));
                try {
                    pushIfHasKeys(out, layer.threeDLayer
                        ? layer.transform.property('ADBE Rotate Z')
                        : layer.transform.property('ADBE Rotate Z'));
                } catch (_e) {}

                var ancFollowers = (separateSpatial && ancP) ? trySeparateDimensions(ancP) : null;
                if (ancFollowers) { for (var ai = 0; ai < ancFollowers.length; ai++) pushAllKeys(out, ancFollowers[ai]); }
                else pushIfHasKeys(out, ancP);
                continue;
            }

            for (var j = 0; j < props.length; j++) {
                // Every per-property access is wrapped: some property objects
                // (notably layer-style Gradient sub-groups) make their getters
                // — propertyValueType, canVaryOverTime, numKeys, selectedKeys —
                // throw the AE "Can not get or set a value… NO_VALUE" error.
                // That error was leaking out of collectKeyTargets and being
                // returned to the panel verbatim. We now isolate every getter,
                // and a bad property is silently skipped.
                try {
                    var p = props[j];
                    if (!isEaseable(p)) continue;

                    // 2D/3D spatial properties (Position, Anchor Point) carry a
                    // single TEMPORAL ease that's clamped between the two endpoint
                    // values by their motion path. That means an "overshoot" curve
                    // (y outside [0,1]) can't actually undershoot/overshoot the
                    // start/end values — the curve just moves back and forth
                    // along the path. To make Anticipate / Bouncy / Snap behave
                    // intuitively on Position, we separate the spatial dimensions
                    // first — but ONLY when the caller's curve has that overshoot
                    // shape. Normal eases (Apple Standard, Decelerated, etc.) keep
                    // Position spatial, which is what most users expect by default.
                    // Existing keyframes are migrated by AE automatically.
                    var leaderProps = separateSpatial ? trySeparateDimensions(p) : null;
                    if (leaderProps && leaderProps.length > 0) {
                        for (var lp = 0; lp < leaderProps.length; lp++) {
                            pushAllKeys(out, leaderProps[lp]);
                        }
                        continue;
                    }

                    var keys = [];
                    var ks = null;
                    try { ks = p.selectedKeys; } catch (_eKs) { ks = null; }
                    if (ks && ks.length > 0) {
                        for (var k = 0; k < ks.length; k++) keys.push(ks[k]);
                    } else {
                        var nk = 0;
                        try { nk = p.numKeys; } catch (_eNk) { nk = 0; }
                        for (var n = 1; n <= nk; n++) keys.push(n);
                    }
                    if (keys.length > 0) out.push({ prop: p, keys: keys });
                } catch (_ePerProp) { /* skip this property */ }
            }
        }
        return out;
    }

    // If `p` is a spatial separation-leader (Position / Anchor Point) with
    // keyframes, separate its dimensions and return its 1D follower properties
    // (each carrying the migrated keyframes). Returns null if `p` doesn't need
    // (or can't be) separated, so the caller falls back to its original handling.
    function trySeparateDimensions(p) {
        try {
            if (!p.isSeparationLeader) return null;
            // Only the spatial value types: separating Scale/Color produces
            // followers too but we WANT to keep those as multi-dim (the user's
            // expectation is "Scale eased together"). Spatial is the special
            // case because of the motion-path clamp.
            var pvt = null;
            try { pvt = p.propertyValueType; } catch (_e) {}
            var isSpatial = (pvt === PropertyValueType.TwoD_SPATIAL ||
                             pvt === PropertyValueType.ThreeD_SPATIAL);
            if (!isSpatial) return null;

            if (!p.dimensionsSeparated) {
                try { p.dimensionsSeparated = true; } catch (_e2) { return null; }
            }
            var followers = [];
            // 2D-spatial → 2 followers (X, Y). 3D-spatial → 3 (X, Y, Z).
            var count = (pvt === PropertyValueType.ThreeD_SPATIAL) ? 3 : 2;
            for (var i = 0; i < count; i++) {
                try {
                    var f = p.getSeparationFollower(i);
                    if (f) followers.push(f);
                } catch (_eF) {}
            }
            return followers.length > 0 ? followers : null;
        } catch (e) { return null; }
    }

    // Push all keyframes of `prop` as a target. Used after separating dimensions
    // (each follower carries all original keys; we ease every one of them).
    function pushAllKeys(out, prop) {
        try {
            if (!prop) return;
            var nk = 0;
            try { nk = prop.numKeys; } catch (_e) { return; }
            if (nk < 1) return;
            var keys = [];
            for (var n = 1; n <= nk; n++) keys.push(n);
            out.push({ prop: prop, keys: keys });
        } catch (e) {}
    }

    function pushIfHasKeys(out, prop) {
        try {
            if (prop && prop.canVaryOverTime && prop.numKeys > 0) {
                var keys = [];
                for (var n = 1; n <= prop.numKeys; n++) keys.push(n);
                out.push({ prop: prop, keys: keys });
            }
        } catch (e) {}
    }

    // Determine the per-dimension count for a property's value at a given key.
    function dimensionOf(prop, keyIndex) {
        try {
            var v = prop.keyValue(keyIndex);
            if (v && v.length !== undefined) return v.length;
        } catch (e) {}
        return 1;
    }

    // Spatial properties (Position, Anchor Point, etc.) carry a SINGLE temporal
    // ease regardless of how many spatial dimensions the value has. Non-spatial
    // multidimensional properties (Scale, Colors) carry one ease per dimension.
    // setTemporalEaseAtKey throws if the ease-array length doesn't match, which
    // was silently aborting the whole "Apply Easing" on Position layers.
    function isSpatialProp(prop) {
        try {
            var pvt = prop.propertyValueType;
            return (pvt === PropertyValueType.TwoD_SPATIAL ||
                    pvt === PropertyValueType.ThreeD_SPATIAL);
        } catch (e) { return false; }
    }

    // The number of ease elements setTemporalEaseAtKey expects for this prop.
    function easeDimOf(prop, valueDim) {
        return isSpatialProp(prop) ? 1 : valueDim;
    }

    // Value delta used to convert a curve slope into AE speed (value/sec).
    //   - Spatial single-ease prop (easeDim 1, value multi-dim): use the
    //     vector magnitude of the move so speed reflects actual travel.
    //   - Per-dimension ease: use that dimension's delta.
    //   - Scalar prop: plain difference.
    function scalarDelta(a, b, easeDim, d, valueDim) {
        if (a == null || b == null) return 0;
        var isArr = (a.length !== undefined);
        if (!isArr) return b - a;
        if (easeDim === 1) {
            // magnitude of (b - a) across all value dims
            var sum = 0;
            for (var i = 0; i < valueDim; i++) {
                var di = (b[i] || 0) - (a[i] || 0);
                sum += di * di;
            }
            return Math.sqrt(sum);
        }
        return (b[d] || 0) - (a[d] || 0);
    }

    // Clamp temporal-ease speed to a sane range. Near-vertical bezier handles
    // (x1≈0) produce mathematically huge slopes; AE clamps internally but very
    // large values can glitch the graph. This keeps the curve faithful while
    // staying within AE's comfortable range.
    function capSpeed(v) {
        var MAX = 1e6;
        if (v > MAX) return MAX;
        if (v < -MAX) return -MAX;
        return v;
    }

    // Set bezier ease on a key, with a dimension fallback: if our first guess
    // at the ease-array length is rejected by AE, retry with the other length.
    // Returns true on success.
    function setEaseRobust(prop, idx, inArr, outArr, valueDim) {
        // setInterpolationTypeAtKey can itself throw on some property/key combos;
        // keep it INSIDE the guard so a failure here can never propagate up and
        // abort the caller (which previously skipped the opacity fade that runs
        // after the position/scale ease in every transition builder).
        try {
            prop.setInterpolationTypeAtKey(idx,
                KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
        } catch (e0) {}
        try {
            prop.setTemporalEaseAtKey(idx, inArr, outArr);
            return true;
        } catch (e1) {
            var alt = (inArr.length === 1) ? valueDim : 1;
            if (alt === inArr.length) return false;
            var inB = [], outB = [];
            for (var d = 0; d < alt; d++) {
                inB.push(inArr[Math.min(d, inArr.length - 1)]);
                outB.push(outArr[Math.min(d, outArr.length - 1)]);
            }
            try { prop.setTemporalEaseAtKey(idx, inB, outB); return true; }
            catch (e2) { return false; }
        }
    }

    // Look up a Transform property on a layer by AE match name. Used by the
    // Expressions tab when the user picks a target other than "auto".
    function transformPropByMatch(layer, matchName) {
        try {
            var t = layer.transform || layer.property('ADBE Transform Group');
            if (!t) return null;
            if (matchName === 'ADBE Position') return t.property('ADBE Position') || t.position;
            if (matchName === 'ADBE Scale') return t.property('ADBE Scale') || t.scale;
            if (matchName === 'ADBE Opacity') return t.property('ADBE Opacity') || t.opacity;
            if (matchName === 'ADBE Anchor Point') return t.property('ADBE Anchor Point') || t.anchorPoint;
            if (matchName === 'ADBE Rotate Z') {
                // 3D layers expose zRotation; 2D layers expose rotation.
                if (layer.threeDLayer) return t.property('ADBE Rotate Z') || t.zRotation;
                return t.property('ADBE Rotate Z') || t.rotation;
            }
        } catch (e) {}
        return null;
    }

    // --- public API -------------------------------------------------------

    /**
     * Sanity check - confirms the host is alive and reports AE version.
     */
    $.global.pineapplefx_ping = function () {
        try {
            return ok({
                app: typeof app !== 'undefined' ? app.appName : null,
                version: typeof app !== 'undefined' ? app.version : null
            });
        } catch (e) { return err(e); }
    };

    /**
     * Classify one layer for the recommendation engine. Specific flags are
     * checked before the generic AVLayer cases, because a null and an
     * adjustment layer are both AVLayers.
     */
    function pfxLayerKind(layer) {
        try {
            if (layer instanceof TextLayer) return 'text';
            if (layer instanceof ShapeLayer) return 'shape';
            if (layer instanceof CameraLayer) return 'camera';
            if (layer instanceof LightLayer) return 'light';
            try { if (layer.nullLayer === true) return 'null'; } catch (e1) {}
            try { if (layer.adjustmentLayer === true) return 'adjustment'; } catch (e2) {}
            try {
                var src = layer.source;
                if (src) {
                    if (src instanceof CompItem) return 'precomp';
                    if (src.mainSource && src.mainSource instanceof SolidSource) return 'solid';
                    return 'footage';
                }
            } catch (e3) {}
            return 'other';
        } catch (e) { return 'other'; }
    }

    /**
     * Report what is currently selected. Polled by the StatusBar.
     *
     * `layerKinds` is additive (added for Smart Recommendations): a
     * de-duplicated list of the kinds present in the selection. Every field
     * that existed before is unchanged.
     */
    $.global.pineapplefx_get_selection_info = function () {
        try {
            var comp = activeComp();
            if (!comp) {
                return ok({ hasComp: false, compName: null, layers: 0, properties: 0, keyframes: 0, layerKinds: [] });
            }
            var layers = comp.selectedLayers;
            var props = 0, keys = 0;
            var firstPropName = null, firstPropMatch = null;
            var kinds = [];
            for (var i = 0; i < layers.length; i++) {
                var kind = pfxLayerKind(layers[i]);
                var known = false;
                for (var k = 0; k < kinds.length; k++) { if (kinds[k] === kind) { known = true; break; } }
                if (!known) kinds.push(kind);

                var ps = layers[i].selectedProperties;
                for (var j = 0; j < ps.length; j++) {
                    var p = ps[j];
                    if (!p.canVaryOverTime && !p.canSetExpression) continue;
                    if (firstPropName === null) {
                        firstPropName = p.name;
                        try { firstPropMatch = p.matchName; } catch (_e) { firstPropMatch = null; }
                    }
                    props++;
                    if (p.selectedKeys && p.selectedKeys.length) {
                        keys += p.selectedKeys.length;
                    }
                }
            }
            var hasPfx = false;
            for (var h = 0; h < layers.length; h++) {
                if (pfxLayerHasPineapplefx(layers[h])) { hasPfx = true; break; }
            }
            return ok({
                hasComp: true,
                compName: comp.name,
                layers: layers.length,
                properties: props,
                keyframes: keys,
                firstPropertyName: firstPropName,
                firstPropertyMatchName: firstPropMatch,
                hasPineapplefx: hasPfx,
                layerKinds: kinds
            });
        } catch (e) { return err(e); }
    };

    /**
     * Apply a cubic-bezier easing to selected keyframes.
     * args: { x1, y1, x2, y2 }
     *
     * For our presets y1=0 and y2=1, so both slopes are 0 → speed=0 works
     * fine. For custom curves dragged in the UI, we compute speed from the
     * slope of the curve at each endpoint, scaled by the actual value/time
     * delta to the neighboring keyframe.
     *
     * Slope at start of cubic-bezier(x1,y1,x2,y2)  = y1 / x1
     * Slope at end                                  = (1 - y2) / (1 - x2)
     *
     * Speed in AE is (Δvalue / Δtime) - multiply slope by the per-dimension
     * value delta divided by the time delta to the neighbor.
     */
    $.global.pineapplefx_apply_easing = function (args) {
        try {
            args = args || {};
            var x1 = +args.x1, y1 = +args.y1, x2 = +args.x2, y2 = +args.y2;
            if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) {
                return err('Invalid bezier args');
            }
            var comp = activeComp();
            if (!comp) return err('No active composition');

            // A curve has overshoot/undershoot iff a y endpoint is outside [0,1].
            // Only then does separating spatial Position make a visible difference
            // (the motion-path clamp would otherwise hide the bounce). Plain eases
            // keep Position spatial so the project layout doesn't change for no
            // benefit.
            var hasOvershoot = (y1 < 0 || y1 > 1 || y2 < 0 || y2 > 1);

            var targets = collectKeyTargets(comp, { separateSpatial: hasOvershoot });
            if (targets.length === 0) return err('Select layers/properties with keyframes');
            // The reconstructed handle is P1 = (influenceOut, influenceOut·slopeOut).
            // For that to land back on (x1, y1) the slope MUST be divided by the
            // SAME x that the influence uses. Previously influence used the true
            // x1 (0.02) but slope used a FLOORED x (0.08), so P1.y collapsed from
            // 0.778 to 0.02·(0.778/0.08)=0.194 — the handle got pulled down and
            // the curve visibly flattened the further you dragged the handle out.
            // Flow has no such floor; neither do we now. We only clamp influence
            // to AE's valid 0.1–100% range, then derive the slope from that same
            // clamped fraction so P1/P2 reconstruct (x1,y1)/(x2,y2) exactly.
            var outInfluence = Math.max(0.1, Math.min(100, x1 * 100));
            var inInfluence  = Math.max(0.1, Math.min(100, (1 - x2) * 100));
            var fOut = outInfluence / 100;        // == clamped x1
            var fIn  = inInfluence / 100;         // == clamped (1 - x2)
            var slopeOut = y1 / fOut;             // P1 = (fOut, fOut·slopeOut) = (x1, y1)
            var slopeIn  = (1 - y2) / fIn;        // P2 = (1-fIn, 1-fIn·slopeIn) = (x2, y2)

            app.beginUndoGroup('PineappleFX: Apply Easing');
            var modifiedKeys = 0, modifiedProps = 0, skippedProps = 0;
            try {
                for (var t = 0; t < targets.length; t++) {
                    // Each property is wrapped so a single non-eaeable / odd property
                    // (e.g. a sub-leaf of an effect with an exotic value type) can't
                    // abort the rest of the batch. With the collectKeyTargets filter
                    // this is belt-and-suspenders for safety on every AE build.
                    try {
                        var prop = targets[t].prop;
                        var keys = targets[t].keys;
                        if (!prop || !keys || keys.length === 0) continue;

                        // Remove any expression a previous "expression mode" apply may
                        // have left behind, so the keyframe eases actually drive value.
                        try {
                            if (prop.expressionEnabled || (prop.expression && prop.expression.length)) {
                                prop.expression = '';
                                prop.expressionEnabled = false;
                            }
                        } catch (_e) {}

                        // Some properties carry structured values (gradient stops,
                        // source-text TextDocuments, paths, etc.) — we can't compute
                        // a numeric "delta" against them, so we can't derive speed
                        // from slope. We CAN still apply influence with zero speed,
                        // which is what AE's "Easy Ease" command does for those:
                        // produces a curved interpolation between values without
                        // requiring numeric arithmetic on them.
                        var valueDim = dimensionOf(prop, keys[0]);
                        var dim = easeDimOf(prop, valueDim);
                        var numKeysOnProp = prop.numKeys;
                        var structured = false;
                        try {
                            var sampleVal = prop.keyValue(keys[0]);
                            // numeric scalar, or numeric array — anything else we
                            // treat as structured.
                            if (typeof sampleVal !== 'number') {
                                if (!sampleVal || sampleVal.length === undefined ||
                                    typeof sampleVal[0] !== 'number') {
                                    structured = true;
                                }
                            }
                        } catch (_eVal) { structured = true; }

                        for (var k = 0; k < keys.length; k++) {
                            var idx = keys[k];
                            var hasNext = idx < numKeysOnProp;
                            var hasPrev = idx > 1;

                            var inEase = [], outEase = [];
                            if (structured) {
                                // Influence-only ease (speed 0). Influence still
                                // shapes the bezier handle x-extent, which is what
                                // gives the curve its feel; with no usable numeric
                                // delta we just can't drive y (speed). Better than
                                // failing on the user.
                                for (var ds = 0; ds < dim; ds++) {
                                    inEase.push(new KeyframeEase(0, inInfluence));
                                    outEase.push(new KeyframeEase(0, outInfluence));
                                }
                            } else {
                                var curTime = prop.keyTime(idx);
                                var curVal = prop.keyValue(idx);
                                var nextTime = hasNext ? prop.keyTime(idx + 1) : 0;
                                var nextVal  = hasNext ? prop.keyValue(idx + 1) : null;
                                var prevTime = hasPrev ? prop.keyTime(idx - 1) : 0;
                                var prevVal  = hasPrev ? prop.keyValue(idx - 1) : null;

                                for (var d = 0; d < dim; d++) {
                                    var inSpeed = 0, outSpeed = 0;
                                    if (hasNext) {
                                        var dOut = scalarDelta(curVal, nextVal, dim, d, valueDim);
                                        var dt = nextTime - curTime;
                                        if (dt > 0) outSpeed = slopeOut * dOut / dt;
                                    }
                                    if (hasPrev) {
                                        var dIn = scalarDelta(prevVal, curVal, dim, d, valueDim);
                                        var dt2 = curTime - prevTime;
                                        if (dt2 > 0) inSpeed = slopeIn * dIn / dt2;
                                    }
                                    inEase.push(new KeyframeEase(capSpeed(inSpeed), inInfluence));
                                    outEase.push(new KeyframeEase(capSpeed(outSpeed), outInfluence));
                                }
                            }

                            if (setEaseRobust(prop, idx, inEase, outEase, valueDim)) {
                                modifiedKeys++;
                            }
                        }
                        modifiedProps++;
                    } catch (perPropErr) {
                        skippedProps++;
                    }
                }
            } finally {
                app.endUndoGroup();
            }
            if (modifiedKeys === 0) {
                return err('No keyframes were updated. Select keyframes on properties that take an ease (transform, effects, opacity, color, etc.).');
            }
            return ok({ modifiedKeys: modifiedKeys, modifiedProperties: modifiedProps, skippedProperties: skippedProps });
        } catch (e) { return err(e); }
    };

    // Kept for an optional "apply as expression" path / export feature.
    $.global.pineapplefx_apply_easing_expression = function (args) {
        try {
            args = args || {};
            var x1 = +args.x1, y1 = +args.y1, x2 = +args.x2, y2 = +args.y2;
            if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) return err('Invalid bezier args');
            var comp = activeComp();
            if (!comp) return err('No active composition');
            var targets = collectKeyTargets(comp);
            if (targets.length === 0) return err('Select layers/properties with keyframes');
            app.beginUndoGroup('PineappleFX: Apply Easing (Expression)');
            var modifiedKeys = 0, modifiedProps = 0;
            try {
                var bez = easingBezierExpr(x1, y1, x2, y2);
                for (var t = 0; t < targets.length; t++) {
                    var prop = targets[t].prop;
                    if (!prop) continue;
                    try {
                        prop.expression = bez;
                        prop.expressionEnabled = true;
                        modifiedProps++;
                        modifiedKeys += (prop.numKeys || 0);
                    } catch (e) {}
                }
            } finally { app.endUndoGroup(); }
            return ok({ modifiedKeys: modifiedKeys, modifiedProperties: modifiedProps });
        } catch (e) { return err(e); }
    };

    // Build an expression that, for the property it sits on, reproduces a CSS
    // cubic-bezier(x1,y1,x2,y2) between every consecutive keyframe pair. Uses the
    // identical Newton-Raphson sampler as TextPreview.tsx so the timeline value
    // matches the panel's curve preview exactly. Works for scalar and array
    // (Position/Scale/Color) values alike. Falls back to value when <2 keys.
    function easingBezierExpr(x1, y1, x2, y2) {
        return '' +
            'function cb(x){\n' +
            '  if (x <= 0) return 0; if (x >= 1) return 1;\n' +
            '  var x1=' + x1 + ', y1=' + y1 + ', x2=' + x2 + ', y2=' + y2 + ';\n' +
            '  var cx=3*x1, bx=3*(x2-x1)-cx, ax=1-cx-bx;\n' +
            '  var cy=3*y1, by=3*(y2-y1)-cy, ay=1-cy-by;\n' +
            '  var u=x;\n' +
            '  for (var i=0;i<8;i++){\n' +
            '    var f=((ax*u+bx)*u+cx)*u - x;\n' +
            '    var d=(3*ax*u+2*bx)*u+cx;\n' +
            '    if (Math.abs(f)<1e-5) break; if (Math.abs(d)<1e-6) break; u-=f/d;\n' +
            '  }\n' +
            '  if (u<0) u=0; if (u>1) u=1;\n' +
            '  return ((ay*u+by)*u+cy)*u;\n' +
            '}\n' +
            'if (numKeys < 2) { value }\n' +
            'else {\n' +
            '  var n = nearestKey(time).index;\n' +
            '  if (key(n).time > time) n--;\n' +
            '  if (n < 1) { key(1).value }\n' +
            '  else if (n >= numKeys) { key(numKeys).value }\n' +
            '  else {\n' +
            '    var k0 = key(n), k1 = key(n+1);\n' +
            '    var dur = k1.time - k0.time;\n' +
            '    if (dur <= 0) { k1.value }\n' +
            '    else {\n' +
            '      var p = cb((time - k0.time) / dur);\n' +
            '      k0.value + (k1.value - k0.value) * p;\n' +
            '    }\n' +
            '  }\n' +
            '}';
    }

    // (Legacy keyframe-handle easing kept below for reference; the exact
    // expression mode above is what Apply now uses.)
    $.global.pineapplefx_apply_easing_keyframes = function (args) {
        try {
            args = args || {};
            var x1 = +args.x1, y1 = +args.y1, x2 = +args.x2, y2 = +args.y2;
            if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) {
                return err('Invalid bezier args');
            }
            var comp = activeComp();
            if (!comp) return err('No active composition');

            var targets = collectKeyTargets(comp);
            if (targets.length === 0) return err('Select layers/properties with keyframes');

            var overshoots = (y1 > 1 || y1 < 0 || y2 > 1 || y2 < 0);
            var MIN_INF = overshoots ? 16.7 : 1.0;
            var outInfluence = Math.max(MIN_INF, Math.min(100, x1 * 100));
            var inInfluence  = Math.max(MIN_INF, Math.min(100, (1 - x2) * 100));
            var ex1 = Math.max(x1, 0.08);
            var ex2 = Math.min(x2, 0.92);
            var slopeOut = y1 / ex1;
            var slopeIn  = (1 - y2) / (1 - ex2);

            app.beginUndoGroup('PineappleFX: Apply Easing');
            var modifiedKeys = 0, modifiedProps = 0;
            try {
                for (var t = 0; t < targets.length; t++) {
                    var prop = targets[t].prop;
                    var keys = targets[t].keys;
                    var valueDim = dimensionOf(prop, keys[0]);
                    // Spatial props (Position) take a 1-element temporal ease;
                    // everything else takes one element per value dimension.
                    var dim = easeDimOf(prop, valueDim);
                    var numKeysOnProp = prop.numKeys;

                    for (var k = 0; k < keys.length; k++) {
                        var idx = keys[k];
                        var curTime = prop.keyTime(idx);
                        var curVal = prop.keyValue(idx);
                        // OUT side requires next key, IN side requires prev key
                        var hasNext = idx < numKeysOnProp;
                        var hasPrev = idx > 1;
                        var nextTime = hasNext ? prop.keyTime(idx + 1) : 0;
                        var nextVal  = hasNext ? prop.keyValue(idx + 1) : null;
                        var prevTime = hasPrev ? prop.keyTime(idx - 1) : 0;
                        var prevVal  = hasPrev ? prop.keyValue(idx - 1) : null;

                        // For speed we want a representative scalar delta. For a
                        // spatial prop we use the vector magnitude; otherwise the
                        // per-dimension delta.
                        var inEase = [], outEase = [];
                        for (var d = 0; d < dim; d++) {
                            var inSpeed = 0, outSpeed = 0;
                            if (hasNext) {
                                var dOut = scalarDelta(curVal, nextVal, dim, d, valueDim);
                                var dt = nextTime - curTime;
                                if (dt > 0) outSpeed = slopeOut * dOut / dt;
                            }
                            if (hasPrev) {
                                var dIn = scalarDelta(prevVal, curVal, dim, d, valueDim);
                                var dt2 = curTime - prevTime;
                                if (dt2 > 0) inSpeed = slopeIn * dIn / dt2;
                            }
                            inEase.push(new KeyframeEase(capSpeed(inSpeed), inInfluence));
                            outEase.push(new KeyframeEase(capSpeed(outSpeed), outInfluence));
                        }

                        if (setEaseRobust(prop, idx, inEase, outEase, valueDim)) {
                            modifiedKeys++;
                        }
                    }
                    modifiedProps++;
                }
            } finally {
                app.endUndoGroup();
            }
            return ok({ modifiedKeys: modifiedKeys, modifiedProperties: modifiedProps });
        } catch (e) { return err(e); }
    };

    /**
     * Apply the spring expression to every selected property. Existing
     * expressions are overwritten - they live alongside (not instead of) the
     * keyframes, which still drive the value the spring oscillates around.
     * args: { freq, damping }
     */
    $.global.pineapplefx_apply_spring = function (args) {
        try {
            args = args || {};
            var freq = +args.freq || 3.0;
            var damping = +args.damping || 8.0;
            var comp = activeComp();
            if (!comp) return err('No active composition');

            // Amplitude derived from key value DELTA (not velocity) so the
            // spring is visible regardless of how the keyframes are eased.
            // amp = 0.35 means "max bounce is 35% of the last move".
            var expr =
                '// PineappleFX · Spring\n' +
                'amp = 0.35;\n' +
                'freq = ' + freq + ';\n' +
                'decay = ' + damping + ';\n' +
                'n = 0;\n' +
                'if (numKeys > 0) {\n' +
                '    n = nearestKey(time).index;\n' +
                '    if (key(n).time > time) n--;\n' +
                '}\n' +
                'if (n >= 2) {\n' +
                '    t = time - key(n).time;\n' +
                '    delta = key(n).value - key(n - 1).value;\n' +
                '    value + delta * amp * Math.sin(freq * t * 2 * Math.PI) / Math.exp(decay * t);\n' +
                '} else {\n' +
                '    value;\n' +
                '}';

            var layers = comp.selectedLayers;
            var modified = 0, skipped = 0;
            app.beginUndoGroup('PineappleFX: Apply Spring');
            try {
                for (var i = 0; i < layers.length; i++) {
                    var ps = layers[i].selectedProperties;
                    for (var j = 0; j < ps.length; j++) {
                        var p = ps[j];
                        if (!p.canSetExpression) { skipped++; continue; }
                        p.expression = expr;
                        p.expressionEnabled = true;
                        modified++;
                    }
                }
            } finally {
                app.endUndoGroup();
            }
            if (modified === 0) {
                return err(skipped > 0
                    ? 'Selected properties don\'t accept expressions'
                    : 'Select a property to apply the spring to');
            }
            return ok({ modifiedProperties: modified });
        } catch (e) { return err(e); }
    };

    /**
     * Open AE's Graph Editor. Used by Alt+Apply so the user sees the curve
     * land in the timeline panel.
     */
    $.global.pineapplefx_open_graph_editor = function () {
        try {
            // 4707 is the well-known menu command id for "Show Graph Editor" in
            // recent AE versions. findMenuCommandId is fragile across locales,
            // so we try it first and fall back to the literal id.
            var id = 0;
            try { id = app.findMenuCommandId('Show Graph Editor'); } catch (e) {}
            if (!id) {
                try { id = app.findMenuCommandId('Graph Editor'); } catch (e) {}
            }
            if (id) {
                app.executeCommand(id);
                return ok({ via: 'menu' });
            }
            return ok({ via: 'noop', note: 'Graph editor menu id not found' });
        } catch (e) { return err(e); }
    };

    /**
     * Apply an arbitrary expression to a property. Used by the Expressions tab.
     * args: { code: string, target?: 'ADBE Position'|'ADBE Scale'|'ADBE Rotate Z'|'ADBE Opacity' }
     *
     * Targeting:
     *  - When `target` is set, apply to that Transform property on every
     *    selected layer regardless of what's selected on the timeline.
     *  - Otherwise apply to whatever the user has highlighted in selectedProperties.
     */
    $.global.pineapplefx_apply_expression = function (args) {
        try {
            args = args || {};
            var code = String(args.code || '');
            var target = args.target ? String(args.target) : null;
            // preferSelected: honour a property the user selected in the timeline
            // first, and only fall back to `target` when they selected just the
            // layer. This is what lets Apply work on a bare shape/photo layer.
            var preferSelected = args.preferSelected === true;
            if (!code) return err('No expression code provided');
            // Tag so Remove can find + strip PineappleFX expressions later.
            var tagged = '// PineappleFX\n' + code;

            var comp = activeComp();
            if (!comp) return err('No active composition');
            var layers = comp.selectedLayers;
            if (!layers || layers.length === 0) return err('Select at least one layer');

            function setExpr(pr) {
                if (!pr || !pr.canSetExpression) return false;
                pr.expression = tagged;
                pr.expressionEnabled = true;
                return true;
            }

            app.beginUndoGroup('PineappleFX: Apply Expression');
            var modified = 0, skipped = 0;
            try {
                for (var i = 0; i < layers.length; i++) {
                    var layer = layers[i];
                    var didLayer = false;

                    // 1. In auto mode, apply to any property rows the user picked.
                    if (preferSelected) {
                        var ps = layer.selectedProperties;
                        if (ps && ps.length > 0) {
                            for (var j = 0; j < ps.length; j++) {
                                if (setExpr(ps[j])) { modified++; didLayer = true; }
                            }
                        }
                    }

                    // 2. Otherwise (explicit target, or auto with only the layer
                    //    selected) apply to the resolved transform property.
                    if (!didLayer && target) {
                        if (setExpr(transformPropByMatch(layer, target))) {
                            modified++;
                            didLayer = true;
                        }
                    }

                    if (didLayer) pfxTagLayer(layer); else skipped++;
                }
            } finally {
                app.endUndoGroup();
            }

            if (modified === 0) {
                return err('Could not apply to the selection — pick a layer (or a property) and try again');
            }
            return ok({ modifiedProperties: modified, skipped: skipped });
        } catch (e) { return err(e); }
    };

    // -------------------------------------------------------------------
    // Text tab - animator builders.
    // Each builder receives an AVLayer that is known to be a TextLayer and
    // mutates it in place. Helpers below set up the standard "range
    // selector animates Start 0→100 with Apple Standard ease" pattern.
    // -------------------------------------------------------------------

    function applyAppleStandardEase(prop, dim) {
        applyCustomEaseToProp(prop, dim, 0.4, 0, 0.2, 1);
    }

    // Smooth, MONOTONIC ease for transitions. Apple Standard (0.4,0,0.2,1) has
    // x1 (0.4) > x2 (0.2), so its bezier control points are out of order along
    // the time axis — the value curve folds back on itself and overshoots. That
    // made Bounce In / Drop In fly past the target and snap back ("very sharp,
    // flies there and back"), and made the opacity jump straight to 100 instead
    // of fading 0→100. This curve keeps x1 <= x2 so it eases smoothly with no
    // fold, matching the on-panel CSS preview.
    function applyTransitionEase(prop, dim) {
        applyCustomEaseToProp(prop, dim, 0.25, 0.1, 0.4, 1);
    }

    // Apply any cubic-bezier curve to every keyframe on `prop`. Speed is
    // computed from the curve's slope and the per-key value/time delta, so
    // overshoot curves (y1 > 1 or y2 < 0) produce real spring/bounce feels.
    //
    // IMPORTANT: spatial properties (Position, Anchor Point) carry a SINGLE
    // temporal ease no matter how many spatial dimensions the value has. Passing
    // a 2- or 3-element ease array to setTemporalEaseAtKey on Position throws
    // "Value array does not have 1 elements", which previously aborted the whole
    // transition before opacity was applied. We now size the ease array to the
    // property's ease dimension (1 for spatial) and use the non-throwing
    // setEaseRobust so a single property can never abort the build.
    function applyCustomEaseToProp(prop, dim, x1, y1, x2, y2) {
        var total = prop.numKeys;
        if (total < 1) return;
        var valueDim = dim || 1;
        try {
            var dd = dimensionOf(prop, 1);
            if (dd) valueDim = dd;
        } catch (e) {}
        var easeDim = easeDimOf(prop, valueDim);
        var outInf = Math.max(0.1, Math.min(100, x1 * 100));
        var inInf  = Math.max(0.1, Math.min(100, (1 - x2) * 100));
        var slopeOut = (x1 > 0.0001) ? (y1 / x1) : 0;
        var slopeIn  = (x2 < 0.9999) ? ((1 - y2) / (1 - x2)) : 0;
        for (var k = 1; k <= total; k++) {
            var curT = prop.keyTime(k);
            var curV = prop.keyValue(k);
            var hasNext = k < total, hasPrev = k > 1;
            var nT = hasNext ? prop.keyTime(k + 1) : 0;
            var nV = hasNext ? prop.keyValue(k + 1) : null;
            var pT = hasPrev ? prop.keyTime(k - 1) : 0;
            var pV = hasPrev ? prop.keyValue(k - 1) : null;
            var inEase = [], outEase = [];
            for (var d = 0; d < easeDim; d++) {
                var inSpeed = 0, outSpeed = 0;
                if (hasNext && slopeOut !== 0) {
                    var dOut = scalarDelta(curV, nV, easeDim, d, valueDim);
                    var dt = nT - curT;
                    if (dt > 0) outSpeed = slopeOut * dOut / dt;
                }
                if (hasPrev && slopeIn !== 0) {
                    var dIn = scalarDelta(pV, curV, easeDim, d, valueDim);
                    var dt2 = curT - pT;
                    if (dt2 > 0) inSpeed = slopeIn * dIn / dt2;
                }
                inEase.push(new KeyframeEase(capSpeed(inSpeed), inInf));
                outEase.push(new KeyframeEase(capSpeed(outSpeed), outInf));
            }
            setEaseRobust(prop, k, inEase, outEase, valueDim);
        }
    }

    function makeAnimator(textLayer, name, basedOn, smoothness) {
        var animators = textLayer.property('ADBE Text Properties')
                                 .property('ADBE Text Animators');
        var anim = animators.addProperty('ADBE Text Animator');
        anim.name = name;
        // Modern AE no longer auto-creates Range Selector 1 when an animator
        // is added - we need to add it explicitly. Fall back to the existing
        // selector if there is one.
        var selectors = anim.property('ADBE Text Selectors');
        var sel;
        if (selectors.numProperties > 0) {
            sel = selectors.property(1);
        } else {
            sel = selectors.addProperty('ADBE Text Selector');
        }
        var advanced = sel.property('ADBE Text Range Advanced');
        try { advanced.property('ADBE Text Range Type2').setValue(basedOn); } catch (e) {}
        try { advanced.property('ADBE Text Range Smoothness').setValue(smoothness); } catch (e) {}
        return { anim: anim, selector: sel };
    }

    // For WHOLE-TEXT presets we want animator properties to apply uniformly
    // to every character. With ANY selector present, AE modulates per-char
    // selection amount (and on some AE versions the default Shape ramps the
    // amount across the range, giving an unintended per-letter feel even
    // when Start=0, End=100). Without a selector at all, the animator value
    // is applied at 100% to every char - identical motion across the whole
    // text, matching the CSS preview.
    function makeAnimatorNoSelector(textLayer, name) {
        var animators = textLayer.property('ADBE Text Properties')
                                 .property('ADBE Text Animators');
        var anim = animators.addProperty('ADBE Text Animator');
        anim.name = name;
        // Strip any auto-created selector (no-op on modern AE; safety on
        // older versions where one is created implicitly).
        var selectors = anim.property('ADBE Text Selectors');
        while (selectors.numProperties > 0) {
            try { selectors.property(1).remove(); } catch (e) { break; }
        }
        return anim;
    }

    function animateSelectorStart(selector, t0, duration) {
        var start = selector.property('ADBE Text Percent Start');
        start.setValueAtTime(t0, 0);
        start.setValueAtTime(t0 + duration, 100);
        applyAppleStandardEase(start, 1);
        return start;
    }

    // Set Range Selector shape. Match name varies by AE version - try both.
    // Values: 1=Square, 2=Ramp Up, 3=Ramp Down, 4=Triangle, 5=Round, 6=Smooth.
    // Wan presets use 2 (Ramp Up) for smooth per-character cascades.
    function setSelectorShape(selector, shape) {
        try {
            var advanced = selector.property('ADBE Text Range Advanced');
            try { advanced.property('ADBE Text Range Shape').setValue(shape); }
            catch (e) {
                try { advanced.property('ADBE Text Range Shape2').setValue(shape); } catch (e2) {}
            }
        } catch (e) {}
    }

    function addAnimatorProp(anim, matchName, value) {
        var props = anim.property('ADBE Text Animator Properties');
        var p = props.addProperty(matchName);
        if (value !== undefined) p.setValue(value);
        return p;
    }

    // Apple Standard temporal ease for ANIMATOR properties. AE's ease array
    // length depends on the property:
    //   - Spatial (Position 3D)     → 1-element ease
    //   - Non-spatial 1D (Opacity)  → 1-element ease
    //   - Non-spatial 2D (Blur)     → 2-element ease
    //   - Non-spatial 3D (Scale 3D) → handled by 1-element or 3-element
    // We probe propertyValueType: spatial → 1, otherwise → value.length.
    // Apple Standard cubic-bezier(0.4, 0, 0.2, 1) has zero tangent slopes at
    // both endpoints → speed=0 at every key, only influence varies (40/80).
    function applyAppleEaseAnimator(prop) {
        var sample = prop.value;
        var valueDim = (sample instanceof Array) ? sample.length : 1;
        var isSpatial = false;
        try {
            var pvt = prop.propertyValueType;
            isSpatial = (pvt === PropertyValueType.TwoD_SPATIAL ||
                         pvt === PropertyValueType.ThreeD_SPATIAL);
        } catch (e) {}
        var easeDim = isSpatial ? 1 : valueDim;

        var outInf = 40, inInf = 80;
        var total = prop.numKeys;
        for (var k = 1; k <= total; k++) {
            var inEase = [], outEase = [];
            for (var d = 0; d < easeDim; d++) {
                inEase.push(new KeyframeEase(0, inInf));
                outEase.push(new KeyframeEase(0, outInf));
            }
            prop.setInterpolationTypeAtKey(
                k,
                KeyframeInterpolationType.BEZIER,
                KeyframeInterpolationType.BEZIER
            );
            try {
                prop.setTemporalEaseAtKey(k, inEase, outEase);
            } catch (e1) {
                // Fall back: AE rejected our dim guess. Try the other one.
                var fallbackDim = (easeDim === 1) ? valueDim : 1;
                if (fallbackDim !== easeDim) {
                    var inF = [], outF = [];
                    for (var d2 = 0; d2 < fallbackDim; d2++) {
                        inF.push(new KeyframeEase(0, inInf));
                        outF.push(new KeyframeEase(0, outInf));
                    }
                    try { prop.setTemporalEaseAtKey(k, inF, outF); } catch (e2) {}
                }
            }
        }
    }

    // Anchor Point Grouping controls whether per-character animations rotate
    // and scale around each character's own anchor (per-char feel) or around
    // a single layer-wide anchor (whole-text feel).
    //   1 = Character, 2 = Word, 3 = Line, 4 = All
    // Whole-text presets need 4 (so Scale doesn't blow each letter up around
    // its own center); per-char presets need 1.
    function setAnchorPointGrouping(textLayer, mode) {
        try {
            var more = textLayer.property('ADBE Text Properties')
                                .property('ADBE Text More Options');
            // Match name varies by AE version - try both.
            var grouping = null;
            try { grouping = more.property('ADBE Text Anchor Point Option'); } catch (e) {}
            if (!grouping) {
                try { grouping = more.property('ADBE Text Anchor Point Grouping'); } catch (e) {}
            }
            if (grouping) grouping.setValue(mode);
        } catch (e) {}
    }

    // Add an animator property and keyframe its VALUE from start to end over
    // `duration`, Apple Standard ease. Use this for whole-text animations:
    // selector stays at full range (Start=0, End=100, all chars selected at
    // 100%), but the animator value itself moves over time, so every char
    // gets the same animated value simultaneously. This is what makes the
    // motion look like the CSS preview (uniform), rather than a left-to-right
    // selector sweep (sequential per-character).
    function addAnimatorPropKeyframed(anim, matchName, t0, startVal, endVal, duration) {
        var props = anim.property('ADBE Text Animator Properties');
        var p = props.addProperty(matchName);
        p.setValueAtTime(t0, startVal);
        p.setValueAtTime(t0 + duration, endVal);
        applyAppleEaseAnimator(p);
        return p;
    }

    function getSourceText(textLayer) {
        try {
            return textLayer.property('ADBE Text Properties')
                            .property('ADBE Text Document');
        } catch (e) { return null; }
    }

    function readSourceText(textLayer) {
        var prop = getSourceText(textLayer);
        if (!prop) return '';
        try { return prop.value.text || ''; } catch (e) { return ''; }
    }

    function countWords(text) {
        if (!text) return 1;
        var parts = String(text).split(/\s+/);
        var c = 0;
        for (var i = 0; i < parts.length; i++) if (parts[i].length > 0) c++;
        return Math.max(1, c);
    }

    // -----------------------------------------------------------------------------
    // 1. Cubic-bezier sampler (string-embedded into every expression below).
    //
    // This is byte-for-byte the same Newton-Raphson sampler used in
    // TextPreview.tsx → cubicBezier(). Sampling the same curve with the same
    // algorithm at the same time t is the entire trick - both panel and AE
    // produce identical y values, so animations look identical.
    //
    // Clamps in the OUTPUT range, mimicking CSS `animation-fill-mode: both`:
    //   t <= 0 → returns 0 (start state)
    //   t >= 1 → returns 1 (settled state)
    // -----------------------------------------------------------------------------



    // -----------------------------------------------------------------------------
    // 2. Per-character animator helpers  (reference-matched mechanics).
    //
    // How the reference "Wan Apple" presets actually work (verified by
    // unpacking the .ffx files the user supplied):
    //   - The expression sits DIRECTLY on the animator property (Scale 3D,
    //     Position 3D, Rotation, Blur, Opacity), NOT on a selector amount.
    //   - `textIndex` IS available to that expression because the animator
    //     also contains an (empty) Expression Selector. The selector itself
    //     contributes no motion; it only brings textIndex/textTotal into scope.
    //   - The motion is a DAMPED SPRING (decaying sine), not a cubic-bezier.
    //     That is what gives the lively multi-oscillation bounce. cubic-bezier
    //     can only do a single ~10% overshoot, which is why the previous build
    //     felt flat.
    //   - Per-character delay: retard = textIndex * step  (seconds).
    //
    // The animator-property expression model means each property's expression
    // returns the FINAL on-screen value for that character at the current time
    // (relative to its own delayed start). Opacity returns 0..100, Scale a
    // [x,y,z] %, Position an [x,y,z] px offset added by the animator, etc.
    //
    // To make per-character `scale` grow from the glyph CENTER (not its
    // baseline), Anchor Point grouping = Characters with centre alignment is
    // set on the text layer's More Options. Without it AE scales each glyph
    // around the line baseline → letters appear to grow "from below", which
    // was the Letter Pop complaint.
    // -----------------------------------------------------------------------------

    // -----------------------------------------------------------------------------
    // 2. Expression-Selector helpers (reverse-engineered from the Wan Apple
    //    reference .ffx presets the user supplied).
    //
    // The references DON'T use cubic-bezier. They use a DAMPED SPRING on a Text
    // Expression Selector's Amount:
    //
    //     retard = textIndex * stepPerChar;            // per-glyph delay
    //     t      = time - inPoint - retard;
    //     if (t < dur)  amount = linear(t,0,dur,100,0) // fast slide in
    //     else          amount = decayingSine(...)      // overshoot + settle
    //
    // Amount 100 = char fully at its hidden/start value; amount 0 = char at base.
    // The decaying sine drives amount slightly negative, so the property pushes
    // PAST its base (scale > 100, position above baseline, etc.) and rings back
    // to rest. That overshoot IS the Apple/Wan bounce. cubic-bezier can't make
    // it, which is why the previous build felt flat.
    // -----------------------------------------------------------------------------

    // -----------------------------------------------------------------------------
    // 2. Wan-accurate text engine.
    //
    // Reverse-engineered DIRECTLY from the user's reference .ffx files. Two facts
    // those presets establish:
    //
    //   (1) The bounce is a DAMPED COSINE, not a cubic-bezier:
    //         offset = amp * Math.exp(-decay * t) * Math.cos(freq * Math.PI * t)
    //       It starts at +amp, sails through zero, overshoots to the far side,
    //       and rings back — multiple visible bounces. (Reference:
    //       wan_apple_bounce_opacity___blur, wan_apple_word_bounce.)
    //
    //   (2) The expressions live ON THE ANIMATOR PROPERTIES (Position/Scale/Blur/
    //       Rotation), with an EMPTY Expression Selector present only so that
    //       `textIndex` is in scope. Per-glyph stagger = delay * textIndex.
    //
    // We replicate that exactly. Opacity uses ease() like the reference fade.
    // -----------------------------------------------------------------------------

    // -----------------------------------------------------------------------------
    // 2. RANGE-SELECTOR text engine — structurally identical to the user's Wan
    //    reference .ffx presets.
    //
    // The references DON'T use expressions. Each is one Text Animator with a
    // RANGE SELECTOR whose Offset is keyframed from -100% to +100%, plus:
    //   Based On = Characters, Shape = Ramp Up, Ease High = <negative → bounce>,
    //   Ease Low = 100, and animator PROPERTIES that hold the hidden/start state
    //   (Position [0,offset], Opacity 0, Scale [from], Blur [b,b], Rotation a).
    //
    // As Offset sweeps -100→+100 the selector passes over each glyph in turn, so
    // each character animates from its hidden value to base, one after another.
    // A NEGATIVE Ease High makes the selection ramp overshoot, which is what
    // produces the springy "bounce" in the Wan presets. We expose that as the
    // bounce strength. No expressions, no textIndex — exactly the reference
    // structure, so what applies in AE is what the user already validated.
    // -----------------------------------------------------------------------------

    // -----------------------------------------------------------------------------
    // 2. Text engine v6 — two mechanisms, both taken verbatim from the user's
    //    reference .ffx files:
    //
    //   (A) RANGE SELECTOR  (wan_apple_slide_up, wan_apple_text_animtion_1):
    //       Range Selector, Percent Offset keyframed -100→+100 (LINEAR), with
    //       Based On / Shape / Ease High / Ease Low; animator props hold the
    //       hidden state. Clean slide / stagger entrances.
    //
    //   (B) DAMPED-SPRING EXPRESSION  (wan_apple_word_bounce, character_bounce,
    //       bounce_opacity_blur): an EMPTY Expression Selector (Amount 100) puts
    //       textIndex in scope; expressions on the animator PROPERTIES ring with
    //       a damped cosine — the only thing that gives the real overshoot. Delay
    //       per glyph uses thisComp.frameDuration, so timing follows the comp fps
    //       automatically (no hard-coded fps).
    //
    // The single "Ease High" slider (0..-20) maps to spring strength: 0 = no
    // overshoot, -20 = lively bounce, by translating to the reference freq/decay.
    // -----------------------------------------------------------------------------

    // Map Ease High (0..-20) → spring {freq, decay}. 0 = critically damped.
    function springParams(easeHigh) {
        var k = Math.max(0, Math.min(20, -(+easeHigh || 0))) / 20; // 0..1
        return { freq: (1.1 + k * 2.4), decay: (12 - k * 6.5) };   // freq 1.1..3.5, decay 12..5.5
    }

    // clamp Ease High UI value to 0..-20 (negative). fallback if undefined.
    function clampEaseHigh(v, fallback) {
        var n = (v === undefined || v === null || isNaN(+v)) ? fallback : +v;
        if (n > 0) n = -n;          // tolerate positive entry
        if (n < -20) n = -20;
        if (n > 0) n = 0;
        return n;
    }

    // Anchor grouping with pivot at glyph BOTTOM (for Rotate In bottom pivot).
    function setAnchorGroupingBottom(textLayer, mode) {
        try {
            var more = textLayer.property('ADBE Text Properties')
                                .property('ADBE Text More Options');
            var opt = null;
            try { opt = more.property('ADBE Text Anchor Point Option'); } catch (e) {}
            if (!opt) { try { opt = more.property('ADBE Text Anchor Point Grouping'); } catch (e) {} }
            if (opt) { try { opt.setValue(mode); } catch (e) {} }
            var align = null;
            try { align = more.property('ADBE Text Anchor Point Align'); } catch (e) {}
            if (!align) { try { align = more.property('ADBE Text Group Alignment'); } catch (e) {} }
            if (align) {
                try { align.setValue([0, 50]); } catch (e) {   // +50% → pivot at bottom
                    try { align.setValue([0, 50, 0]); } catch (e2) {}
                }
            }
        } catch (e) {}
    }

    // ---- (A) Range Selector animator ----
    function makeRangeAnimator(textLayer, name, basedOn, duration, easeHigh, easeLow, shape, t0) {
        var animators = textLayer.property('ADBE Text Properties')
                                 .property('ADBE Text Animators');
        var anim = animators.addProperty('ADBE Text Animator');
        anim.name = name;
        var selectors = anim.property('ADBE Text Selectors');
        while (selectors.numProperties > 0) { try { selectors.property(1).remove(); } catch (e) { break; } }
        var sel = selectors.addProperty('ADBE Text Selector');
        try { sel.property('ADBE Text Percent Start').setValue(0); } catch (e) {}
        try { sel.property('ADBE Text Percent End').setValue(100); } catch (e) {}
        var offset = sel.property('ADBE Text Percent Offset');
        try {
            offset.setValueAtTime(t0, -100);
            offset.setValueAtTime(t0 + duration, 100);
            try {
                offset.setInterpolationTypeAtKey(1, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
                offset.setInterpolationTypeAtKey(2, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
            } catch (eK) {}
        } catch (e) {}
        try {
            var adv = sel.property('ADBE Text Range Advanced');
            try { adv.property('ADBE Text Range Type2').setValue(basedOn); } catch (e) {}
            try { adv.property('ADBE Text Range Shape').setValue(shape || 2); } catch (e) {}
            try { adv.property('ADBE Text Levels Max Ease').setValue(easeHigh); } catch (e) {}
            try { adv.property('ADBE Text Levels Min Ease').setValue(easeLow); } catch (e) {}
        } catch (e) {}
        return anim;
    }

    // Expression-Selector animator whose AMOUNT carries the bounce expression
    // (this is the reference word_bounce structure: the bounce lives on the
    // selector Amount, the animator PROPERTY holds the static target value).
    // Returns { anim, sel } so callers set both the Amount expression and the
    // property target. textIndex/textTotal are in scope inside an Amount expr.
    function makeSpringAnimator(textLayer, name) {
        var animators = textLayer.property('ADBE Text Properties')
                                 .property('ADBE Text Animators');
        var anim = animators.addProperty('ADBE Text Animator');
        anim.name = name;
        var selectors = anim.property('ADBE Text Selectors');
        while (selectors.numProperties > 0) { try { selectors.property(1).remove(); } catch (e) { break; } }
        var sel = selectors.addProperty('ADBE Text Expressible Selector');
        return { anim: anim, sel: sel };
    }

    function addAnimatorVal(anim, matchName, value) {
        var props = anim.property('ADBE Text Animator Properties');
        var p = props.addProperty(matchName);
        if (value !== undefined) { try { p.setValue(value); } catch (e) {} }
        return p;
    }

    // Shared header for spring/fade expressions: defines idx, retard, t.
    //   mode: 'char' | 'word' | 'all'
    //   perGlyphFrames: per-glyph delay in FRAMES (× frameDuration → fps-safe)
    function exprHead(mode, perGlyphFrames, wmapLit) {
        var idxLine = (mode === 'word')
            ? 'wmap = ' + wmapLit + ';\nidx = wmap[textIndex - 1]; if (idx == null) idx = 0;\n'
            : (mode === 'all' ? 'idx = 0;\n' : 'idx = textIndex - 1;\n');
        return idxLine +
            'retard = idx * (thisComp.frameDuration * ' + perGlyphFrames + ');\n' +
            't = time - (inPoint + retard);\n';
    }

    // damped-spring factor f: 0 (hidden) → 1 (rest) with overshoot. Built as an
    // expression snippet that assumes `t`, `freq`, `decay`, `dur` exist.
    function springFactorSnippet() {
        return 'lead = dur * 0.15;\n' +
            'if (t <= 0) { f = 0; }\n' +
            'else if (t < lead) { f = 0; }\n' +
            'else { tt = t - lead; f = 1 - Math.exp(-decay*tt)*Math.cos(freq*Math.PI*tt); }\n';
    }

    // Scalar spring property (Opacity handled separately via fade; this is for
    // Rotation/Tracking). startVal → restVal.
    function springScalar(anim, matchName, startVal, restVal, dur, sp, mode, perGlyphFrames, wmapLit) {
        var expr = exprHead(mode, perGlyphFrames, wmapLit) +
            'dur = ' + dur + '; freq = ' + sp.freq.toFixed(4) + '; decay = ' + sp.decay.toFixed(4) + ';\n' +
            springFactorSnippet() +
            '(' + startVal + ') + ((' + restVal + ') - (' + startVal + ')) * f;';
        var p = anim.property('ADBE Text Animator Properties').addProperty(matchName);
        try { p.expression = expr; p.expressionEnabled = true; } catch (e) {}
        return p;
    }

    // Vector spring (Scale/Position/Blur). startArr/restArr are JS arrays.
    // axisYonly=true → spring only Y (e.g. position drop), keep X/Z at rest.
    function springVector(anim, matchName, startArr, restArr, dur, sp, mode, perGlyphFrames, wmapLit, axisYonly) {
        var sa = '[' + startArr.join(',') + ']';
        var ea = '[' + restArr.join(',') + ']';
        var expr = exprHead(mode, perGlyphFrames, wmapLit) +
            'dur = ' + dur + '; freq = ' + sp.freq.toFixed(4) + '; decay = ' + sp.decay.toFixed(4) + ';\n' +
            springFactorSnippet() +
            'sa = ' + sa + '; ea = ' + ea + ';\n';
        if (axisYonly) {
            expr += 'r = ea.slice();\nr[1] = sa[1] + (ea[1]-sa[1])*f;\nr;';
        } else {
            expr += 'r = [];\nfor (i = 0; i < sa.length; i++) { r[i] = sa[i] + (ea[i]-sa[i])*f; }\nr;';
        }
        var p = anim.property('ADBE Text Animator Properties').addProperty(matchName);
        try { p.expression = expr; p.expressionEnabled = true; } catch (e) {}
        return p;
    }

    // Opacity fade synced to spring start.
    function springFade(anim, dur, mode, perGlyphFrames, wmapLit) {
        var expr = exprHead(mode, perGlyphFrames, wmapLit) +
            'ease(t, 0, ' + (dur * 0.4).toFixed(4) + ', 0, 100);';
        var p = anim.property('ADBE Text Animator Properties').addProperty('ADBE Text Opacity');
        try { p.setValue(0); } catch (e) {}
        try { p.expression = expr; p.expressionEnabled = true; } catch (e) {}
        return p;
    }

    function wordMapLiteral(text) {
        var arr = [], wi = -1, prev = true, s = String(text || '');
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i), sp = (c === ' ' || c === '\n' || c === '\t' || c === '\r');
            if (!sp && prev) wi++;
            arr.push(Math.max(0, wi)); prev = sp;
        }
        if (!arr.length) arr.push(0);
        return '[' + arr.join(',') + ']';
    }

    // Per-character LINE index map: each character maps to which line (0-based)
    // it sits on, split on newlines. Used so a cascade can step per line.
    function lineMapLiteral(text) {
        var arr = [], li = 0, s = String(text || '');
        for (var i = 0; i < s.length; i++) {
            arr.push(li);
            if (s.charAt(i) === '\n' || s.charAt(i) === '\r') li++;
        }
        if (!arr.length) arr.push(0);
        return '[' + arr.join(',') + ']';
    }

    function setAnchorGroupingCentered(textLayer, mode) {
        try {
            var more = textLayer.property('ADBE Text Properties')
                                .property('ADBE Text More Options');
            var opt = null;
            try { opt = more.property('ADBE Text Anchor Point Option'); } catch (e) {}
            if (!opt) { try { opt = more.property('ADBE Text Anchor Point Grouping'); } catch (e) {} }
            if (opt) { try { opt.setValue(mode); } catch (e) {} }
            var align = null;
            try { align = more.property('ADBE Text Anchor Point Align'); } catch (e) {}
            if (!align) { try { align = more.property('ADBE Text Group Alignment'); } catch (e) {} }
            if (align) {
                try { align.setValue([0, -50]); } catch (e) {
                    try { align.setValue([0, -50, 0]); } catch (e2) {}
                }
            }
        } catch (e) {}
    }

    // -----------------------------------------------------------------------------
    // 3. Build functions — per the user's per-preset spec.
    // -----------------------------------------------------------------------------

    // -----------------------------------------------------------------------------
    // 3. Text presets — all rebuilt on the reference Range-Selector structure.
    //
    // bounce presets use a negative Ease High (overshoot ramp = spring);
    // clean presets use Ease High 0. Per-character vs per-word is the Range
    // "Based On" setting, exactly like the references.
    // -----------------------------------------------------------------------------

    // -----------------------------------------------------------------------------
    // 3. Text presets — rebuilt on the reference damped-cosine bounce.
    // -----------------------------------------------------------------------------

    // -----------------------------------------------------------------------------
    // 3. Patched build functions (Wan-accurate).
    // -----------------------------------------------------------------------------

    // Remove any animators this plugin previously added to the layer, so that
    // re-applying a preset (or applying a different one) REPLACES the old
    // animation instead of stacking a second animator on top of it. Without
    // this, editing a parameter and clicking Apply again appeared to "do
    // nothing" because the stale animator was still fighting the new one.
    // Only animators whose name starts with "PineappleFX" are touched; the user's
    // own animators are left alone.
    function removePriorPineappleFXAnimators(textLayer) {
        try {
            var animators = textLayer.property('ADBE Text Properties')
                                     .property('ADBE Text Animators');
            for (var i = animators.numProperties; i >= 1; i--) {
                try {
                    var a = animators.property(i);
                    if (a && a.name && a.name.indexOf('PineappleFX') === 0) {
                        a.remove();
                    }
                } catch (e) {}
            }
        } catch (e) {}
    }

    // =========================================================================
    // PineappleFX tagging + one-click Remove.
    //
    // Everything PineappleFX adds is marked so it can be cleanly stripped later:
    //   - text animators + created layers are NAMED "PineappleFX ..."
    //   - expressions carry an "PineappleFX" token (all PineappleFX expressions do)
    //   - the layer's Comment gets an "[PineappleFX]" tag (cheap detection), plus
    //     the exact layer-style matchNames PineappleFX added (built-in style names
    //     are not unique): "[PineappleFX styles=dropShadow,frameFX]".
    // Remove only ever touches PineappleFX-marked things, so a user's own effects,
    // expressions and styles are never disturbed. It also runs in one undo
    // group, so Cmd/Ctrl+Z restores everything.
    // =========================================================================

    function pfxTagLayer(layer) {
        try {
            var c = '';
            try { c = layer.comment || ''; } catch (e0) {}
            if (c.indexOf('[PineappleFX') === -1) {
                layer.comment = c ? (c + ' [PineappleFX]') : '[PineappleFX]';
            }
        } catch (e) {}
    }

    function pfxRecordStyles(layer, added) {
        try {
            if (!added || !added.length) return;
            var c = '';
            try { c = layer.comment || ''; } catch (e0) {}
            var have = [];
            var m = c.match(/\[PineappleFX styles=([^\]]*)\]/);
            if (m && m[1]) have = m[1].split(',');
            for (var i = 0; i < added.length; i++) {
                var dup = false;
                for (var j = 0; j < have.length; j++) if (have[j] === added[i]) dup = true;
                if (!dup && added[i]) have.push(added[i]);
            }
            c = c.replace(/\s*\[PineappleFX styles=[^\]]*\]/, '').replace(/\s*\[PineappleFX\]/, '');
            layer.comment = (c ? c + ' ' : '') + '[PineappleFX styles=' + have.join(',') + ']';
        } catch (e) {}
    }

    // before/after diff so a style builder's freshly-added native effects +
    // layer styles get tagged (their built-in names are not PineappleFX-unique).
    function pfxEffectCounts(layer) {
        var out = {};
        try {
            var fx = layer.property('ADBE Effect Parade');
            if (fx) for (var i = 1; i <= fx.numProperties; i++) {
                try { var nm = fx.property(i).name; out[nm] = (out[nm] || 0) + 1; } catch (e) {}
            }
        } catch (e) {}
        return out;
    }
    function pfxTagNewEffects(layer, before) {
        try {
            var fx = layer.property('ADBE Effect Parade');
            if (!fx) return;
            var seen = {};
            for (var i = 1; i <= fx.numProperties; i++) {
                var e = fx.property(i);
                var nm = e.name;
                seen[nm] = (seen[nm] || 0) + 1;
                if (nm.indexOf('PineappleFX') === 0) continue;
                if (seen[nm] > (before[nm] || 0)) {
                    try { e.name = 'PineappleFX ' + nm; } catch (er) {}
                }
            }
        } catch (e) {}
    }
    function pfxStyleNames(layer) {
        var out = {};
        try {
            var ls = layer.property('ADBE Layer Styles');
            if (ls) for (var i = 1; i <= ls.numProperties; i++) {
                try { out[ls.property(i).matchName] = true; } catch (e) {}
            }
        } catch (e) {}
        return out;
    }
    function pfxTagStyles(layer, before) {
        try {
            var ls = layer.property('ADBE Layer Styles');
            if (!ls) return;
            var added = [];
            for (var i = 1; i <= ls.numProperties; i++) {
                var mn = null;
                try { mn = ls.property(i).matchName; } catch (e) {}
                if (mn && !before[mn] && mn !== 'ADBE Blend Options Group') added.push(mn);
            }
            pfxRecordStyles(layer, added);
        } catch (e) {}
    }

    // Wraps a style/effect builder: tags whatever native effects + layer styles
    // it just added, plus the layer comment, so Remove can strip them.
    function pfxWrapStyleApply(layer, buildFn) {
        var fxBefore = pfxEffectCounts(layer);
        var styBefore = pfxStyleNames(layer);
        buildFn();
        pfxTagNewEffects(layer, fxBefore);
        pfxTagStyles(layer, styBefore);
        pfxTagLayer(layer);
    }

    function pfxLayerHasPineapplefx(layer) {
        try {
            var c = '';
            try { c = layer.comment || ''; } catch (e0) {}
            if (c.indexOf('[PineappleFX') !== -1) return true;
            if (layer.name && layer.name.indexOf('PineappleFX') === 0) return true;
            // Glass-rig layers are parented to the "PineappleFX Controls" null.
            try {
                var par = layer.parent;
                if (par && par.name && par.name.indexOf('PineappleFX Controls') === 0) return true;
            } catch (ep) {}
            try {
                var anims = layer.property('ADBE Text Properties').property('ADBE Text Animators');
                if (anims) for (var i = 1; i <= anims.numProperties; i++) {
                    if (anims.property(i).name.indexOf('PineappleFX') === 0) return true;
                }
            } catch (e1) {}
            try {
                var fx = layer.property('ADBE Effect Parade');
                if (fx) for (var j = 1; j <= fx.numProperties; j++) {
                    if (fx.property(j).name.indexOf('PineappleFX') === 0) return true;
                }
            } catch (e2) {}
        } catch (e) {}
        return false;
    }

    // Recursively clear any PineappleFX expression under a property group / layer.
    function pfxClearExpressions(grp) {
        try {
            for (var i = 1; i <= grp.numProperties; i++) {
                var p;
                try { p = grp.property(i); } catch (ep) { continue; }
                if (p.propertyType === PropertyType.PROPERTY) {
                    try {
                        if (p.canSetExpression && p.expressionEnabled) {
                            var ex = p.expression || '';
                            if (ex.indexOf('PineappleFX') !== -1) { p.expression = ''; p.expressionEnabled = false; }
                        }
                    } catch (e2) {}
                } else {
                    pfxClearExpressions(p);
                }
            }
        } catch (e) {}
    }

    // Strip every PineappleFX artifact from ONE ordinary layer (not an PineappleFX-made
    // layer - those get deleted wholesale by the caller).
    function pfxStripLayer(layer, report) {
        try {
            var anims = layer.property('ADBE Text Properties').property('ADBE Text Animators');
            if (anims) for (var i = anims.numProperties; i >= 1; i--) {
                try { var a = anims.property(i); if (a.name.indexOf('PineappleFX') === 0) { a.remove(); report.animators++; } } catch (e) {}
            }
        } catch (e0) {}
        try {
            var fx = layer.property('ADBE Effect Parade');
            if (fx) for (var j = fx.numProperties; j >= 1; j--) {
                try { var ef = fx.property(j); if (ef.name.indexOf('PineappleFX') === 0) { ef.remove(); report.effects++; } } catch (e) {}
            }
        } catch (e1) {}
        try { pfxClearExpressions(layer); } catch (e2) {}
        try {
            var st = layer.property('ADBE Text Properties').property('ADBE Text Document');
            if (st && st.expressionEnabled) {
                var sx = st.expression || '';
                if (sx.indexOf('PineappleFX') !== -1) { st.expression = ''; st.expressionEnabled = false; }
            }
        } catch (e3) {}
        try {
            var c = ''; try { c = layer.comment || ''; } catch (ec) {}
            var m = c.match(/\[PineappleFX styles=([^\]]*)\]/);
            if (m && m[1]) {
                var names = m[1].split(',');
                var ls = layer.property('ADBE Layer Styles');
                for (var s = 0; s < names.length; s++) {
                    try { var sp = ls.property(names[s]); if (sp) { sp.remove(); report.styles++; } } catch (e) {}
                }
            }
            c = c.replace(/\s*\[PineappleFX styles=[^\]]*\]/, '').replace(/\s*\[PineappleFX\]/, '');
            layer.comment = c;
        } catch (e4) {}
    }

    // Remove all PineappleFX work from the selected layers. Text animations, styles,
    // expressions and layer styles are stripped in place; PineappleFX-created layers
    // (glass rig, liquid-color precomps) and whole glass rigs are deleted.
    $.global.pineapplefx_remove = function () {
        try {
            var comp = activeComp();
            if (!comp) return err('No active composition');
            var layers = comp.selectedLayers;
            if (!layers || layers.length === 0) return err('Select a layer with an PineappleFX preset');

            app.beginUndoGroup('PineappleFX: Remove');
            var report = { animators: 0, effects: 0, styles: 0, deleted: 0, layers: 0 };
            try {
                // Glass rigs: find PineappleFX Controls nulls tied to the selection.
                var nulls = [];
                function pushNull(L) {
                    try {
                        if (L && L.name && L.name.indexOf('PineappleFX Controls') === 0) {
                            for (var z = 0; z < nulls.length; z++) if (nulls[z] === L) return;
                            nulls.push(L);
                        }
                    } catch (e) {}
                }
                for (var i = 0; i < layers.length; i++) {
                    pushNull(layers[i]);
                    try { pushNull(layers[i].parent); } catch (e) {}
                }

                // Strip ordinary layers now (before any deletion invalidates refs).
                for (var s = 0; s < layers.length; s++) {
                    var l = layers[s];
                    var pfxLayer = false;
                    try { pfxLayer = (l.name && l.name.indexOf('PineappleFX') === 0); } catch (e) {}
                    if (pfxLayer) continue; // deleted below
                    pfxStripLayer(l, report);
                    report.layers++;
                }

                // Collect glass rigs (a rig null + its PineappleFX-marked children)
                // plus any other selected PineappleFX-created layer. Collect FIRST
                // while parent links are still intact, delete AFTER - otherwise
                // deleting the null (which sits at the highest index, so a
                // backward walk hits it first) would unparent its pills before
                // they get matched, leaving a broken half-rig. The parent branch
                // is gated on the child being PineappleFX-marked, so a user's own
                // layer merely parented to the Controls null is never deleted.
                var toDelete = [];
                for (var li = comp.numLayers; li >= 1; li--) {
                    var lay = comp.layer(li);
                    var del = false;
                    try { if (lay.name && lay.name.indexOf('PineappleFX') === 0 && isSelected(lay, layers)) del = true; } catch (e) {}
                    if (!del && nulls.length) {
                        var par = null; try { par = lay.parent; } catch (e) {}
                        for (var ni = 0; ni < nulls.length; ni++) {
                            if (lay === nulls[ni]) { del = true; break; }
                            if (par === nulls[ni] && pfxIsMarked(lay)) { del = true; break; }
                        }
                    }
                    if (del) toDelete.push(lay);
                }
                for (var d = 0; d < toDelete.length; d++) {
                    try { toDelete[d].remove(); report.deleted++; } catch (e) {}
                }
            } finally {
                app.endUndoGroup();
            }
            return ok(report);
        } catch (e) { return err(e); }
    };

    function isSelected(layer, sel) {
        for (var i = 0; i < sel.length; i++) if (sel[i] === layer) return true;
        return false;
    }

    // A layer PineappleFX created or touched (name prefix or comment tag). Used to
    // gate glass-rig deletion so we never delete a user's own layer that they
    // merely parented to the Controls null.
    function pfxIsMarked(layer) {
        try {
            if (layer.name && layer.name.indexOf('PineappleFX') === 0) return true;
            var c = ''; try { c = layer.comment || ''; } catch (e0) {}
            if (c.indexOf('[PineappleFX') !== -1) return true;
        } catch (e) {}
        return false;
    }

    // -----------------------------------------------------------------------------
    // 3. Spring expression generator.
    //
    // Builds a damped-spring expression for one scalar (or applied per-axis).
    // Returns a value that travels from `fromV` to `toV` over `dur`, then
    // oscillates around `toV` with decaying amplitude:
    //
    //   phase 1 (t < dur):  linear/eased approach fromV → toV
    //   phase 2 (t >= dur): toV + (slope) * sin(w·τ)/e^(decay·τ)/w   (τ = t-dur)
    //
    // This is the exact form used by the reference "character bounce" ffx.
    // `delayExpr` is a JS expression string giving this item's start delay in
    // seconds (e.g. "textIndex * 0.05" or a word-map lookup).
    //
    // scope: 'char' uses textIndex directly; 'word' looks up wordMap[textIndex-1].
    // dims: 1 → scalar return; 2 → "[v,v]"; 3 → "[v,v,100]" for scale, etc.
    // We assemble per-property in the build functions for clarity instead.
    // -----------------------------------------------------------------------------

    // Returns the shared spring header: defines fromV, toV, t (delayed), and the
    // helper spring(from,to) returning the current spring value for scalars.
    // freq/decay are spring parameters; dur is the initial travel time.
    function springHeader(scope, delaySec, t0, dur, freq, decay, wordMapLit) {
        var head = '';
        if (scope === 'word') {
            head =
                'wm = ' + wordMapLit + ';\n' +
                'wi = wm[textIndex - 1]; if (wi == null) wi = 0;\n' +
                'retard = ' + delaySec + ' * wi;\n';
        } else {
            head = 'retard = ' + delaySec + ' * (textIndex - 1);\n';
        }
        return head +
            'freq = ' + freq + '; decay = ' + decay + '; dur = ' + dur + ';\n' +
            't = time - (' + t0 + ' + retard);\n' +
            'function spring(fromV, toV) {\n' +
            '  if (t <= 0) return fromV;\n' +
            '  if (t < dur) return fromV + (toV - fromV) * (t / dur);\n' +
            '  var amp = (toV - fromV) / dur;\n' +
            '  var w = freq * Math.PI * 2;\n' +
            '  var tau = t - dur;\n' +
            '  return toV + amp * (Math.sin(tau * w) / Math.exp(decay * tau) / w);\n' +
            '}\n';
    }

    // Spring tuned to the reference feel. freq ≈ 3, decay ≈ 8.5 → 2-3 visible,
    // quickly-settling oscillations (the "lively bounce").
    var SPRING_FREQ  = 3;
    var SPRING_DECAY = 8.5;

    // Directional Slide - one preset that covers "slide in by letter / word /
    // line, from any side" (reverse-engineered from the owner's Left Characters
    // + Left Words comps: a Range selector offset -100 -> +100, Ease High -36,
    // hidden state = a Position offset + Opacity 0). `unit` picks Based On,
    // `from` picks which axis/sign the Position offset uses. Raw px (no
    // PFX_DIST_MUL) so the default ~matches the reference's 121 px.
    function buildSlide(textLayer, params) {
        var duration = +params.duration || 1.0;
        var dist = +params.distance || 120;
        var unit = String(params.unit || 'character');
        var from = String(params.from || 'left');
        var basedOn = unit === 'word' ? 3 : (unit === 'line' ? 4 : 1);
        var grp     = unit === 'word' ? 2 : (unit === 'line' ? 3 : 1);
        var pos = (from === 'right')  ? [-dist, 0, 0]
                : (from === 'top')    ? [0, -dist, 0]
                : (from === 'bottom') ? [0, dist, 0]
                :                       [dist, 0, 0]; // left (matches the reference)
        var t0 = textLayer.inPoint;
        setAnchorGroupingCentered(textLayer, grp);
        var anim = makeRangeAnimator(textLayer, 'PineappleFX · Slide', basedOn, duration, -36, 100, 2, t0);
        addAnimatorVal(anim, 'ADBE Text Position 3D', pos);
        addAnimatorVal(anim, 'ADBE Text Opacity', 0);
    }

    // ---- Scale Bounce / Color Scale / Skew Color -----------------------------
    // Reverse-engineered from the owner's "Scale Bounce", "Color Scale" and
    // "Skew Color" comps. Core is a keyframe-overshoot scale expression (the
    // reference "// PineappleFX Bounce" recipe): the animator Scale is keyframed
    // scaleFrom% -> 100% and an expression re-times the interpolation with a
    // damped spring so it overshoots. Everything lives on named "PineappleFX ·"
    // animators so one-click Remove strips it clean.
    function pfxOvershootExpr(freq, decay) {
        return '// PineappleFX\n// PineappleFX Scale Bounce\n' +
            'freq = ' + freq + '; decay = ' + decay + '; n = 0;\n' +
            'if (numKeys > 0) { n = nearestKey(time).index; if (key(n).time > time) n--; }\n' +
            'result = value;\n' +
            'if (n >= 1 && n < numKeys) {\n' +
            '  d = key(n + 1).time - key(n).time;\n' +
            '  if (d > 0) {\n' +
            '    t01 = (time - key(n).time) / d;\n' +
            '    p = 1 - Math.exp(-decay * t01) * Math.cos(freq * t01 * 2 * Math.PI);\n' +
            '    result = key(n).value + (key(n + 1).value - key(n).value) * p;\n' +
            '  }\n' +
            '}\n' +
            'result;';
    }
    // Whole-text-timed scale bounce on a dedicated animator (caller sets the
    // anchor-point grouping: 4 = scale as a whole, 1 = pivot per glyph).
    function addScaleBounceAnimator(textLayer, scaleFrom, duration, freq, decay) {
        var t0 = textLayer.inPoint;
        var anim = makeAnimatorNoSelector(textLayer, 'PineappleFX · Scale Bounce');
        var sc = anim.property('ADBE Text Animator Properties').addProperty('ADBE Text Scale 3D');
        try {
            sc.setValueAtTime(t0, [scaleFrom, scaleFrom, 100]);
            sc.setValueAtTime(t0 + duration, [100, 100, 100]);
            try {
                sc.setInterpolationTypeAtKey(1, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
                sc.setInterpolationTypeAtKey(2, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
            } catch (e) {}
            sc.expression = pfxOvershootExpr(freq, decay);
            sc.expressionEnabled = true;
        } catch (e) {}
    }
    // Persistent fill color via a full-range animator (so Remove reverts it).
    function addFillColorAnimator(textLayer, hex) {
        var c = colorFromAny(hex);
        var rgba = [c[0], c[1], c[2], (c.length > 3 ? c[3] : 1)];
        var anim = makeAnimatorNoSelector(textLayer, 'PineappleFX · Fill');
        addAnimatorVal(anim, 'ADBE Text Fill Color', rgba);
    }

    function buildScaleBounce(textLayer, params) {
        var duration  = +params.duration || 1.6;
        var scaleFrom = isNaN(+params.scaleFrom) ? 0 : +params.scaleFrom;
        setAnchorGroupingCentered(textLayer, 4);
        addScaleBounceAnimator(textLayer, scaleFrom, duration, +params.freq || 1.6, +params.decay || 7);
    }

    function buildColorScale(textLayer, params) {
        var duration  = +params.duration || 1.5;
        var scaleFrom = isNaN(+params.scaleFrom) ? 180 : +params.scaleFrom;
        var blur = (isNaN(+params.blur) ? 21 : +params.blur);
        var t0 = textLayer.inPoint;
        setAnchorGroupingCentered(textLayer, 4);
        if (params.color) addFillColorAnimator(textLayer, params.color);
        addScaleBounceAnimator(textLayer, scaleFrom, duration, 1.6, 7);
        var anim = makeRangeAnimator(textLayer, 'PineappleFX · Color Reveal', 1, duration, 0, 100, 2, t0);
        addAnimatorVal(anim, 'ADBE Text Opacity', 0);
        addAnimatorVal(anim, 'ADBE Text Blur', [blur, blur]);
    }

    function buildSkewColor(textLayer, params) {
        var duration = +params.duration || 0.7;
        var distance = (+params.distance || 150);
        var skew = isNaN(+params.skew) ? 16 : +params.skew;
        var blur = (isNaN(+params.blur) ? 31 : +params.blur);
        var t0 = textLayer.inPoint;
        setAnchorGroupingCentered(textLayer, 1);
        if (params.color) addFillColorAnimator(textLayer, params.color);
        addScaleBounceAnimator(textLayer, 166, (duration + 0.2 > 0.9 ? duration + 0.2 : 0.9), 1.6, 7);
        var anim = makeRangeAnimator(textLayer, 'PineappleFX · Skew Slide', 1, duration, 0, 100, 2, t0);
        addAnimatorVal(anim, 'ADBE Text Position 3D', [0, distance, 0]);
        addAnimatorVal(anim, 'ADBE Text Skew', skew);
        addAnimatorVal(anim, 'ADBE Text Skew Axis', -134);
        addAnimatorVal(anim, 'ADBE Text Blur', [blur, blur]);
        addAnimatorVal(anim, 'ADBE Text Opacity', 0);
    }

    function buildHeroReveal(textLayer, params) {
        var duration  = (+params.duration || 0.8);
        var blur      = (+params.blur || 12) * PFX_BLUR_MUL;
        var scaleFrom = +params.scaleFrom || 60;
        var t0 = textLayer.inPoint;
        setAnchorGroupingCentered(textLayer, 4);
        var anim = makeRangeAnimator(textLayer, 'PineappleFX · Hero Reveal', 4, duration, 0, 100, 2, t0);
        addAnimatorVal(anim, 'ADBE Text Opacity', 0);
        addAnimatorVal(anim, 'ADBE Text Scale 3D', [scaleFrom, scaleFrom, 100]);
        addAnimatorVal(anim, 'ADBE Text Blur', [blur, blur]);
    }


    // Slide Up — now BASED ON WORDS (per user), per-word slide + fade.
    function buildSlideFade(textLayer, params) {
        var duration = +params.duration || 0.9;
        var distance = (+params.distance || 60) * PFX_DIST_MUL;
        var t0 = textLayer.inPoint;
        setAnchorGroupingCentered(textLayer, 2);
        var anim = makeRangeAnimator(textLayer, 'PineappleFX · Slide Up', 3, duration, 0, 100, 2, t0);
        addAnimatorVal(anim, 'ADBE Text Opacity', 0);
        addAnimatorVal(anim, 'ADBE Text Position 3D', [0, distance, 0]);
    }

    // ---- New text presets (independent of existing five) -----------------
    //
    // These are PineappleFX-original implementations. Visually similar to other
    // Apple-aesthetic text packs out there but structurally different - see
    // notes per builder.



    // ---- Word Bounce — per-word scale spring + fast per-word fade. ----------
    function buildWordBounce(textLayer, params) {
        var duration  = +params.duration || 0.8;
        var scaleFrom = +params.scaleFrom || 40;
        var delayF = 3;
        var t0 = textLayer.inPoint;
        var text = readSourceText(textLayer);
        var wmap = wordMapLiteral(text);
        setAnchorGroupingCentered(textLayer, 2);
        // Quick per-word fade synced to each word's bounce start. A small lead-in
        // keeps opacity at 0 for the very first frames so any sub-100 scale (or a
        // 1-frame engine hiccup that could mirror the glyph) is never visible.
        addExprFade(textLayer, Math.min(0.25, duration * 0.35), delayF, 'word', wmap);
        var made = makeSpringAnimator(textLayer, 'PineappleFX · Word Bounce');
        var delta = scaleFrom - 100;
        addAnimatorVal(made.anim, 'ADBE Text Scale 3D', [delta, delta, 0]);
        setBounceAmount(made.sel, 2.5, 6, delayF, duration, 'word', wmap);
    }



    // ---- Burst — per the user's screenshot 2 structure:
    //      WORD baunces (Scale + Position, Based On Words via Amount word-map),
    //      LETTERS only fade + blur (per-character Range Selector cascade). -----
    function buildBurst(textLayer, params) {
        var duration  = +params.duration || 1.0;
        var blur      = (isNaN(+params.blur) ? 50 : +params.blur);
        var scaleFrom = isNaN(+params.scaleFrom) ? 65 : +params.scaleFrom; // 65 → -35 delta (screenshot)
        var offset    = (isNaN(+params.offset) ? 100 : +params.offset);
        var delayF = 3;
        var t0 = textLayer.inPoint;
        var text = readSourceText(textLayer);
        var wmap = wordMapLiteral(text);
        setAnchorGroupingCentered(textLayer, 2); // word grouping

        // Per-letter blur cascade (Based On Characters), Duration-driven — this
        // is purely a reveal-blur and can stay a Range cascade.
        var fb = addBlurOnlyAnimator(textLayer, duration, t0, 1, [blur, blur]);
        fb.name = 'PineappleFX · Burst Blur';

        // Opacity fade must follow the WORD bounce schedule (same delayF/word map)
        // so a word reveals exactly as it starts bouncing — otherwise opacity
        // completes early and fully-visible words hang offset from rest.
        addExprFade(textLayer, Math.min(0.3, duration * 0.4), delayF, 'word', wmap);

        // Per-WORD scale bounce.
        var s = makeSpringAnimator(textLayer, 'PineappleFX · Burst Scale');
        var sdelta = scaleFrom - 100; // 65 → -35
        addAnimatorVal(s.anim, 'ADBE Text Scale 3D', [sdelta, sdelta, 0]);
        setBounceAmount(s.sel, 2.5, 6, delayF, duration, 'word', wmap);

        // Per-WORD position bounce.
        var p = makeSpringAnimator(textLayer, 'PineappleFX · Burst Position');
        addAnimatorVal(p.anim, 'ADBE Text Position 3D', [0, offset, 0]);
        setBounceAmount(p.sel, 2.5, 6, delayF, duration, 'word', wmap);
    }

    // ---- Apple-flavored extras -------------------------------------------

    // Convert a hex string '#rrggbb' to AE color triplet [0..1, 0..1, 0..1].
    // Falls back to the legacy color names if a name slipped through.
    function colorFromAny(raw) {
        var LEGACY = {
            'purple': [0.66, 0.33, 0.97], 'blue':   [0.23, 0.51, 0.96],
            'pink':   [0.93, 0.28, 0.60], 'green':  [0.13, 0.77, 0.37],
            'orange': [0.97, 0.45, 0.09], 'white':  [1, 1, 1]
        };
        if (raw == null) return LEGACY.purple;
        var s = String(raw);
        if (LEGACY[s]) return LEGACY[s];
        s = s.replace('#', '');
        if (s.length !== 6) return LEGACY.purple;
        var r = parseInt(s.substring(0, 2), 16) / 255;
        var g = parseInt(s.substring(2, 4), 16) / 255;
        var b = parseInt(s.substring(4, 6), 16) / 255;
        if (isNaN(r) || isNaN(g) || isNaN(b)) return LEGACY.purple;
        return [r, g, b];
    }

    // ---- Typewriter — adapted 1:1 from the user's working .ffx. A single
    //      Range Selector animator: Percent Start keyframes 0→100, Type2=1
    //      (Characters), Shape=1 (Square, hard per-char edge), Smoothness 0,
    //      Opacity 0 on the unselected chars. No caret, no second layer, no
    //      expressions — exactly the structure that works. -------------------
    function buildTypewriter(textLayer, params) {
        var duration = +params.duration || 0.8;
        var t0 = textLayer.inPoint;

        var animators = textLayer.property('ADBE Text Properties')
                                 .property('ADBE Text Animators');
        var anim = animators.addProperty('ADBE Text Animator');
        anim.name = 'PineappleFX · Typewriter';

        var selectors = anim.property('ADBE Text Selectors');
        while (selectors.numProperties > 0) { try { selectors.property(1).remove(); } catch (e) { break; } }
        var sel = selectors.addProperty('ADBE Text Selector');

        // Range advanced: Characters, Square shape, smoothness 0.
        try {
            var adv = sel.property('ADBE Text Range Advanced');
            try { adv.property('ADBE Text Range Type2').setValue(1); } catch (e) {}      // Characters
            try { adv.property('ADBE Text Range Shape').setValue(1); } catch (e) {}      // Square
            try { adv.property('ADBE Text Selector Smoothness').setValue(0); } catch (e) {}
        } catch (e) {}

        try { sel.property('ADBE Text Percent End').setValue(100); } catch (e) {}
        try { sel.property('ADBE Text Percent Offset').setValue(0); } catch (e) {}

        // Percent Start: 0 → 100 over duration (this is the reveal).
        var start = sel.property('ADBE Text Percent Start');
        try {
            start.setValueAtTime(t0, 0);
            start.setValueAtTime(t0 + duration, 100);
            for (var k = 1; k <= start.numKeys; k++) {
                start.setInterpolationTypeAtKey(k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
            }
        } catch (e) {}

        // Unselected (not-yet-typed) characters are fully transparent.
        addAnimatorVal(anim, 'ADBE Text Opacity', 0);

        // Anchor Point Option = 4 (per the .ffx) keeps per-char anchoring stable.
        try {
            textLayer.property('ADBE Text Properties').property('ADBE Text More Options')
                     .property('ADBE Text Anchor Point Option').setValue(4);
        } catch (e) {}
    }

    function buildTypewriterCursor(parentText, duration, glowColor) {
        var comp = parentText.containingComp;
        if (!comp) return;

        // Create cursor as a text layer with the "|" character so it
        // inherits the comp's font metrics naturally.
        var cursor = comp.layers.addText('|');
        cursor.name = 'PineappleFX · Cursor';
        cursor.inPoint = parentText.inPoint;
        cursor.outPoint = parentText.outPoint;

        // Match font/size of the parent text layer.
        try {
            var parentDoc = parentText.text.sourceText.value;
            var cursorDoc = cursor.text.sourceText.value;
            cursorDoc.fontSize = parentDoc.fontSize;
            try { cursorDoc.font = parentDoc.font; } catch (e) {}
            cursorDoc.fillColor = [1, 1, 1];
            cursorDoc.justification = ParagraphJustification.LEFT_JUSTIFY;
            cursor.text.sourceText.setValue(cursorDoc);
        } catch (e) {}

        // Position the cursor at the typing edge: parent layer's
        // sourceRect right-edge at the current typing progress.
        cursor.transform.position.expression =
            'src = thisComp.layer("' + parentText.name + '");\n' +
            'r = src.sourceRectAtTime(time, false);\n' +
            'duration = ' + duration + ';\n' +
            't = Math.min(1, Math.max(0, (time - src.inPoint) / duration));\n' +
            'srcPos = src.transform.position.value;\n' +
            'x = srcPos[0] + r.left + r.width * t;\n' +
            'y = srcPos[1];\n' +
            '[x, y];';

        // Apply Glow effect (ADBE Glo2)
        try {
            var fx = cursor.property('ADBE Effect Parade');
            var glow = fx.addProperty('ADBE Glo2');
            try { glow.property('Glow Threshold').setValue(50); } catch (e) {}
            try { glow.property('Glow Radius').setValue(22); } catch (e) {}
            try { glow.property('Glow Intensity').setValue(2.5); } catch (e) {}
            try { glow.property('Glow Colors').setValue(2); } catch (e) {} // A & B Colors
            try { glow.property('Color A').setValue(glowColor); } catch (e) {}
            try { glow.property('Color B').setValue(glowColor); } catch (e) {}
        } catch (e) {}

        // Blink expression: solid during typing, square-wave blink after.
        cursor.transform.opacity.expression =
            'src = thisComp.layer("' + parentText.name + '");\n' +
            'duration = ' + duration + ';\n' +
            'typed = time > src.inPoint + duration;\n' +
            'typed ? (Math.sin((time - src.inPoint) * 6) > 0 ? 100 : 0) : 100;';
    }


    // Soft Bounce — exact reference (Soft_Bounce_Change): whole text, Position Y
    //   offset = amp*exp(-decay*t)*cos(freq*PI*t), amp 100, freq 4, decay 5.
    function buildSoftBounce(textLayer, params) {
        var amp   = (+params.distance || 100) * PFX_DIST_MUL;
        var freq  = +params.freq || 4;
        var decay = +params.decay || 5;
        var fadeDur = (+params.duration || 0.4);
        var mode = String(params.mode || 'all');
        var t0 = textLayer.inPoint;
        setAnchorGroupingCentered(textLayer, mode === 'all' ? 4 : (mode === 'word' ? 2 : (mode === 'line' ? 3 : 1)));

        if (mode === 'all') {
            // Whole text together — expression on the properties directly.
            var made0 = makeSpringAnimator(textLayer, 'PineappleFX · Soft Bounce');
            var anim0 = made0.anim;
            var fexpr0 = 't = time - ' + t0 + ';\nease(t, 0, ' + fadeDur.toFixed(4) + ', 0, 100);';
            var fp0 = anim0.property('ADBE Text Animator Properties').addProperty('ADBE Text Opacity');
            try { fp0.setValue(0); } catch (e) {}
            try { fp0.expression = fexpr0; fp0.expressionEnabled = true; } catch (e) {}
            var pexpr0 =
                'amp = ' + amp + '; freq = ' + freq + '; decay = ' + decay + ';\n' +
                't = Math.max(time - ' + t0 + ', 0);\n' +
                'offset = amp * Math.exp(-decay * t) * Math.cos(freq * Math.PI * t);\n' +
                '[0, offset, 0];';
            var pp0 = anim0.property('ADBE Text Animator Properties').addProperty('ADBE Text Position 3D');
            try { pp0.expression = pexpr0; pp0.expressionEnabled = true; } catch (e) {}
            return;
        }

        // Per word / line / character — cascade by a per-glyph group index `gi`,
        // each group delayed by `delayF` frames. Position bounce + synced fade
        // both run as expressions keyed off the SAME gi*delay, so opacity always
        // tracks the motion (no desync).
        var text = readSourceText(textLayer);
        var delayF = 2.5;
        var giExpr;
        if (mode === 'word')      giExpr = 'wm = ' + wordMapLiteral(text) + ';\ngi = wm[textIndex - 1]; if (gi == null) gi = 0;\n';
        else if (mode === 'line') giExpr = 'lm = ' + lineMapLiteral(text) + ';\ngi = lm[textIndex - 1]; if (gi == null) gi = 0;\n';
        else                      giExpr = 'gi = textIndex - 1;\n';

        var animators = textLayer.property('ADBE Text Properties').property('ADBE Text Animators');

        // Position bounce animator (expression selector amount = 100 so it acts
        // per-character; the per-group delay lives in the property expression).
        var anim = animators.addProperty('ADBE Text Animator');
        anim.name = 'PineappleFX · Soft Bounce';
        var sels = anim.property('ADBE Text Selectors');
        while (sels.numProperties > 0) { try { sels.property(1).remove(); } catch (e) { break; } }
        var esel = sels.addProperty('ADBE Text Expressible Selector');
        try { esel.property('ADBE Text Expressible Amount').setValue(100); } catch (e) {}

        var pexpr =
            giExpr +
            'amp = ' + amp + '; freq = ' + freq + '; decay = ' + decay + ';\n' +
            'd = gi * thisComp.frameDuration * ' + delayF + ';\n' +
            't = Math.max(time - inPoint - d, 0);\n' +
            'offset = amp * Math.exp(-decay * t) * Math.cos(freq * Math.PI * t);\n' +
            '[0, offset, 0];';
        var pp = anim.property('ADBE Text Animator Properties').addProperty('ADBE Text Position 3D');
        try { pp.expression = pexpr; pp.expressionEnabled = true; } catch (e) {}

        // Synced per-group fade.
        addExprFade(textLayer, Math.min(0.3, fadeDur), delayF, (mode === 'character' ? 'char' : mode),
                    (mode === 'word') ? wordMapLiteral(text) : (mode === 'line' ? lineMapLiteral(text) : null));
    }

    // Iris — FIXED. Whole-text scale-down from large + blur + fade, smooth (no
    // jerk). The earlier jerk came from Range Shape 4 (Smooth) on a whole-text
    // selector reversing; use a clean keyframed animator instead.
    function buildIris(textLayer, params) {
        var duration  = +params.duration || 0.8;
        var scaleFrom = +params.scaleFrom || 140;
        var blur      = ((isNaN(+params.blur) ? 16 : +params.blur)) * PFX_BLUR_MUL;
        var t0 = textLayer.inPoint;
        setAnchorGroupingCentered(textLayer, 4);
        var anim = makeAnimatorNoSelector(textLayer, 'PineappleFX · Iris');
        addAnimatorPropKeyframed(anim, 'ADBE Text Opacity', t0, 0, 100, duration);
        addAnimatorPropKeyframed(anim, 'ADBE Text Scale 3D', t0, [scaleFrom, scaleFrom, 100], [100, 100, 100], duration);
        addAnimatorPropKeyframed(anim, 'ADBE Text Blur', t0, [blur, blur], [0, 0], duration);
    }


    function buildNumberCounter(textLayer, params) {
        var fromVal = +params.from || 0;
        var toVal = +params.to;
        if (isNaN(toVal)) toVal = 1000;
        var duration = +params.duration || 2;
        var decimals = Math.max(0, Math.min(6, Math.floor(+params.decimals || 0)));

        var formatExpr = decimals === 0
            ? 'Math.round(v).toString()'
            : 'v.toFixed(' + decimals + ')';

        var expr =
            '// PineappleFX · Number Counter\n' +
            'startVal = ' + fromVal + ';\n' +
            'endVal = ' + toVal + ';\n' +
            'duration = ' + duration + ';\n' +
            't = time - inPoint;\n' +
            'v = ease(t, 0, duration, startVal, endVal);\n' +
            formatExpr + ';';

        var sourceTextProp = getSourceText(textLayer);
        if (!sourceTextProp) throw new Error('Could not access sourceText');
        sourceTextProp.expression = expr;
        sourceTextProp.expressionEnabled = true;
    }

    /**
     * Apply a text preset to every selected text layer.
     * args: { preset: string, params: {...} }
     */
    // ---- Word / Letter Stagger — Duration-driven, no Ease High. ------------
    function buildWordStagger(textLayer, params) {
        var duration = +params.duration || 1.2;
        var offset   = (+params.offset || 100) * PFX_DIST_MUL;
        var blur     = ((isNaN(+params.blur) ? 35 : +params.blur)) * PFX_BLUR_MUL;
        var t0 = textLayer.inPoint;
        setAnchorGroupingCentered(textLayer, 2);
        var anim = makeRangeAnimator(textLayer, 'PineappleFX · Word Stagger', 3, duration, 0, 100, 2, t0);
        addAnimatorVal(anim, 'ADBE Text Opacity', 0);
        addAnimatorVal(anim, 'ADBE Text Position 3D', [0, offset, 0]);
        addAnimatorVal(anim, 'ADBE Text Blur', [blur, blur]);
    }

    function buildLetterStagger(textLayer, params) {
        var duration = +params.duration || 1.0;
        var offset   = (+params.offset || 100) * PFX_DIST_MUL;
        var blur     = ((isNaN(+params.blur) ? 35 : +params.blur)) * PFX_BLUR_MUL;
        var scaleFrom = isNaN(+params.scaleFrom) ? 100 : +params.scaleFrom;
        var t0 = textLayer.inPoint;
        setAnchorGroupingCentered(textLayer, 1);
        var anim = makeRangeAnimator(textLayer, 'PineappleFX · Letter Stagger', 1, duration, 0, 100, 2, t0);
        addAnimatorVal(anim, 'ADBE Text Opacity', 0);
        addAnimatorVal(anim, 'ADBE Text Position 3D', [0, offset, 0]);
        if (scaleFrom !== 100) addAnimatorVal(anim, 'ADBE Text Scale 3D', [scaleFrom, scaleFrom, 100]);
        addAnimatorVal(anim, 'ADBE Text Blur', [blur, blur]);
    }

    // ---- value scale: UI numbers are tuned to look right in the small CSS
    //      preview; on a full comp the same number reads as too small. These
    //      multipliers bring the applied AE value up to match the preview's
    //      visual weight (e.g. blur 35 in preview → ~80 in AE).
    var PFX_BLUR_MUL = 2.3;
    var PFX_DIST_MUL = 1.8;
    var PFX_SCALE_MUL = 1.0; // scale is already a percentage; keep 1:1


    // ---- Bounce Up / Scale / Rotate (per-character) — Duration-driven. ------
    function buildBounceUp(textLayer, params) {
        var amp   = (+params.amp || 70) * PFX_DIST_MUL;
        var duration = +params.duration || 0.8;
        var delayF = +params.delayFrames || 1.8;
        var t0 = textLayer.inPoint;
        setAnchorGroupingCentered(textLayer, 1);
        // Fade must share the motion's per-glyph delay (delayF) so each glyph
        // reveals exactly as it starts bouncing — a Range-cascade fade keyed to
        // `duration` instead drifts out of step and leaves revealed glyphs
        // hanging away from rest. Reveal window scaled to the per-glyph cadence.
        addExprFade(textLayer, Math.min(0.3, duration * 0.45), delayF, 'char', null);
        var made = makeSpringAnimator(textLayer, 'PineappleFX · Bounce Up');
        addAnimatorVal(made.anim, 'ADBE Text Position 3D', [0, amp, 0]);
        setBounceAmount(made.sel, +params.freq || 2.5, +params.decay || 6, delayF, duration, 'char', null);
    }


    function buildBounceRotate(textLayer, params) {
        var amp   = +params.amp || 35;
        var duration = +params.duration || 0.8;
        var delayF = +params.delayFrames || 1.8;
        var t0 = textLayer.inPoint;
        setAnchorGroupingBottom(textLayer, 1);
        addExprFade(textLayer, Math.min(0.3, duration * 0.45), delayF, 'char', null);
        var made = makeSpringAnimator(textLayer, 'PineappleFX · Bounce Rotate');
        addAnimatorVal(made.anim, 'ADBE Text Rotation', amp);
        setBounceAmount(made.sel, +params.freq || 2.5, +params.decay || 6, delayF, duration, 'char', null);
    }



    // Bounce Amount expression. `mode`: 'char' (per-character) or 'word'
    // (per-word via a word map). `duration` SCALES the spring so Duration
    // actually changes how long the bounce takes: bigger Duration → slower,
    // lower freq/decay; smaller → snappier. baseFreq/baseDecay are the feel at
    // duration≈0.8s (the reference).
    function setBounceAmount(sel, baseFreq, baseDecay, delayFrames, duration, mode, wmapLit) {
        // Scale freq/decay inversely with duration so the whole ring fits the
        // chosen Duration. ref tuned at 0.8s.
        var k = 0.8 / Math.max(0.15, duration);
        var freq  = (baseFreq  * k).toFixed(4);
        var decay = (baseDecay * k).toFixed(4);
        var idx = (mode === 'word')
            ? 'wm = ' + wmapLit + ';\ngi = wm[textIndex - 1]; if (gi == null) gi = 0;\n'
            : 'gi = textIndex - 1;\n';
        var expr =
            idx +
            'delay = thisComp.frameDuration * ' + delayFrames + ';\n' +
            'charDelay = gi * delay;\n' +
            't = Math.max(0, time - inPoint - charDelay);\n' +
            'bounce = Math.exp(-' + decay + ' * t) * Math.cos(' + freq + ' * 2 * Math.PI * t);\n' +
            'a = 100 * bounce;\n' +
            '// two-sided clamp: cap the high side, and floor the low side above\n' +
            '// -100 so a Scale animator amount can never cross 0 (which would mirror glyphs)\n' +
            '(a > 150) ? 150 : ((a < -95) ? -95 : a);';
        try {
            var amt = sel.property('ADBE Text Expressible Amount');
            amt.expression = expr; amt.expressionEnabled = true;
        } catch (e) {}
    }

    // Blur-only cascade (no opacity) — same Range mechanics as addFadeAnimator
    // but carries a Blur value instead of Opacity, used where opacity is handled
    // separately by a synced expression fade (e.g. Burst).
    function addBlurOnlyAnimator(textLayer, durationSec, t0, basedOn, blurVal) {
        var animators = textLayer.property('ADBE Text Properties')
                                 .property('ADBE Text Animators');
        var anim = animators.addProperty('ADBE Text Animator');
        anim.name = 'PineappleFX · Blur';
        var selectors = anim.property('ADBE Text Selectors');
        while (selectors.numProperties > 0) { try { selectors.property(1).remove(); } catch (e) { break; } }
        var sel = selectors.addProperty('ADBE Text Selector');
        try { sel.property('ADBE Text Percent Start').setValue(0); } catch (e) {}
        try { sel.property('ADBE Text Percent End').setValue(100); } catch (e) {}
        var offset = sel.property('ADBE Text Percent Offset');
        try {
            offset.setValueAtTime(t0, -100);
            offset.setValueAtTime(t0 + durationSec, 100);
            offset.setInterpolationTypeAtKey(1, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
            offset.setInterpolationTypeAtKey(2, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
        } catch (e) {}
        try {
            var adv = sel.property('ADBE Text Range Advanced');
            adv.property('ADBE Text Range Type2').setValue(basedOn || 1);
            adv.property('ADBE Text Range Shape').setValue(2);
        } catch (e) {}
        try {
            var bp = anim.property('ADBE Text Animator Properties').addProperty('ADBE Text Blur');
            bp.setValue(blurVal || [0, 0]);
        } catch (e) {}
        return anim;
    }

    // Fade-in animator with selectable Based On (1=Characters, 3=Words). The
    // cascade duration is `durationSec` so Duration actually drives the fade.
    function addFadeAnimator(textLayer, durationSec, t0, basedOn) {
        var animators = textLayer.property('ADBE Text Properties')
                                 .property('ADBE Text Animators');
        var anim = animators.addProperty('ADBE Text Animator');
        anim.name = 'PineappleFX · Fade';
        var selectors = anim.property('ADBE Text Selectors');
        while (selectors.numProperties > 0) { try { selectors.property(1).remove(); } catch (e) { break; } }
        var sel = selectors.addProperty('ADBE Text Selector');
        try { sel.property('ADBE Text Percent Start').setValue(0); } catch (e) {}
        try { sel.property('ADBE Text Percent End').setValue(100); } catch (e) {}
        var offset = sel.property('ADBE Text Percent Offset');
        try {
            offset.setValueAtTime(t0, -100);
            offset.setValueAtTime(t0 + durationSec, 100);
            offset.setInterpolationTypeAtKey(1, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
            offset.setInterpolationTypeAtKey(2, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
        } catch (e) {}
        try {
            var adv = sel.property('ADBE Text Range Advanced');
            adv.property('ADBE Text Range Type2').setValue(basedOn || 1);
            adv.property('ADBE Text Range Shape').setValue(2);
        } catch (e) {}
        var op = anim.property('ADBE Text Animator Properties').addProperty('ADBE Text Opacity');
        try { op.setValue(0); } catch (e) {}
        return anim;
    }

    // hex "#rrggbb" → AE [r,g,b] 0..1
    function hexToRgbArr(hex) {
        try {
            var h = String(hex).replace('#', '');
            if (h.length === 3) h = h.charAt(0)+h.charAt(0)+h.charAt(1)+h.charAt(1)+h.charAt(2)+h.charAt(2);
            var r = parseInt(h.substr(0,2),16)/255;
            var g = parseInt(h.substr(2,2),16)/255;
            var b = parseInt(h.substr(4,2),16)/255;
            if (isNaN(r)||isNaN(g)||isNaN(b)) return [0.66,0.33,0.97];
            return [r,g,b];
        } catch (e) { return [0.66,0.33,0.97]; }
    }


    // Per-word (or per-char) FADE via an Opacity expression that uses the SAME
    // delay as the bounce, with a quick fade so opacity reaches 100 right as the
    // glyph starts moving (fixes "looks like it shrinks from big" — that was the
    // slow Range-cascade fade lagging behind the scale bounce).
    function addExprFade(textLayer, fadeDurSec, delayFrames, mode, wmapLit) {
        var animators = textLayer.property('ADBE Text Properties')
                                 .property('ADBE Text Animators');
        var anim = animators.addProperty('ADBE Text Animator');
        anim.name = 'PineappleFX · Fade';
        var selectors = anim.property('ADBE Text Selectors');
        while (selectors.numProperties > 0) { try { selectors.property(1).remove(); } catch (e) { break; } }
        var sel = selectors.addProperty('ADBE Text Expressible Selector');
        // `mode`: 'word'/'line' use a per-char group map (wmapLit) to step the
        // cascade per group; anything else steps per character.
        var idx = ((mode === 'word' || mode === 'line') && wmapLit)
            ? 'gm = ' + wmapLit + ';\ngi = gm[textIndex - 1]; if (gi == null) gi = 0;\n'
            : 'gi = textIndex - 1;\n';
        var expr =
            idx +
            'delay = thisComp.frameDuration * ' + delayFrames + ';\n' +
            'd = gi * delay;\n' +
            'lead = thisComp.frameDuration * 1;\n' +  // hold hidden 1 frame to avoid first-frame artifacts
            't = time - inPoint - d - lead;\n' +
            '100 - ease(t, 0, ' + fadeDurSec.toFixed(4) + ', 0, 100);';
        try {
            var amt = sel.property('ADBE Text Expressible Amount');
            amt.expression = expr; amt.expressionEnabled = true;
        } catch (e) {}
        var op = anim.property('ADBE Text Animator Properties').addProperty('ADBE Text Opacity');
        try { op.setValue(0); } catch (e) {}  // 0 = target hidden; amount 100→0 reveals
        return anim;
    }


    // =====================================================================
    // In / Out direction.
    //
    // Every entrance builder animates hidden -> rest from the layer inPoint. An
    // "out" is the mirror: a clean rest -> hidden cascade over `duration` ending
    // at the layer outPoint. We reuse the Range-Selector machinery with the
    // offset reversed - the entrance sweeps offset -100 -> +100 (= hidden ->
    // rest), so +100 -> -100 gives rest -> hidden - and the animator holds the
    // SAME "hidden" property values the matching entrance uses, so each preset's
    // exit keeps that preset's character (slide, scale, blur, rotate...).
    // =====================================================================
    function makeRangeAnimatorOut(textLayer, name, basedOn, duration, easeHigh, easeLow, shape, tEnd) {
        var t0 = tEnd - duration;
        var animators = textLayer.property('ADBE Text Properties').property('ADBE Text Animators');
        var anim = animators.addProperty('ADBE Text Animator');
        anim.name = name;
        var selectors = anim.property('ADBE Text Selectors');
        while (selectors.numProperties > 0) { try { selectors.property(1).remove(); } catch (e) { break; } }
        var sel = selectors.addProperty('ADBE Text Selector');
        try { sel.property('ADBE Text Percent Start').setValue(0); } catch (e) {}
        try { sel.property('ADBE Text Percent End').setValue(100); } catch (e) {}
        var offset = sel.property('ADBE Text Percent Offset');
        try {
            offset.setValueAtTime(t0, 100);
            offset.setValueAtTime(t0 + duration, -100);
            try {
                offset.setInterpolationTypeAtKey(1, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
                offset.setInterpolationTypeAtKey(2, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
            } catch (eK) {}
        } catch (e) {}
        try {
            var adv = sel.property('ADBE Text Range Advanced');
            try { adv.property('ADBE Text Range Type2').setValue(basedOn); } catch (e) {}
            try { adv.property('ADBE Text Range Shape').setValue(shape || 2); } catch (e) {}
            try { adv.property('ADBE Text Levels Max Ease').setValue(easeHigh); } catch (e) {}
            try { adv.property('ADBE Text Levels Min Ease').setValue(easeLow); } catch (e) {}
        } catch (e) {}
        return anim;
    }

    // Per-preset exit description: which Range "Based On" (1 char / 3 word /
    // 4 all) and which animator properties carry the hidden-state values.
    function pfxExitSpec(presetId, params) {
        var dist = (+params.distance || 60) * PFX_DIST_MUL;
        var off  = (+params.offset || 100) * PFX_DIST_MUL;
        var blur = ((isNaN(+params.blur) ? 12 : +params.blur)) * PFX_BLUR_MUL;
        var scaleFrom = isNaN(+params.scaleFrom) ? 100 : +params.scaleFrom;
        var amp  = (+params.amp || 70) * PFX_DIST_MUL;
        var ang  = +params.amp || 35;
        function P(mn, val) { return { mn: mn, val: val }; }
        function SF(def) { var s = isNaN(+params.scaleFrom) ? def : +params.scaleFrom; return [s, s, 100]; }
        var OP = P('ADBE Text Opacity', 0);
        switch (presetId) {
            case 'hero-reveal':
                return { name: 'Hero Reveal', basedOn: 4, props: [OP, P('ADBE Text Scale 3D', SF(60)), P('ADBE Text Blur', [blur, blur])] };
            case 'slide-up': case 'slide-fade':
                return { name: 'Slide', basedOn: 3, props: [OP, P('ADBE Text Position 3D', [0, dist, 0])] };
            case 'slide':
                var su = String(params.unit || 'character');
                var sb = su === 'word' ? 3 : (su === 'line' ? 4 : 1);
                var sfr = String(params.from || 'left');
                var sd = +params.distance || 120;
                var sp = (sfr === 'right')  ? [-sd, 0, 0]
                       : (sfr === 'top')    ? [0, -sd, 0]
                       : (sfr === 'bottom') ? [0, sd, 0]
                       :                      [sd, 0, 0];
                return { name: 'Slide', basedOn: sb, props: [OP, P('ADBE Text Position 3D', sp)] };
            case 'scale-bounce':
                return { name: 'Scale Bounce', basedOn: 4, props: [OP, P('ADBE Text Scale 3D', SF(0))] };
            case 'color-scale':
                var cb = (isNaN(+params.blur) ? 21 : +params.blur);
                return { name: 'Color Scale', basedOn: 1, props: [OP, P('ADBE Text Scale 3D', SF(180)), P('ADBE Text Blur', [cb, cb])] };
            case 'skew-color':
                var kb = (isNaN(+params.blur) ? 31 : +params.blur);
                return { name: 'Skew Color', basedOn: 1, props: [OP,
                    P('ADBE Text Position 3D', [0, (+params.distance || 150), 0]),
                    P('ADBE Text Skew', (isNaN(+params.skew) ? 16 : +params.skew)),
                    P('ADBE Text Skew Axis', -134),
                    P('ADBE Text Blur', [kb, kb])] };
            case 'word-stagger':
                return { name: 'Word Stagger', basedOn: 3, props: [OP, P('ADBE Text Position 3D', [0, off, 0]), P('ADBE Text Blur', [blur, blur])] };
            case 'letter-stagger':
                var lp = [OP, P('ADBE Text Position 3D', [0, off, 0]), P('ADBE Text Blur', [blur, blur])];
                if (scaleFrom !== 100) lp.push(P('ADBE Text Scale 3D', [scaleFrom, scaleFrom, 100]));
                return { name: 'Letter Stagger', basedOn: 1, props: lp };
            case 'word-bounce':
                return { name: 'Word Bounce', basedOn: 3, props: [OP, P('ADBE Text Scale 3D', SF(40))] };
            case 'burst':
                return { name: 'Burst', basedOn: 1, props: [OP, P('ADBE Text Position 3D', [0, (+params.offset || 28) * PFX_DIST_MUL, 0]), P('ADBE Text Scale 3D', SF(65)), P('ADBE Text Blur', [((isNaN(+params.blur) ? 10 : +params.blur)) * PFX_BLUR_MUL, ((isNaN(+params.blur) ? 10 : +params.blur)) * PFX_BLUR_MUL])] };
            case 'typewriter':
                return { name: 'Typewriter', basedOn: 1, props: [OP] };
            case 'bounce-up':
                return { name: 'Bounce Up', basedOn: 1, props: [OP, P('ADBE Text Position 3D', [0, amp, 0])] };
            case 'bounce-rotate':
                return { name: 'Bounce Rotate', basedOn: 1, props: [OP, P('ADBE Text Rotation', ang)] };
            case 'soft-bounce':
                var m = params.mode === 'word' ? 3 : (params.mode === 'line' ? 4 : (params.mode === 'character' ? 1 : 4));
                return { name: 'Soft Bounce', basedOn: m, props: [OP, P('ADBE Text Position 3D', [0, (+params.distance || 100) * PFX_DIST_MUL, 0])] };
            case 'iris':
                return { name: 'Iris', basedOn: 4, props: [OP, P('ADBE Text Scale 3D', SF(140)), P('ADBE Text Blur', [((isNaN(+params.blur) ? 16 : +params.blur)) * PFX_BLUR_MUL, ((isNaN(+params.blur) ? 16 : +params.blur)) * PFX_BLUR_MUL])] };
            case 'elastic-in':
                return { name: 'Elastic', basedOn: 1, props: [OP, P('ADBE Text Position 3D', [0, dist, 0]), P('ADBE Text Scale 3D', SF(200))] };
            case 'scramble':
                return { name: 'Scramble', basedOn: 1, props: [OP] };
            case 'fade-chars':
                return { name: 'Fade Chars', basedOn: 1, props: [OP] };
            case 'fade-words':
                return { name: 'Fade Words', basedOn: 3, props: [OP] };
            case 'rise-chars':
                return { name: 'Rise Chars', basedOn: 1, props: [OP, P('ADBE Text Position 3D', [0, (+params.distance || 40) * PFX_DIST_MUL, 0])] };
            case 'drop-chars':
                return { name: 'Drop Chars', basedOn: 1, props: [OP, P('ADBE Text Position 3D', [0, -(+params.distance || 40) * PFX_DIST_MUL, 0])] };
            case 'scale-chars':
                return { name: 'Scale Chars', basedOn: 1, props: [OP, P('ADBE Text Scale 3D', SF(60))] };
            case 'spin-chars':
                return { name: 'Spin Chars', basedOn: 1, props: [OP, P('ADBE Text Rotation', (isNaN(+params.angle) ? 45 : +params.angle))] };
            case 'blur-words':
                var bw = (isNaN(+params.blur) ? 20 : +params.blur) * PFX_BLUR_MUL;
                return { name: 'Blur Words', basedOn: 3, props: [OP, P('ADBE Text Blur', [bw, bw])] };
            default:
                return null; // e.g. number-counter has no meaningful "out"
        }
    }

    function buildTextExit(textLayer, presetId, params) {
        var spec = pfxExitSpec(presetId, params);
        if (!spec) return false;
        var dur = +params.duration || 0.8;
        if (dur <= 0) dur = 0.8;
        var tEnd = textLayer.outPoint;
        var grp = spec.basedOn === 1 ? 1 : (spec.basedOn === 3 ? 2 : 4);
        setAnchorGroupingCentered(textLayer, grp);
        var anim = makeRangeAnimatorOut(textLayer, 'PineappleFX · ' + spec.name + ' Out', spec.basedOn, dur, 0, 0, 2, tEnd);
        for (var i = 0; i < spec.props.length; i++) {
            addAnimatorVal(anim, spec.props[i].mn, spec.props[i].val);
        }
        return true;
    }

    // --- Added text animations (v2.1) — each entrance reuses the same
    //     Range-Selector cascade as Letter Stagger: makeRangeAnimator sweeps
    //     the hidden→rest state held by addAnimatorVal. basedOn: 1=char, 3=word. --
    function buildFadeChars(textLayer, params) {
        var duration = +params.duration || 0.8;
        var t0 = textLayer.inPoint;
        setAnchorGroupingCentered(textLayer, 1);
        var anim = makeRangeAnimator(textLayer, 'PineappleFX · Fade Chars', 1, duration, 0, 100, 2, t0);
        addAnimatorVal(anim, 'ADBE Text Opacity', 0);
    }

    function buildFadeWords(textLayer, params) {
        var duration = +params.duration || 0.9;
        var t0 = textLayer.inPoint;
        setAnchorGroupingCentered(textLayer, 3);
        var anim = makeRangeAnimator(textLayer, 'PineappleFX · Fade Words', 3, duration, 0, 100, 2, t0);
        addAnimatorVal(anim, 'ADBE Text Opacity', 0);
    }

    function buildRiseChars(textLayer, params) {
        var duration = +params.duration || 0.8;
        var dist = (+params.distance || 40) * PFX_DIST_MUL;
        var t0 = textLayer.inPoint;
        setAnchorGroupingCentered(textLayer, 1);
        var anim = makeRangeAnimator(textLayer, 'PineappleFX · Rise Chars', 1, duration, 0, 100, 2, t0);
        addAnimatorVal(anim, 'ADBE Text Opacity', 0);
        addAnimatorVal(anim, 'ADBE Text Position 3D', [0, dist, 0]);
    }

    function buildDropChars(textLayer, params) {
        var duration = +params.duration || 0.8;
        var dist = (+params.distance || 40) * PFX_DIST_MUL;
        var t0 = textLayer.inPoint;
        setAnchorGroupingCentered(textLayer, 1);
        var anim = makeRangeAnimator(textLayer, 'PineappleFX · Drop Chars', 1, duration, 0, 100, 2, t0);
        addAnimatorVal(anim, 'ADBE Text Opacity', 0);
        addAnimatorVal(anim, 'ADBE Text Position 3D', [0, -dist, 0]);
    }

    function buildScaleChars(textLayer, params) {
        var duration = +params.duration || 0.8;
        var sf = isNaN(+params.scaleFrom) ? 60 : +params.scaleFrom;
        var t0 = textLayer.inPoint;
        setAnchorGroupingCentered(textLayer, 1);
        var anim = makeRangeAnimator(textLayer, 'PineappleFX · Scale Chars', 1, duration, 0, 100, 2, t0);
        addAnimatorVal(anim, 'ADBE Text Opacity', 0);
        addAnimatorVal(anim, 'ADBE Text Scale 3D', [sf, sf, 100]);
    }

    function buildSpinChars(textLayer, params) {
        var duration = +params.duration || 0.8;
        var ang = isNaN(+params.angle) ? 45 : +params.angle;
        var t0 = textLayer.inPoint;
        setAnchorGroupingCentered(textLayer, 1);
        var anim = makeRangeAnimator(textLayer, 'PineappleFX · Spin Chars', 1, duration, 0, 100, 2, t0);
        addAnimatorVal(anim, 'ADBE Text Opacity', 0);
        addAnimatorVal(anim, 'ADBE Text Rotation', ang);
    }

    function buildBlurWords(textLayer, params) {
        var duration = +params.duration || 0.9;
        var blur = (isNaN(+params.blur) ? 20 : +params.blur) * PFX_BLUR_MUL;
        var t0 = textLayer.inPoint;
        setAnchorGroupingCentered(textLayer, 3);
        var anim = makeRangeAnimator(textLayer, 'PineappleFX · Blur Words', 3, duration, 0, 100, 2, t0);
        addAnimatorVal(anim, 'ADBE Text Opacity', 0);
        addAnimatorVal(anim, 'ADBE Text Blur', [blur, blur]);
    }

$.global.pineapplefx_apply_text_animation = function (args) {
        try {
            args = args || {};
            var presetId = String(args.preset || '');
            var params = args.params || {};
            if (!presetId) return err('No preset id provided');

            var comp = activeComp();
            if (!comp) return err('No active composition');

            var layers = comp.selectedLayers;
            if (!layers || layers.length === 0) return err('Select at least one text layer');

            var textLayers = [];
            var nonText = 0;
            for (var i = 0; i < layers.length; i++) {
                if (layers[i] instanceof TextLayer) textLayers.push(layers[i]);
                else nonText++;
            }
            if (textLayers.length === 0) return err('Selected layers are not text layers');

            app.beginUndoGroup('PineappleFX: Text - ' + presetId);
            var applied = 0;
            try {
                var dir = (params && String(params.direction) === 'out') ? 'out' : 'in';
                for (var n = 0; n < textLayers.length; n++) {
                    var tl = textLayers[n];
                    removePriorPineappleFXAnimators(tl);
                    var didOut = (dir === 'out') ? buildTextExit(tl, presetId, params) : false;
                    if (!didOut) {
                        if (presetId === 'hero-reveal') buildHeroReveal(tl, params);
                        else if (presetId === 'slide-up' || presetId === 'slide-fade') buildSlideFade(tl, params);
                        else if (presetId === 'slide') buildSlide(tl, params);
                        else if (presetId === 'scale-bounce') buildScaleBounce(tl, params);
                        else if (presetId === 'color-scale') buildColorScale(tl, params);
                        else if (presetId === 'skew-color') buildSkewColor(tl, params);
                        else if (presetId === 'word-stagger') buildWordStagger(tl, params);
                        else if (presetId === 'letter-stagger') buildLetterStagger(tl, params);
                        else if (presetId === 'word-bounce') buildWordBounce(tl, params);
                        else if (presetId === 'burst') buildBurst(tl, params);
                        else if (presetId === 'typewriter') buildTypewriter(tl, params);
                        else if (presetId === 'bounce-up') buildBounceUp(tl, params);
                        else if (presetId === 'bounce-rotate') buildBounceRotate(tl, params);
                        else if (presetId === 'soft-bounce') buildSoftBounce(tl, params);
                        else if (presetId === 'iris') buildIris(tl, params);
                        else if (presetId === 'number-counter') buildNumberCounter(tl, params);
                        else if (presetId === 'elastic-in') buildElasticIn(tl, params);
                        else if (presetId === 'scramble') buildScramble(tl, params);
                        else if (presetId === 'fade-chars') buildFadeChars(tl, params);
                        else if (presetId === 'fade-words') buildFadeWords(tl, params);
                        else if (presetId === 'rise-chars') buildRiseChars(tl, params);
                        else if (presetId === 'drop-chars') buildDropChars(tl, params);
                        else if (presetId === 'scale-chars') buildScaleChars(tl, params);
                        else if (presetId === 'spin-chars') buildSpinChars(tl, params);
                        else if (presetId === 'blur-words') buildBlurWords(tl, params);
                        else throw new Error('Unknown text preset: ' + presetId);
                    }
                    pfxTagLayer(tl);
                    applied++;
                }
            } finally {
                app.endUndoGroup();
            }
            return ok({ applied: applied, skipped: nonText });
        } catch (e) { return err(e); }
    };

    // -------------------------------------------------------------------
    // Glass tab - inserts 4 layers directly into the user's active comp:
    //
    //   1. Glass Body       - visible shape (rounded rect, fill + stroke)
    //   2. Glass Matte      - duplicate rect, eye OFF, alpha matte source
    //   3. Background Blur  - adjustment layer, Fast Box Blur, matted by 2
    //   4. PineappleFX Controls - guide null with Slider effects driving 1-3
    //
    // All four are parented to Controls so the user can drag the entire
    // glass cluster by moving one null. Everything's wrapped in tryRun() so
    // a single bad setValue (which is what bit us in v1) gets logged in the
    // returned `diagnostics` array but doesn't abort the whole insert.
    // -------------------------------------------------------------------

    var CONTROLS_NAME = 'PineappleFX Controls';

    function addSliderEffect(layer, name, value) {
        var effects = layer.property('ADBE Effect Parade');
        var ctrl = effects.addProperty('ADBE Slider Control');
        ctrl.name = name;
        // Property index 1 is "Slider" - locale-safe vs `.property("Slider")`.
        ctrl.property(1).setValue(value);
        return ctrl;
    }

    function ctrlExpr(name) {
        // (1) is the Slider value - locale-independent vs ("Slider").
        return 'thisComp.layer("' + CONTROLS_NAME + '").effect("' + name + '")(1)';
    }

    function addControlsNull(comp, sliders) {
        var nl = comp.layers.addNull(comp.duration);
        nl.name = CONTROLS_NAME;
        nl.guideLayer = true;
        // Anchor the null at comp center - children will pivot around this.
        nl.transform.position.setValue([comp.width / 2, comp.height / 2]);
        for (var i = 0; i < sliders.length; i++) {
            addSliderEffect(nl, sliders[i].name, sliders[i].value);
        }
        return nl;
    }

    // Try multiple color formats - AE versions disagree on 3- vs 4-component
    // arrays for Vector Fill/Stroke Color. Returns true on first success.
    function setColorRobust(prop, r, g, b) {
        try { prop.setValue([r, g, b]); return true; } catch (e1) {}
        try { prop.setValue([r, g, b, 1]); return true; } catch (e2) {}
        return false;
    }

    function tryRun(fn, label, diagnostics) {
        try { fn(); return true; }
        catch (e) {
            if (diagnostics) diagnostics.push(label + ': ' + (e.message || e));
            return false;
        }
    }

    /**
     * Build a Solid layer the size of the comp, with a single rounded-rect
     * mask whose path is driven by an expression off the Controls null.
     * This replaces the shape-layer approach that failed on AE 23+ where
     * `ADBE Vector Rect Roundness` and `ADBE Vector Fill Color` setValue
     * threw "Object is invalid" and left the shape red with sharp corners.
     *
     * Mask shapes work via `createPath(points, in, out, closed)` which is
     * stable across every AE version since CS6.
     */
    function addRoundedSolid(comp, name, fillRgb, diagnostics) {
        var solid = comp.layers.addSolid(
            fillRgb || [1, 1, 1],
            name,
            comp.width,
            comp.height,
            1,
            comp.duration
        );
        var mask;
        tryRun(function() {
            var masks = solid.property('ADBE Mask Parade');
            mask = masks.addProperty('ADBE Mask Atom');
            bindMaskShape(mask, diagnostics);
        }, name + ' mask', diagnostics);
        return { layer: solid, mask: mask };
    }

    function bindMaskShape(mask, diagnostics) {
        tryRun(function() {
            var maskPath = mask.property('ADBE Mask Shape');
            // Build a rounded rectangle path centered in the comp via
            // createPath(). The 0.5523 magic constant is the bezier
            // approximation factor for a quarter circle.
            maskPath.expression =
                'w = ' + ctrlExpr('Width') + ';\n' +
                'h = ' + ctrlExpr('Height') + ';\n' +
                'r = Math.min(' + ctrlExpr('Corner Radius') + ', w / 2, h / 2);\n' +
                'cx = thisComp.width / 2;\n' +
                'cy = thisComp.height / 2;\n' +
                'x1 = cx - w / 2; y1 = cy - h / 2;\n' +
                'x2 = cx + w / 2; y2 = cy + h / 2;\n' +
                'c = r * 0.5523;\n' +
                'createPath(\n' +
                '  [[x1 + r, y1], [x2 - r, y1], [x2, y1 + r], [x2, y2 - r], [x2 - r, y2], [x1 + r, y2], [x1, y2 - r], [x1, y1 + r]],\n' +
                '  [[-c, 0], [0, 0], [0, -c], [0, 0], [c, 0], [0, 0], [0, c], [0, 0]],\n' +
                '  [[0, 0], [c, 0], [0, 0], [0, c], [0, 0], [-c, 0], [0, 0], [0, -c]],\n' +
                '  true\n' +
                ');';
        }, 'bind mask path', diagnostics);
    }

    function addDropShadowEffect(layer, diagnostics) {
        // Drop Shadow as a property-style effect (not Layer Style). Effect
        // properties accept setValue more reliably across versions.
        tryRun(function() {
            var fx = layer.property('ADBE Effect Parade');
            var ds = fx.addProperty('ADBE Drop Shadow');
            try { ds.property(1).setValue([0, 0, 0]); } catch (e) {}    // Shadow Color
            try { ds.property(2).setValue(115); } catch (e) {}           // Opacity (0-255)
            try { ds.property(3).setValue(135); } catch (e) {}           // Direction (deg)
            try { ds.property(4).setValue(10); } catch (e) {}            // Distance
            try { ds.property(5).setValue(28); } catch (e) {}            // Softness
        }, 'drop shadow', diagnostics);
    }

    function addBackgroundBlur(comp, diagnostics) {
        var bg = comp.layers.addSolid([1, 1, 1], 'Background Blur',
                                       comp.width, comp.height, 1, comp.duration);
        bg.adjustmentLayer = true;
        var effect;
        tryRun(function() {
            effect = bg.property('ADBE Effect Parade').addProperty('ADBE Box Blur2');
            effect.property(1).setValue(32);
            try { effect.property(2).setValue(3); } catch (e) {} // Iterations
            try { effect.property(4).setValue(1); } catch (e) {} // Repeat Edge Pixels
            effect.property(1).expression = ctrlExpr('Blur');
        }, 'fast box blur', diagnostics);
        return bg;
    }

    /**
     * Insert a glass cluster (Controls null + Background Blur + Matte + Body)
     * directly into the user's active comp. All visible layers get parented
     * to the Controls null so they move as a single rig.
     *
     * args: { preset: 'frosted-card'|'notification'|'glass-button', params: {...} }
     */
    $.global.pineapplefx_insert_glass = function (args) {
        try {
            args = args || {};
            var presetId = String(args.preset || '');
            var params = args.params || {};
            if (!presetId) return err('No preset id provided');

            var meta = GLASS_META[presetId];
            if (!meta) return err('Unknown glass preset: ' + presetId);

            var comp = activeComp();
            if (!comp) return err('Open or select a composition first');

            app.beginUndoGroup('PineappleFX: ' + meta.label);
            var diagnostics = [];
            var controls = null, blurLayer = null, matte = null, body = null;

            try {
                // 1. Controls null - sliders other layers reference via expr.
                controls = addControlsNull(comp, [
                    { name: 'Width',         value: +params.width        || meta.defaults.width },
                    { name: 'Height',        value: +params.height       || meta.defaults.height },
                    { name: 'Corner Radius', value: +params.radius       || meta.defaults.radius },
                    { name: 'Fill Opacity',  value: +params.fillOpacity  || meta.defaults.fillOpacity },
                    { name: 'Blur',          value: +params.blurAmount   || meta.defaults.blurAmount }
                ]);
                // 2. Background Blur (adjustment, will be matted by Matte below)
                blurLayer = addBackgroundBlur(comp, diagnostics);
                // 3. Glass Matte (alpha source). Solid + rounded mask, eye off.
                matte = addRoundedSolid(comp, 'Glass Matte', [1, 1, 1], diagnostics);
                tryRun(function() { matte.layer.enabled = false; }, 'matte eye off', diagnostics);
                // 4. Glass Body (visible). Solid + rounded mask, white at low opacity,
                //    bound to the Fill Opacity slider, drop shadow effect on top.
                body = addRoundedSolid(comp, 'Glass Body', [1, 1, 1], diagnostics);
                tryRun(function() {
                    body.layer.transform.opacity.expression = ctrlExpr('Fill Opacity');
                }, 'bind body opacity', diagnostics);
                addDropShadowEffect(body.layer, diagnostics);

                // After the four addX() calls (each inserts at top), the
                // layer stack is:
                //   1 = Glass Body
                //   2 = Glass Matte
                //   3 = Background Blur
                //   4 = Controls
                // Track matte (Matte to Blur) needs matte directly above
                // the matted layer; this stack satisfies it.
                tryRun(function() {
                    blurLayer.trackMatteType = TrackMatteType.ALPHA;
                }, 'track matte alpha', diagnostics);

                // Parent matte to body so moving the body slides the
                // matte (and therefore the blur "window") along with it.
                tryRun(function() { matte.layer.parent = body.layer; },
                       'parent matte to body', diagnostics);
            } catch (eFatal) {
                app.endUndoGroup();
                return err('Fatal: ' + (eFatal.message || eFatal) +
                           (diagnostics.length ? ' · before: ' + diagnostics.join(' · ') : ''));
            }
            app.endUndoGroup();

            return ok({
                preset: meta.label,
                layers: 4,
                diagnostics: diagnostics
            });
        } catch (e) { return err(e); }
    };

    // -------------------------------------------------------------------
    // Transitions - bouncy entrance animations applied at the playhead.
    // -------------------------------------------------------------------

    // 3-keyframe spring: start -> overshoot peak -> settle. Apple Standard
    // ease between keys. The "bounce" lives INSIDE the motion — it is one
    // continuous spring with the peak baked in, not a settled animation
    // followed by a separate jiggle.
    //
    // Tuned constants: peak at 60% time, 8% overshoot. Subtle and Apple-y.
    var SPRING_PEAK_T = 0.6;
    var SPRING_PEAK_PERCENT = 0.08;

    function springAtPeak(start, end) {
        // Position in value space the overshoot peak should sit. For Y =
        // start + (end - start) * (1 + SPRING_PEAK_PERCENT).
        var result = [];
        var s = (start instanceof Array) ? start : [start];
        var e = (end instanceof Array) ? end : [end];
        var n = Math.max(s.length, e.length);
        for (var i = 0; i < n; i++) {
            var si = s[i] !== undefined ? s[i] : 0;
            var ei = e[i] !== undefined ? e[i] : 0;
            result.push(ei + (ei - si) * SPRING_PEAK_PERCENT);
        }
        return (start instanceof Array) ? result : result[0];
    }

    // Robust opacity fade-in (0 -> current value). Called FIRST in every
    // transition builder so that even if a later property's ease errors out,
    // the appearance fade is already committed. Self-contained and non-throwing.
    // This is the "appears with a fade" that the panel preview shows.
    function addOpacityFadeIn(layer, t0, fadeDur) {
        try {
            var op = layer.transform.opacity;
            var curOp = 100;
            try { var v = op.value; if (typeof v === 'number' && v > 0) curOp = v; } catch (e) {}
            try {
                if (op.expressionEnabled || (op.expression && op.expression.length)) {
                    op.expression = ''; op.expressionEnabled = false;
                }
            } catch (e) {}
            op.setValueAtTime(t0, 0);
            op.setValueAtTime(t0 + fadeDur, curOp);
            applyTransitionEase(op, 1);
            return true;
        } catch (e) { return false; }
    }

    // Robust opacity fade-out (current value -> 0) over the whole duration.
    function addOpacityFadeOut(layer, t0, dur) {
        try {
            var op = layer.transform.opacity;
            var curOp = 100;
            try { var v = op.value; if (typeof v === 'number' && v > 0) curOp = v; } catch (e) {}
            try {
                if (op.expressionEnabled || (op.expression && op.expression.length)) {
                    op.expression = ''; op.expressionEnabled = false;
                }
            } catch (e) {}
            op.setValueAtTime(t0, curOp);
            op.setValueAtTime(t0 + dur, 0);
            applyTransitionEase(op, 1);
            return true;
        } catch (e) { return false; }
    }

    // Natural bounce ease for a multi-keyframe spatial drop. The monotonic
    // transition ease decelerates to a FULL STOP at every keyframe, so a 6-key
    // bounce stutters (stop-go-stop-go) and feels sharp. Real bounces instead
    // pass through the ground contacts with continuous velocity and only reach
    // zero velocity at the apexes (and the final rest). We classify each key by
    // the shape of its neighbours and set the temporal ease accordingly:
    //   start  -> leave at 0 speed (gravity accelerates the fall)
    //   apex   -> 0 speed both sides (smooth, brief hang at the top)
    //   ground -> continuous velocity (no stop) so it doesn't stutter
    //   end    -> arrive at 0 speed (soft settle)
    function applyNaturalBounceEase(prop) {
        var n = prop.numKeys;
        if (n < 2) { applyTransitionEase(prop, 2); return; }
        var easeDim = isSpatialProp(prop) ? 1 : dimensionOf(prop, 1);
        function mag(a, b) {
            if (a == null || b == null) return 0;
            if (a.length === undefined) return Math.abs(b - a);
            var s = 0; for (var i = 0; i < a.length; i++) { var d = (b[i]||0) - (a[i]||0); s += d * d; }
            return Math.sqrt(s);
        }
        function yOf(v) { return (v && v.length !== undefined) ? (v[1] || 0) : v; }
        for (var k = 1; k <= n; k++) {
            var t = prop.keyTime(k), v = prop.keyValue(k);
            var inSpeed = 0, outSpeed = 0;
            if (k > 1) { var dt = t - prop.keyTime(k - 1); if (dt > 0) inSpeed = mag(prop.keyValue(k - 1), v) / dt; }
            if (k < n) { var dt2 = prop.keyTime(k + 1) - t; if (dt2 > 0) outSpeed = mag(v, prop.keyValue(k + 1)) / dt2; }
            var role;
            if (k === 1) role = 'start';
            else if (k === n) role = 'end';
            else {
                var yp = yOf(prop.keyValue(k - 1)), yc = yOf(v), yn = yOf(prop.keyValue(k + 1));
                role = (yc < yp && yc < yn) ? 'apex' : 'ground';
            }
            var inSp, outSp, inInf, outInf;
            if (role === 'start')      { inSp = 0; outSp = 0;                 inInf = 50; outInf = 33; }
            else if (role === 'end')   { inSp = 0; outSp = 0;                 inInf = 60; outInf = 50; }
            else if (role === 'apex')  { inSp = 0; outSp = 0;                 inInf = 55; outInf = 55; }
            else { var sp = (inSpeed + outSpeed) * 0.5 * 0.85; inSp = sp; outSp = sp; inInf = 24; outInf = 24; }
            var inArr = [], outArr = [];
            for (var d = 0; d < easeDim; d++) {
                inArr.push(new KeyframeEase(capSpeed(inSp), inInf));
                outArr.push(new KeyframeEase(capSpeed(outSp), outInf));
            }
            setEaseRobust(prop, k, inArr, outArr, easeDim);
        }
    }

    function buildPopIn(layer, params, comp) {
        var duration = +params.duration || 0.6;
        var t0 = comp.time;

        // Appearance fade FIRST so it can never be skipped by a later error.
        addOpacityFadeIn(layer, t0, duration * 0.5);

        var sc = layer.transform.scale;
        var cur = sc.value;
        var dim = cur.length || 2;

        var startV = [];
        var peakV = [];
        for (var i = 0; i < dim; i++) {
            startV.push(0);
            // Slight overshoot above the rest value.
            peakV.push(cur[i] * (1 + SPRING_PEAK_PERCENT));
        }
        sc.setValueAtTime(t0, startV);
        sc.setValueAtTime(t0 + duration * SPRING_PEAK_T, peakV);
        sc.setValueAtTime(t0 + duration, cur);
        applyTransitionEase(sc, dim);
    }

    function buildBounceIn(layer, params, comp) {
        var duration = +params.duration || 0.7;
        var ox = +params.offsetX || 0;
        var oy = params.offsetY !== undefined ? +params.offsetY : 120;
        var t0 = comp.time;

        addOpacityFadeIn(layer, t0, duration * 0.4);

        var pos = layer.transform.position;
        var cur = pos.value;
        var dim = cur.length || 2;

        // Start position (offset from target).
        var startV = [];
        for (var i = 0; i < dim; i++) {
            if (i === 0)      startV.push(cur[0] + ox);
            else if (i === 1) startV.push(cur[1] + oy);
            else              startV.push(cur[i]);
        }
        // Peak position: target overshot in the opposite direction of approach.
        var peakV = springAtPeak(startV, cur);

        pos.setValueAtTime(t0, startV);
        pos.setValueAtTime(t0 + duration * SPRING_PEAK_T, peakV);
        pos.setValueAtTime(t0 + duration, cur);
        applyTransitionEase(pos, dim);
    }

    function buildSideToCenter(layer, params, comp, index) {
        // Selected layers fly in from alternating screen edges and settle at
        // the positions you placed them, converging toward the center. Even
        // layers enter from the LEFT edge, odd from the RIGHT — so a row of
        // layers "meets in the middle". Each layer starts just off its edge
        // (params.distance past it) regardless of comp size, then eases to rest.
        var duration = +params.duration || 0.7;
        var margin = +params.distance;
        if (isNaN(margin)) margin = 200;
        var t0 = comp.time;

        addOpacityFadeIn(layer, t0, duration * 0.35);

        var pos = layer.transform.position;
        var cur = pos.value;
        var dim = cur.length || 2;

        var fromLeft = (index % 2 === 0);
        var startX = fromLeft ? -margin : (comp.width + margin);

        var startV = [];
        for (var i = 0; i < dim; i++) {
            startV.push(i === 0 ? startX : cur[i]);
        }

        pos.setValueAtTime(t0, startV);
        pos.setValueAtTime(t0 + duration, cur);
        applyTransitionEase(pos, dim);
    }

    function buildDropIn(layer, params, comp) {
        // Drop from above and settle with two decaying bounces. The fall
        // accelerates (gravity), the apexes hang briefly, and the ground
        // contacts pass through with continuous velocity for a smooth, natural
        // bounce rather than a sharp stop-go.
        var duration = +params.duration || 1.0;
        var distance = +params.distance || 400;
        var t0 = comp.time;

        var fall = duration * 0.50;
        addOpacityFadeIn(layer, t0, fall * 0.55);

        var pos = layer.transform.position;
        var cur = pos.value;
        var dim = cur.length || 2;

        function offY(c, dy) {
            var r = [];
            for (var k = 0; k < c.length; k++) r.push(k === 1 ? c[k] + dy : c[k]);
            return r;
        }
        var above = offY(cur, -distance);
        var bounce1 = offY(cur, -distance * 0.13);   // softer (was 0.25)
        var bounce2 = offY(cur, -distance * 0.045);  // softer (was 0.08)

        var up1 = duration * 0.16;
        var down1 = duration * 0.15;
        var up2 = duration * 0.10;

        pos.setValueAtTime(t0, above);
        pos.setValueAtTime(t0 + fall, cur);
        pos.setValueAtTime(t0 + fall + up1, bounce1);
        pos.setValueAtTime(t0 + fall + up1 + down1, cur);
        pos.setValueAtTime(t0 + fall + up1 + down1 + up2, bounce2);
        pos.setValueAtTime(t0 + duration, cur);
        applyNaturalBounceEase(pos);
    }

    function buildSpinIn(layer, params, comp) {
        var duration = +params.duration || 1.45;
        var fromAngle = params.fromAngle !== undefined ? +params.fromAngle : -180;
        var fromScale = params.fromScale !== undefined ? +params.fromScale : 50;
        var t0 = comp.time;

        addOpacityFadeIn(layer, t0, duration * 0.4);

        // Rotation - 3-keyframe spring: from -> overshoot past target -> settle
        var rot = layer.threeDLayer
            ? layer.transform.zRotation || layer.transform.property('ADBE Rotate Z')
            : layer.transform.rotation || layer.transform.property('ADBE Rotate Z');
        var curR = rot.value;
        var startR = curR + fromAngle;
        var peakR = curR + (-fromAngle * SPRING_PEAK_PERCENT); // slight overshoot opposite direction
        rot.setValueAtTime(t0, startR);
        rot.setValueAtTime(t0 + duration * SPRING_PEAK_T, peakR);
        rot.setValueAtTime(t0 + duration, curR);
        applyTransitionEase(rot, 1);

        // Scale - same 3-keyframe spring shape
        var sc = layer.transform.scale;
        var curS = sc.value;
        var dim = curS.length || 2;
        var startS = [];
        var peakS = [];
        for (var i = 0; i < dim; i++) {
            startS.push(curS[i] * fromScale / 100);
            peakS.push(curS[i] * (1 + SPRING_PEAK_PERCENT));
        }
        sc.setValueAtTime(t0, startS);
        sc.setValueAtTime(t0 + duration * SPRING_PEAK_T, peakS);
        sc.setValueAtTime(t0 + duration, curS);
        applyTransitionEase(sc, dim);
    }

    function buildBlurIn(layer, params, comp) {
        var duration = +params.duration || 0.7;
        var maxBlur = +params.maxBlur || 30;
        var t0 = comp.time;

        addOpacityFadeIn(layer, t0, duration);

        var fx = layer.property('ADBE Effect Parade');
        var blur = fx.addProperty('ADBE Box Blur2');
        var radius = blur.property(1);
        radius.setValueAtTime(t0, maxBlur);
        radius.setValueAtTime(t0 + duration, 0);
        applyTransitionEase(radius, 1);
        try { blur.property(4).setValue(1); } catch (e) {} // Repeat Edge Pixels
    }

    function buildBlurOut(layer, params, comp) {
        var duration = +params.duration || 0.7;
        var maxBlur = +params.maxBlur || 30;
        var t0 = comp.time;

        addOpacityFadeOut(layer, t0, duration);

        var fx = layer.property('ADBE Effect Parade');
        var blur = fx.addProperty('ADBE Box Blur2');
        var radius = blur.property(1);
        radius.setValueAtTime(t0, 0);
        radius.setValueAtTime(t0 + duration, maxBlur);
        applyTransitionEase(radius, 1);
        try { blur.property(4).setValue(1); } catch (e) {} // Repeat Edge Pixels
    }

    function buildIrisClose(layer, params, comp) {
        var duration = +params.duration || 0.8;
        var t0 = comp.time;
        // Mask paths live in LAYER space, so the iris must be centred on the
        // layer's anchor point (the object's pivot/centre) — NOT the comp
        // centre, which is what made it close in seemingly random places.
        // maxR is the full comp diagonal so the circle always starts large
        // enough to reveal everything regardless of where the anchor sits.
        var maxR = Math.sqrt(comp.width * comp.width + comp.height * comp.height);

        var masks = layer.property('ADBE Mask Parade');
        var mask = masks.addProperty('ADBE Mask Atom');
        var maskPath = mask.property('ADBE Mask Shape');
        maskPath.expression =
            't0 = ' + t0 + ';\n' +
            'duration = ' + duration + ';\n' +
            'maxR = ' + maxR + ';\n' +
            'a = thisLayer.transform.anchorPoint;\n' +
            'cx = a[0];\n' +
            'cy = a[1];\n' +
            't01 = Math.max(0, Math.min(1, (time - t0) / duration));\n' +
            'p = 1 - (t01 < 0.5 ? 2*t01*t01 : 1 - Math.pow(-2*t01+2, 2)/2);\n' +
            'r = maxR * p;\n' +
            'if (r < 0.5) r = 0.5;\n' +
            'c = r * 0.5523;\n' +
            'createPath(\n' +
            '  [[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]],\n' +
            '  [[-c, 0], [0, -c], [c, 0], [0, c]],\n' +
            '  [[c, 0], [0, c], [-c, 0], [0, -c]],\n' +
            '  true\n' +
            ');';
    }

    // --- Added transitions (v2.1) — simple entrances/exits built from the
    //     same helpers as the originals (opacity fades + eased transform keys). --
    function buildFadeIn(layer, params, comp) {
        addOpacityFadeIn(layer, comp.time, +params.duration || 0.6);
    }

    function buildFadeOut(layer, params, comp) {
        addOpacityFadeOut(layer, comp.time, +params.duration || 0.6);
    }

    function buildGrowIn(layer, params, comp) {
        var duration = +params.duration || 0.6;
        var fromScale = params.fromScale !== undefined ? +params.fromScale : 80;
        var t0 = comp.time;
        addOpacityFadeIn(layer, t0, duration * 0.6);
        var sc = layer.transform.scale;
        var cur = sc.value;
        var dim = cur.length || 2;
        var startV = [];
        for (var i = 0; i < dim; i++) startV.push(cur[i] * fromScale / 100);
        sc.setValueAtTime(t0, startV);
        sc.setValueAtTime(t0 + duration, cur);
        applyTransitionEase(sc, dim);
    }

    function buildScaleOut(layer, params, comp) {
        var duration = +params.duration || 0.5;
        var toScale = params.toScale !== undefined ? +params.toScale : 0;
        var t0 = comp.time;
        addOpacityFadeOut(layer, t0, duration);
        var sc = layer.transform.scale;
        var cur = sc.value;
        var dim = cur.length || 2;
        var endV = [];
        for (var i = 0; i < dim; i++) endV.push(cur[i] * toScale / 100);
        sc.setValueAtTime(t0, cur);
        sc.setValueAtTime(t0 + duration, endV);
        applyTransitionEase(sc, dim);
    }

    function buildSlideIn(layer, params, comp) {
        var duration = +params.duration || 0.6;
        var ox = +params.offsetX || 0;
        var oy = params.offsetY !== undefined ? +params.offsetY : 80;
        var t0 = comp.time;
        addOpacityFadeIn(layer, t0, duration * 0.6);
        var pos = layer.transform.position;
        var cur = pos.value;
        var dim = cur.length || 2;
        var startV = [];
        for (var i = 0; i < dim; i++) {
            if (i === 0)      startV.push(cur[0] + ox);
            else if (i === 1) startV.push(cur[1] + oy);
            else              startV.push(cur[i]);
        }
        pos.setValueAtTime(t0, startV);
        pos.setValueAtTime(t0 + duration, cur);
        applyTransitionEase(pos, dim);
    }

    function buildSlideOut(layer, params, comp) {
        var duration = +params.duration || 0.6;
        var ox = +params.offsetX || 0;
        var oy = params.offsetY !== undefined ? +params.offsetY : 80;
        var t0 = comp.time;
        addOpacityFadeOut(layer, t0, duration);
        var pos = layer.transform.position;
        var cur = pos.value;
        var dim = cur.length || 2;
        var endV = [];
        for (var i = 0; i < dim; i++) {
            if (i === 0)      endV.push(cur[0] + ox);
            else if (i === 1) endV.push(cur[1] + oy);
            else              endV.push(cur[i]);
        }
        pos.setValueAtTime(t0, cur);
        pos.setValueAtTime(t0 + duration, endV);
        applyTransitionEase(pos, dim);
    }

    function buildRiseIn(layer, params, comp) {
        var duration = +params.duration || 0.7;
        var distance = +params.distance || 60;
        var t0 = comp.time;
        addOpacityFadeIn(layer, t0, duration * 0.7);
        var pos = layer.transform.position;
        var cur = pos.value;
        var dim = cur.length || 2;
        var startV = [];
        for (var i = 0; i < dim; i++) startV.push(i === 1 ? cur[1] + distance : cur[i]);
        pos.setValueAtTime(t0, startV);
        pos.setValueAtTime(t0 + duration, cur);
        applyTransitionEase(pos, dim);
    }

    function buildSpinOut(layer, params, comp) {
        var duration = +params.duration || 0.8;
        var angle = params.angle !== undefined ? +params.angle : 180;
        var toScale = params.toScale !== undefined ? +params.toScale : 50;
        var t0 = comp.time;
        addOpacityFadeOut(layer, t0, duration);
        var rot = layer.threeDLayer
            ? layer.transform.zRotation || layer.transform.property('ADBE Rotate Z')
            : layer.transform.rotation || layer.transform.property('ADBE Rotate Z');
        var curR = rot.value;
        rot.setValueAtTime(t0, curR);
        rot.setValueAtTime(t0 + duration, curR + angle);
        applyTransitionEase(rot, 1);
        var sc = layer.transform.scale;
        var curS = sc.value;
        var dim = curS.length || 2;
        var endS = [];
        for (var i = 0; i < dim; i++) endS.push(curS[i] * toScale / 100);
        sc.setValueAtTime(t0, curS);
        sc.setValueAtTime(t0 + duration, endS);
        applyTransitionEase(sc, dim);
    }

    $.global.pineapplefx_apply_transition = function (args) {
        try {
            args = args || {};
            var presetId = String(args.preset || '');
            var params = args.params || {};
            if (!presetId) return err('No preset id provided');

            var comp = activeComp();
            if (!comp) return err('Open a composition first');
            var layers = comp.selectedLayers;
            if (!layers || layers.length === 0) return err('Select at least one layer');

            app.beginUndoGroup('PineappleFX: Transition ' + presetId);
            var applied = 0;
            try {
                for (var i = 0; i < layers.length; i++) {
                    var l = layers[i];
                    if (presetId === 'pop-in')          buildPopIn(l, params, comp);
                    else if (presetId === 'bounce-in')  buildBounceIn(l, params, comp);
                    else if (presetId === 'spin-in')    buildSpinIn(l, params, comp);
                    else if (presetId === 'blur-in')    buildBlurIn(l, params, comp);
                    else if (presetId === 'blur-out')   buildBlurOut(l, params, comp);
                    else if (presetId === 'iris-close') buildIrisClose(l, params, comp);
                    else if (presetId === 'side-to-center') buildSideToCenter(l, params, comp, i);
                    else if (presetId === 'fade-in')    buildFadeIn(l, params, comp);
                    else if (presetId === 'fade-out')   buildFadeOut(l, params, comp);
                    else if (presetId === 'grow-in')    buildGrowIn(l, params, comp);
                    else if (presetId === 'scale-out')  buildScaleOut(l, params, comp);
                    else if (presetId === 'slide-in')   buildSlideIn(l, params, comp);
                    else if (presetId === 'slide-out')  buildSlideOut(l, params, comp);
                    else if (presetId === 'rise-in')    buildRiseIn(l, params, comp);
                    else if (presetId === 'spin-out')   buildSpinOut(l, params, comp);
                    else throw new Error('Unknown transition: ' + presetId);
                    applied++;
                }
            } finally {
                app.endUndoGroup();
            }
            return ok({ applied: applied });
        } catch (e) { return err(e); }
    };

    // -------------------------------------------------------------------
    // Styles - effects + layer styles applied to selected layers.
    // -------------------------------------------------------------------

    function safeProp(group, name, idx) {
        // Try by name first; fall back to numeric index if name fails. Used
        // to set Drop Shadow / Layer Style properties locale-safely.
        try {
            var p = group.property(name);
            if (p) return p;
        } catch (e) {}
        if (idx !== undefined) {
            try { return group.property(idx); } catch (e) {}
        }
        return null;
    }
    function tryPropSet(group, name, idx, value) {
        var p = safeProp(group, name, idx);
        if (!p) return false;
        try { p.setValue(value); return true; } catch (e) { return false; }
    }

    function buildStyleSoftShadow(layer, params) {
        var fx = layer.property('ADBE Effect Parade');
        var ds = fx.addProperty('ADBE Drop Shadow');
        // Effect props: 1=Color 2=Opacity(0-255) 3=Direction 4=Distance 5=Softness
        try { ds.property(1).setValue([0, 0, 0]); } catch (e) {}
        var op255 = Math.round((+params.opacity || 30) * 2.55);
        try { ds.property(2).setValue(op255); } catch (e) {}
        try { ds.property(3).setValue(135); } catch (e) {}
        try { ds.property(4).setValue(+params.distance || 12); } catch (e) {}
        try { ds.property(5).setValue(+params.softness || 35); } catch (e) {}
    }

    function ensureLayerStylesEnabled(layer) {
        try {
            var styles = layer.property('ADBE Layer Styles');
            try {
                var bo = styles.property('blendingOption');
                if (bo) bo.enabled = true;
            } catch (e) {}
            return styles;
        } catch (e) { return null; }
    }

    // Add a layer style to a layer and return its property group.
    //
    // CRITICAL: a layer style CANNOT be created by setting .enabled = true on
    // layer.property('ADBE Layer Styles').property('<matchName>') — that only
    // works if the style already exists, otherwise it silently no-ops (which is
    // exactly why Glow / Inner Highlight / Hairline "did nothing"). The only
    // script-supported way to ADD a style is the menu command:
    //   Layer > Layer Styles > <Name>
    // We select just this layer, run the command, then read back the style.
    //
    // menuName: the exact menu item ("Outer Glow", "Inner Shadow", "Stroke"…).
    // matchName: the layer-style match name ("outerGlow", "innerShadow"…) used
    //            to fetch the resulting group.
    function addLayerStyle(layer, menuName, matchName) {
        try {
            // Isolate selection to this layer so the command applies here only.
            var comp = layer.containingComp;
            var prevSel = comp.selectedLayers.slice(0);
            for (var i = 0; i < prevSel.length; i++) { try { prevSel[i].selected = false; } catch (e) {} }
            layer.selected = true;

            var styles = layer.property('ADBE Layer Styles');
            var existed = false;
            try { var pre = styles.property(matchName); existed = pre && pre.canSetEnabled; } catch (e) {}

            if (!existed) {
                var cmdId = app.findMenuCommandId('Layer Styles > ' + menuName);
                if (!cmdId) cmdId = app.findMenuCommandId(menuName);
                if (cmdId) app.executeCommand(cmdId);
            }

            // restore previous selection
            try { layer.selected = false; } catch (e) {}
            for (var j = 0; j < prevSel.length; j++) { try { prevSel[j].selected = true; } catch (e) {} }

            var grp = null;
            try { grp = styles.property(matchName); } catch (e) {}
            if (!grp) {
                // The exact style-group matchName varies across AE versions/locales
                // (e.g. Stroke resolves as 'frameFX/frameFX', not plain 'frameFX'),
                // which made styles.property('frameFX') return null even though the
                // menu command DID add the style (hence the leftover default red
                // stroke). Find the just-added group by scanning for a matchName
                // that contains ours, or by the menu/display name. Skips 'Blending
                // Options'. This also hardens Glow / Inner Highlight on odd builds.
                try {
                    var want = String(matchName).toLowerCase();
                    var wantName = String(menuName).toLowerCase();
                    for (var k = 1; k <= styles.numProperties; k++) {
                        var pk = styles.property(k);
                        var mn = ''; try { mn = String(pk.matchName).toLowerCase(); } catch (e) {}
                        var nm = ''; try { nm = String(pk.name).toLowerCase(); } catch (e) {}
                        if ((mn && mn.indexOf(want) !== -1) || (nm && nm === wantName)) { grp = pk; break; }
                    }
                } catch (e) {}
            }
            if (grp) { try { grp.enabled = true; } catch (e) {} }
            return grp || null;
        } catch (e) { return null; }
    }

    function buildStyleGlow(layer, params) {
        // Outer Glow layer style: halo around the layer alpha only. Does
        // NOT tint the interior pixels (unlike the AE Glow effect).
        var color = colorFromAny(params.color || '#a855f7');
        var og = addLayerStyle(layer, 'Outer Glow', 'outerGlow');
        if (!og) throw new Error('Glow: could not add Outer Glow layer style');
        tryPropSet(og, 'Blend Mode', 1, 3);     // Screen
        tryPropSet(og, 'Opacity', 2, +params.opacity || 85);
        tryPropSet(og, 'Color', 3, color);
        tryPropSet(og, 'Technique', 4, 1);      // Softer
        tryPropSet(og, 'Spread', 6, 0);
        tryPropSet(og, 'Size', 7, +params.size || 18);
        tryPropSet(og, 'Range', 9, 50);
    }

    function buildStyleInnerHighlight(layer, params) {
        // Top-light bevel: thin bright Inner Shadow at the top plus a soft
        // dark Inner Glow from the bottom. Visible on solids, shapes, text.
        var op = +params.opacity || 70;
        var sz = +params.size || 6;
        var is = addLayerStyle(layer, 'Inner Shadow', 'innerShadow');
        if (!is) throw new Error('Inner Highlight: could not add Inner Shadow layer style');
        tryPropSet(is, 'Blend Mode', 1, 4);      // Overlay
        tryPropSet(is, 'Opacity', 2, op);
        tryPropSet(is, 'Color', 3, [1, 1, 1]);
        tryPropSet(is, 'Use Global Light', 4, false);
        tryPropSet(is, 'Angle', 5, 90);          // light from top
        tryPropSet(is, 'Distance', 6, Math.max(1, sz * 0.3));
        tryPropSet(is, 'Choke', 7, 0);
        tryPropSet(is, 'Size', 8, sz);

        var ig = addLayerStyle(layer, 'Inner Glow', 'innerGlow');
        if (ig) {
            tryPropSet(ig, 'Blend Mode', 1, 5);      // Multiply
            tryPropSet(ig, 'Opacity', 2, op * 0.35);
            tryPropSet(ig, 'Color', 3, [0, 0, 0]);
            tryPropSet(ig, 'Size', 6, sz);
        }
    }

    function buildStyleHairline(layer, params) {
        var stroke = addLayerStyle(layer, 'Stroke', 'frameFX');
        if (!stroke) throw new Error('Hairline: could not add Stroke layer style');
        // 1 = Outside, 2 = Center, 3 = Inside
        tryPropSet(stroke, 'Position', 4, 1);
        tryPropSet(stroke, 'Size', 2, +params.size || 1);
        tryPropSet(stroke, 'Opacity', 3, +params.opacity || 100);
        tryPropSet(stroke, 'Color', 5, colorFromAny(params.color || '#1c1c1e'));
    }

    // ---- Text styles ----------------------------------------------------

    function applyTextDocMods(textLayer, mods) {
        var src = textLayer.property('ADBE Text Properties').property('ADBE Text Document');
        if (!src) throw new Error('Not a text layer');
        var doc = src.value;
        if (mods.font) {
            try { doc.font = mods.font; } catch (e) {}
        }
        if (mods.fontSize !== undefined) doc.fontSize = mods.fontSize;
        if (mods.tracking !== undefined) doc.tracking = mods.tracking;
        if (mods.fillColor !== undefined)   doc.fillColor   = mods.fillColor;
        if (mods.strokeColor !== undefined) doc.strokeColor = mods.strokeColor;
        if (mods.strokeWidth !== undefined) doc.strokeWidth = mods.strokeWidth;
        if (mods.applyFill !== undefined)   doc.applyFill   = mods.applyFill;
        if (mods.applyStroke !== undefined) doc.applyStroke = mods.applyStroke;
        src.setValue(doc);
    }

    // Build a flat map of installed font identifiers once per panel session.
    // app.fonts.allFonts is an array of Font objects in AE 2024+; on older
    // versions it may be missing so we fall back to letting setValue try.
    var _appleFontCache = null;
    function getInstalledFonts() {
        if (_appleFontCache) return _appleFontCache;
        var map = {};
        try {
            if (app.fonts && app.fonts.allFonts) {
                var arr = app.fonts.allFonts;
                for (var i = 0; i < arr.length; i++) {
                    var f = arr[i];
                    if (f.postScriptName) map[f.postScriptName] = 1;
                    if (f.fontName)       map[f.fontName] = 1;
                }
            }
        } catch (e) {}
        _appleFontCache = map;
        return map;
    }

    /**
     * Return the first PostScript name from the candidate list that AE
     * has installed. Order: SF Pro Display, Inter, Helvetica Neue, then
     * Helvetica / Arial as last-resort Apple-adjacent fallbacks.
     * Returns null if none match - caller should skip the font change.
     */
    function pickAppleFont(weight) {
        var lists = {
            'bold': [
                'SFProDisplay-Bold', 'SF-Pro-Display-Bold', 'SFProDisplayBold',
                'Inter-Bold', 'InterBold', 'Inter-Bold-Italic',
                'HelveticaNeue-Bold', 'HelveticaNeueBold',
                'Helvetica-Bold', 'Arial-Bold', 'ArialMT-Bold', 'Arial-BoldMT'
            ],
            'semibold': [
                'SFProDisplay-Semibold', 'SF-Pro-Display-Semibold',
                'Inter-SemiBold', 'InterSemiBold',
                'HelveticaNeue-Medium', 'HelveticaNeueMedium',
                'HelveticaNeue-Bold',
                'Helvetica-Bold', 'Arial-Bold'
            ],
            'regular': [
                'SFProDisplay-Regular', 'SF-Pro-Display-Regular', 'SFProDisplay',
                'Inter-Regular', 'Inter', 'InterRegular',
                'HelveticaNeue', 'Helvetica',
                'ArialMT', 'Arial'
            ]
        };
        var candidates = lists[weight] || lists.regular;
        var available = getInstalledFonts();
        var hasEnumerable = false;
        for (var k in available) { hasEnumerable = true; break; }

        if (hasEnumerable) {
            for (var i = 0; i < candidates.length; i++) {
                if (available[candidates[i]]) return candidates[i];
            }
            return null; // none of our Apple-adjacent fonts are installed
        }
        // No enumeration available - return first candidate and let AE
        // accept or silently keep the existing font.
        return candidates[0];
    }

    function buildStyleDisplay(layer, params) {
        if (!(layer instanceof TextLayer)) throw new Error('Display: select a text layer');
        var font = pickAppleFont('bold');
        var mods = {
            fontSize: +params.size || 80,
            tracking: +params.tracking !== undefined ? +params.tracking : -20,
            fillColor: colorFromAny(params.color || '#1c1c1e'),
            applyStroke: false
        };
        if (font) mods.font = font;
        applyTextDocMods(layer, mods);
    }

    // Clean vertical 2-color gradient on a text layer via the 4-Color Gradient
    // effect. The four color POINTS are expression-linked to the text's own
    // bounding box (sourceRectAtTime, which lives in layer space), so:
    //   * both colors are always visible (top pair at the glyph tops, bottom
    //     pair at the glyph bottoms) — a real top→bottom gradient, not 1 colour;
    //   * it tracks the text and is independent of where the layer sits in the
    //     comp (moving the layer doesn't move the gradient off the glyphs).
    // The effect composites over the original, so it respects the glyph alpha.
    function applyVerticalGradient(layer, topColor, bottomColor) {
        var fx = layer.property('ADBE Effect Parade');
        var grad = fx.addProperty('ADBE 4ColorGradient');
        // Flat indices: 1=Point1, 2=Color1, 3=Point2, 4=Color2,
        //               5=Point3, 6=Color3, 7=Point4, 8=Color4,
        //               9=Blend, 10=Jitter, 11=Opacity
        tryPropSet(grad, 'Color 1', 2, topColor);      // top-left
        tryPropSet(grad, 'Color 2', 4, topColor);      // top-right
        tryPropSet(grad, 'Color 3', 6, bottomColor);   // bottom-right
        tryPropSet(grad, 'Color 4', 8, bottomColor);   // bottom-left
        tryPropSet(grad, 'Blend', 9, 100);
        tryPropSet(grad, 'Jitter', 10, 0);             // no noise → clean blend
        tryPropSet(grad, 'Opacity', 11, 100);

        var sr = 'var r = thisLayer.sourceRectAtTime(time, false);\n';
        function setPointExpr(idx, xExpr, yExpr) {
            try {
                var p = grad.property(idx);
                if (p) p.expression = sr + '[' + xExpr + ', ' + yExpr + '];';
            } catch (e) {}
        }
        setPointExpr(1, 'r.left',             'r.top');               // Point 1 top-left
        setPointExpr(3, 'r.left + r.width',   'r.top');               // Point 2 top-right
        setPointExpr(5, 'r.left + r.width',   'r.top + r.height');    // Point 3 bottom-right
        setPointExpr(7, 'r.left',             'r.top + r.height');    // Point 4 bottom-left
        return grad;
    }

    // Set the colors on a Gradient Overlay layer style's gradient. AE layer-
    // style gradients use the Photoshop-style "Colors" property which is not a
    // plain settable value type, so we try several access paths and value
    // shapes. Returns true if any setValue succeeded.
    function setGradientOverlayColors(go, topColor, bottomColor) {
        // Candidate gradient sub-properties (match name then common indices).
        var gradProp = null;
        var names = ['Colors', 'Gradient', 'ADBE Gradient Overlay-0003',
                     'ADBE Gradient Overlay-0011'];
        for (var n = 0; n < names.length && !gradProp; n++) {
            try { var p = go.property(names[n]); if (p) gradProp = p; } catch (e) {}
        }
        if (!gradProp) {
            for (var idx = 3; idx <= 12 && !gradProp; idx++) {
                try {
                    var pi = go.property(idx);
                    if (pi && pi.name && /grad|color/i.test(pi.name)) gradProp = pi;
                } catch (e) {}
            }
        }
        if (!gradProp) return false;
        // top = first stop, bottom = last stop. AE gradient stop colors are
        // 0..1 floats. topColor/bottomColor arrive as [r,g,b] 0..1 already.
        var t = topColor, b = bottomColor;
        // Try a handful of value encodings AE builds have accepted.
        var attempts = [
            // [pos, r,g,b, pos, r,g,b] flat stop list (2 stops)
            [0, t[0], t[1], t[2], 1, b[0], b[1], b[2]],
            // nested stops
            [[0, t[0], t[1], t[2]], [1, b[0], b[1], b[2]]],
            // alpha-included
            [0, t[0], t[1], t[2], 1, 1, b[0], b[1], b[2], 1]
        ];
        for (var a = 0; a < attempts.length; a++) {
            try { gradProp.setValue(attempts[a]); return true; } catch (e) {}
        }
        return false;
    }

    // Apply a clean 2-color vertical gradient to text via a Gradient Overlay
    // layer style ("Color Gradient"). Unlike the 4-Color Gradient effect this
    // clips exactly to the glyph alpha and produces a clean linear blend.
    // Returns true ONLY if the style was enabled AND its colors were set — so
    // the caller can fall back to the effect rather than leave a default
    // black→white gradient if this AE build won't accept the gradient value.
    function applyChromeGradientStyle(layer, topColor, bottomColor) {
        var styles = ensureLayerStylesEnabled(layer);
        if (!styles) return false;
        var go = null;
        var goNames = ['gradientFill', 'ADBE Gradient Overlay'];
        for (var i = 0; i < goNames.length && !go; i++) {
            try { var g = styles.property(goNames[i]); if (g) go = g; } catch (e) {}
        }
        if (!go) return false;
        try { go.enabled = true; } catch (e) {}
        // Geometry: clean vertical (top->bottom) linear gradient aligned to layer.
        tryPropSet(go, 'Blend Mode', 1, 1);        // Normal
        tryPropSet(go, 'Opacity', 2, 100);
        tryPropSet(go, 'Angle', 5, 90);            // 90deg = vertical
        tryPropSet(go, 'Style', 6, 1);             // Linear
        tryPropSet(go, 'Reverse', 7, false);
        tryPropSet(go, 'Align with Layer', 8, true);
        tryPropSet(go, 'Scale', 9, 100);
        var colored = setGradientOverlayColors(go, topColor, bottomColor);
        if (!colored) {
            // Couldn't set the gradient stops on this build — turn the style off
            // so we don't leave a wrong (default) gradient, and signal fallback.
            try { go.enabled = false; } catch (e) {}
            return false;
        }
        return true;
    }

    function buildStyleChrome(layer, params, extPath) {
        if (!(layer instanceof TextLayer)) throw new Error('Chrome: select a text layer');
        var font = pickAppleFont('bold');
        var mods = {
            tracking: -10,
            applyFill: true,
            applyStroke: false
        };
        if (font) mods.font = font;
        applyTextDocMods(layer, mods);

        // Apply the bundled "Chrome.ffx" animation preset, which adds the
        // proper Gradient Overlay layer style with the silver chrome gradient
        // baked in. AE does not expose layer-style gradient colors to scripting,
        // so a hand-made preset is the only reliable way to get a real Gradient
        // Overlay — hence the colors are fixed (no editable params). This preset
        // is authored on AE 22 so it loads on 22+ (the earlier one needed 24+).
        var ffx = bundledFile('presets/Chrome.ffx', extPath);
        if (!ffx) throw new Error('Chrome: Chrome.ffx preset not found in extension');
        try {
            layer.applyPreset(ffx);
        } catch (e) {
            throw new Error('Chrome: could not apply Chrome preset — ' + (e.message || e));
        }
    }

    function buildStyleLightSweep(layer, params, comp) {
        var duration = +params.duration || 1.5;
        var color = colorFromAny(params.color || '#ffffff');
        var intensity = +params.intensity || 35;
        var width = +params.width || 50;
        var angle = (+params.angle !== undefined ? +params.angle : 90);
        var t0 = comp.time;

        var fx = layer.property('ADBE Effect Parade');
        var sweep;
        try { sweep = fx.addProperty('CC Light Sweep'); }
        catch (e) { throw new Error('CC Light Sweep effect not available'); }

        // Property names + indices for CC Light Sweep (locale-safe via tryPropSet).
        //   1 = Center,  2 = Direction,  3 = Shape,  4 = Width,
        //   5 = Sweep Intensity, 6 = Edge Intensity, 7 = Edge Thickness,
        //   8 = Light Color, 9 = Light Reception
        tryPropSet(sweep, 'Direction', 2, angle);      // user-controlled sweep angle
        tryPropSet(sweep, 'Shape', 3, 2);              // Smooth (1=Linear, 2=Smooth, 3=Sharp)
        tryPropSet(sweep, 'Width', 4, width);
        tryPropSet(sweep, 'Sweep Intensity', 5, intensity);
        tryPropSet(sweep, 'Edge Intensity', 6, intensity * 0.5);
        tryPropSet(sweep, 'Edge Thickness', 7, 1);
        tryPropSet(sweep, 'Light Color', 8, color);
        tryPropSet(sweep, 'Light Reception', 9, 1);    // Composite

        // Animate Center across the LAYER (not the comp). CC Light Sweep's Center
        // is in the layer's own coordinate space, so using comp.width put the
        // sweep in the wrong place on any layer that doesn't fill the comp (the
        // tester's "applies in a different position than the preview"). We use
        // the layer's source bounds, and sweep ALONG the chosen angle so the
        // highlight travels fully across and OFF the layer (no mid-stop).
        var center = safeProp(sweep, 'Center', 1);
        if (center) {
            var w, h, cx, cy;
            try {
                var r = layer.sourceRectAtTime(t0, false);
                w = r.width; h = r.height; cx = r.left + r.width / 2; cy = r.top + r.height / 2;
            } catch (e) {
                // Fallback to comp bounds if sourceRect is unavailable.
                w = comp.width; h = comp.height; cx = comp.width / 2; cy = comp.height / 2;
            }
            // Travel distance: the diagonal, so it fully clears the layer at any
            // angle. Direction in CC Light Sweep is measured clockwise from up;
            // convert to a vector and animate the center from one side to the other.
            var diag = Math.sqrt(w * w + h * h) * 0.75 + width;
            var rad = (angle - 90) * Math.PI / 180;   // sweep travel direction
            var dxu = Math.cos(rad), dyu = Math.sin(rad);
            var startPt = [cx - dxu * diag, cy - dyu * diag];
            var endPt   = [cx + dxu * diag, cy + dyu * diag];
            center.setValueAtTime(t0, startPt);
            center.setValueAtTime(t0 + duration, endPt);
            // LINEAR so the highlight travels at constant speed fully across and
            // off — the old eased version decelerated and appeared to "stop"
            // near the middle.
            try {
                center.setInterpolationTypeAtKey(1, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
                center.setInterpolationTypeAtKey(2, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
            } catch (e) {}
        }
    }

    // --- Added styles (v2.1) — single-effect looks. Each property set is
    //     guarded, so a wrong index degrades gracefully (effect still added)
    //     instead of throwing and aborting the whole apply. ---
    function pfxAddEffect(layer, matchName) {
        return layer.property('ADBE Effect Parade').addProperty(matchName);
    }

    function buildStyleTint(layer, params) {
        var color = colorFromAny(params.color || '#2b7ccf');
        var e = pfxAddEffect(layer, 'ADBE Tint');
        try { e.property(1).setValue([0, 0, 0]); } catch (er) {}          // Map Black To
        try { e.property(2).setValue(color); } catch (er) {}              // Map White To
        try { e.property(3).setValue(+params.amount || 100); } catch (er) {} // Amount to Tint
    }

    function buildStyleDuotone(layer, params) {
        var shadow = colorFromAny(params.shadow || '#12123a');
        var highlight = colorFromAny(params.highlight || '#ff8a3d');
        var e = pfxAddEffect(layer, 'ADBE Tint');
        try { e.property(1).setValue(shadow); } catch (er) {}
        try { e.property(2).setValue(highlight); } catch (er) {}
        try { e.property(3).setValue(+params.amount || 100); } catch (er) {}
    }

    function buildStyleSaturation(layer, params) {
        var e = pfxAddEffect(layer, 'ADBE HUE SATURATION');
        try { e.property(4).setValue(+params.saturation || 0); } catch (er) {} // Master Saturation
    }

    function buildStyleBrightness(layer, params) {
        var e = pfxAddEffect(layer, 'ADBE Brightness & Contrast 2');
        try { e.property(1).setValue(+params.brightness || 0); } catch (er) {}
        try { e.property(2).setValue(+params.contrast || 0); } catch (er) {}
    }

    function buildStyleInvert(layer, params) {
        var e = pfxAddEffect(layer, 'ADBE Invert');
        var amt = params.amount !== undefined ? +params.amount : 100;
        try { e.property(2).setValue(100 - amt); } catch (er) {} // Blend With Original
    }

    function buildStyleBlur(layer, params) {
        var e = pfxAddEffect(layer, 'ADBE Box Blur2');
        try { e.property(1).setValue(+params.amount || 12); } catch (er) {} // Blur Radius
        try { e.property(4).setValue(1); } catch (er) {}                    // Repeat Edge Pixels
    }

    function buildStyleSharpen(layer, params) {
        var e = pfxAddEffect(layer, 'ADBE Sharpen');
        try { e.property(1).setValue(+params.amount || 30); } catch (er) {}
    }

    function buildStyleNoise(layer, params) {
        var e = pfxAddEffect(layer, 'ADBE Noise');
        try { e.property(1).setValue(+params.amount || 20); } catch (er) {} // Amount of Noise
    }

    function buildStyleMosaic(layer, params) {
        var e = pfxAddEffect(layer, 'ADBE MOSAIC');
        var b = +params.blocks || 24;
        try { e.property(1).setValue(b); } catch (er) {}                     // Horizontal Blocks
        try { e.property(2).setValue(Math.max(1, Math.round(b * 9 / 16))); } catch (er) {} // Vertical
    }

    function buildStyleFill(layer, params) {
        var color = colorFromAny(params.color || '#0a84ff');
        var e = pfxAddEffect(layer, 'ADBE Fill');
        try { e.property(3).setValue(color); } catch (er) {}                    // Color
        try { e.property(7).setValue((+params.opacity || 100) / 100); } catch (er) {} // Opacity (0-1)
    }

    function buildStylePosterize(layer, params) {
        var e = pfxAddEffect(layer, 'ADBE Posterize');
        try { e.property(1).setValue(+params.levels || 6); } catch (er) {} // Level
    }

    $.global.pineapplefx_apply_style = function (args) {
        try {
            args = args || {};
            var presetId = String(args.preset || '');
            var params = args.params || {};
            var extPath = args.extPath || null;
            if (!presetId) return err('No preset id provided');

            var comp = activeComp();
            if (!comp) return err('Open a composition first');
            var layers = comp.selectedLayers;
            if (!layers || layers.length === 0) return err('Select at least one layer');

            app.beginUndoGroup('PineappleFX: Style ' + presetId);
            var applied = 0;
            try {
                for (var i = 0; i < layers.length; i++) {
                    (function (l) {
                        pfxWrapStyleApply(l, function () {
                            if (presetId === 'soft-shadow')          buildStyleSoftShadow(l, params);
                            else if (presetId === 'glow')            buildStyleGlow(l, params);
                            else if (presetId === 'inner-highlight') buildStyleInnerHighlight(l, params);
                            else if (presetId === 'hairline')        buildStyleHairline(l, params);
                            else if (presetId === 'light-sweep')     buildStyleLightSweep(l, params, comp);
                            else if (presetId === 'display')         buildStyleDisplay(l, params);
                            else if (presetId === 'chrome')          buildStyleChrome(l, params, extPath);
                            else if (presetId === 'anamorphic')      buildStyleAnamorphic(l, params);
                            else if (presetId === 'tint')            buildStyleTint(l, params);
                            else if (presetId === 'duotone')         buildStyleDuotone(l, params);
                            else if (presetId === 'saturation')      buildStyleSaturation(l, params);
                            else if (presetId === 'brightness')      buildStyleBrightness(l, params);
                            else if (presetId === 'invert')          buildStyleInvert(l, params);
                            else if (presetId === 'blur')            buildStyleBlur(l, params);
                            else if (presetId === 'sharpen')         buildStyleSharpen(l, params);
                            else if (presetId === 'noise')           buildStyleNoise(l, params);
                            else if (presetId === 'mosaic')          buildStyleMosaic(l, params);
                            else if (presetId === 'fill')            buildStyleFill(l, params);
                            else if (presetId === 'posterize')       buildStylePosterize(l, params);
                            else throw new Error('Unknown style: ' + presetId);
                        });
                    })(layers[i]);
                    applied++;
                }
            } finally {
                app.endUndoGroup();
            }
            return ok({ applied: applied });
        } catch (e) { return err(e); }
    };

    // ===================================================================
    // PACKAGE D - REAL "Liquid Glass" card, reverse-engineered from the
    // owner's 5-layer stack (Glass effect.txt). All five layers are the SAME
    // rounded-rect pill (roundness 99). Each is built as an expression-driven
    // rounded solid (the version-safe path the older glass uses) and every
    // pill is parented to the existing PineappleFX Controls null so the whole
    // card moves/scales with one control.
    //
    // Final stack, top to bottom (matches the reference exactly):
    //   1 (top) "Mask"   - reference pill, eye OFF
    //   2       "Light"  - Fill(black) + 2x CC Light Sweep + native Glow
    //   3       "Shape"  - CC Glass + CC Blobbylize
    //   4       "Blur"   - Gaussian Blur + Noise (frosted backdrop)
    //   5 (bot) "Shadow" - Drop Shadow (Shadow Only)
    //
    // CC Glass / CC Blobbylize / CC Light Sweep ship WITH After Effects. The
    // owner's Deep Glow is third-party, so we substitute native Glow (ADBE
    // Glo2), the fallback everyone has.
    //
    // IMPORTANT: the mask paths bind to the null via ctrlExpr(), which
    // hardcodes CONTROLS_NAME ('PineappleFX Controls'). The null is therefore
    // NOT renamed, otherwise every mask expression would break.
    // ===================================================================

    // Rounded-mask expression bound to the PineappleFX Controls null
    // (Width / Height / Corner sliders). Same createPath math as bindMaskShape().
    function bindGlassMaskShape(mask, diagnostics) {
        tryRun(function() {
            var maskPath = mask.property('ADBE Mask Shape');
            maskPath.expression =
                'w = ' + ctrlExpr('Width') + ';\n' +
                'h = ' + ctrlExpr('Height') + ';\n' +
                'r = Math.min(' + ctrlExpr('Corner') + ', w / 2, h / 2);\n' +
                'cx = thisComp.width / 2;\n' +
                'cy = thisComp.height / 2;\n' +
                'x1 = cx - w / 2; y1 = cy - h / 2;\n' +
                'x2 = cx + w / 2; y2 = cy + h / 2;\n' +
                'c = r * 0.5523;\n' +
                'createPath(\n' +
                '  [[x1 + r, y1], [x2 - r, y1], [x2, y1 + r], [x2, y2 - r], [x2 - r, y2], [x1 + r, y2], [x1, y2 - r], [x1, y1 + r]],\n' +
                '  [[-c, 0], [0, 0], [0, -c], [0, 0], [c, 0], [0, 0], [0, c], [0, 0]],\n' +
                '  [[0, 0], [c, 0], [0, 0], [0, c], [0, 0], [-c, 0], [0, 0], [0, -c]],\n' +
                '  true\n' +
                ');';
        }, 'bind glass mask path', diagnostics);
    }

    // One rounded-rect pill: comp-sized white solid + expression rounded mask
    // bound to the PineappleFX Controls null. Version-safe (no shape-layer setValue).
    function addGlassPill(comp, name, diagnostics) {
        // SHAPE layer (NOT a solid): CC Glass / CC Blobbylize only refract
        // correctly on shape layers. The rounded rect is driven by the PineappleFX
        // Controls null (Width / Height / Corner) via expressions.
        var shape = comp.layers.addShape();
        shape.name = name;
        tryRun(function() {
            var root = shape.property('ADBE Root Vectors Group');
            var grp = root.addProperty('ADBE Vector Group');
            var contents = grp.property('ADBE Vectors Group');
            var rect = contents.addProperty('ADBE Vector Shape - Rect');
            try { rect.property('ADBE Vector Rect Size').expression =
                '[' + ctrlExpr('Width') + ', ' + ctrlExpr('Height') + ']'; } catch (e) {}
            try { rect.property('ADBE Vector Rect Roundness').expression = ctrlExpr('Corner'); } catch (e) {}
            var fill = contents.addProperty('ADBE Vector Graphic - Fill');
            try { fill.property('ADBE Vector Fill Color').setValue([1, 1, 1]); } catch (e) {}
        }, name + ' shape', diagnostics);
        return { layer: shape, mask: null };
    }

    function glassGlowColor(raw) {
        try { return colorFromAny(raw); } catch (e) { return [1, 1, 1]; }
    }

    $.global.pineapplefx_insert_glass_real = function (args) {
        try {
            args = args || {};
            var params = args.params || {};

            var comp = activeComp();
            if (!comp) return err('Open or select a composition first');

            var meta = REAL_GLASS_META['liquid-glass'];
            var d = meta.defaults;

            function num(key) {
                return (params[key] !== undefined && !isNaN(+params[key])) ? +params[key] : d[key];
            }

            var W  = +params.width  || d.width;
            var H  = +params.height || d.height;
            var CR = num('corner');
            // Figma-parity controls.
            var LA = num('lightAngle');
            var LI = num('lightIntensity');
            var RF = num('refraction');
            var DP = num('depth');
            var DS = num('dispersion');
            var FR = num('frost');
            var SP = num('splay');
            var glowRGB = glassGlowColor(params.glowColor || d.glowColor);

            app.beginUndoGroup('PineappleFX: Liquid Glass');
            var diagnostics = [];
            var controls = null, mask5 = null, blur4 = null, shape3 = null, light2 = null, shadow1 = null;

            try {
                // Controls null FIRST so pill masks can bind to it. Do NOT rename
                // it: ctrlExpr() references CONTROLS_NAME and a rename would
                // orphan every mask expression.
                // Slider names mirror Figma's Glass panel so the null reads the
                // same way the panel does.
                controls = addControlsNull(comp, [
                    { name: 'Width',  value: W },
                    { name: 'Height', value: H },
                    { name: 'Corner', value: CR },
                    { name: 'Light',           value: LA },
                    { name: 'Light Intensity', value: LI },
                    { name: 'Refraction',      value: RF },
                    { name: 'Depth',           value: DP },
                    { name: 'Dispersion',      value: DS },
                    { name: 'Frost',           value: FR },
                    { name: 'Splay',           value: SP },
                    { name: 'Ambient', value: 101 }
                ]);

                // Build BOTTOM-UP so the final top->bottom order matches the
                // reference: Mask, Light, Shape, Blur, Shadow. Each addGlassPill
                // inserts at the top, so we add Shadow first (ends at bottom)
                // and Mask last (ends at top).

                // 5 (bottom). Shadow - Drop Shadow, Shadow Only (opacity 147/255
                //             = 57.5%, dir 135, dist 17, soft 21). Inline (not the
                //             shared helper) so we can set Shadow Only = 1.
                shadow1 = addGlassPill(comp, 'Shadow', diagnostics);
                tryRun(function() {
                    var fx = shadow1.layer.property('ADBE Effect Parade');
                    var ds = fx.addProperty('ADBE Drop Shadow');
                    try { ds.property(1).setValue([0, 0, 0]); } catch (e) {} // Shadow Color
                    try { ds.property(2).setValue(147);       } catch (e) {} // Opacity (0-255)
                    try { ds.property(3).setValue(135);       } catch (e) {} // Direction
                    try { ds.property(4).setValue(17);        } catch (e) {} // Distance
                    try { ds.property(5).setValue(21);        } catch (e) {} // Softness
                    try { ds.property(6).setValue(1);         } catch (e) {} // Shadow Only
                }, 'drop shadow', diagnostics);

                // 4. Blur - Gaussian Blur (Blurriness = BL, Repeat Edge Pixels)
                //           + Noise 3%.
                blur4 = addGlassPill(comp, 'Blur', diagnostics);
                // ADJUSTMENT layer: Gaussian+Noise frost the REAL background
                // under the card (within the pill mask), not a white solid.
                try { blur4.layer.adjustmentLayer = true; } catch (e) {}
                tryRun(function() {
                    var fx = blur4.layer.property('ADBE Effect Parade');
                    var gb = fx.addProperty('ADBE Gaussian Blur 2');
                    // Frost 4 (Figma default) * 3.5 = the reference blurriness of 14.
                    try { gb.property(1).expression = '3.5 * (' + ctrlExpr('Frost') + ')'; } catch (e) {}
                    try { gb.property(3).setValue(1);  } catch (e) {} // Repeat Edge Pixels
                    var nz = fx.addProperty('ADBE Noise2');
                    try { nz.property(1).setValue(1); } catch (e) {}  // Amount of Noise (1%)

                    // Dispersion — chromatic separation. Figma computes true
                    // per-wavelength offsets in a shader; After Effects has no
                    // native equivalent, so we approximate it with an asymmetric
                    // per-channel blur, which fringes high-contrast edges the same
                    // way. Wrapped like everything else: if the match name is
                    // missing on a given AE build it degrades to no dispersion
                    // and reports a diagnostic rather than failing the insert.
                    var cb = fx.addProperty('ADBE Channel Blur');
                    try { cb.property(1).expression = '0.16 * (' + ctrlExpr('Dispersion') + ')'; } catch (e) {} // Red
                    try { cb.property(2).setValue(0); } catch (e) {}                                            // Green
                    try { cb.property(3).expression = '0.06 * (' + ctrlExpr('Dispersion') + ')'; } catch (e) {} // Blue
                    try { cb.property(5).setValue(1); } catch (e) {} // Repeat Edge Pixels
                }, 'blur+noise+dispersion', diagnostics);

                // 3. Shape - CC Glass + CC Blobbylize (captured reference numbers;
                //            CC Glass Displacement scaled by glassStrength).
                shape3 = addGlassPill(comp, 'Shape', diagnostics);
                // ADJUSTMENT layer: CC Glass + CC Blobbylize refract the REAL
                // background under the card (within the pill mask). This is what
                // makes it see-through glass instead of an opaque shape.
                try { shape3.layer.adjustmentLayer = true; } catch (e) {}
                tryRun(function() {
                    var fx = shape3.layer.property('ADBE Effect Parade');
                    var g = fx.addProperty('CC Glass');
                    try { g.property('CC Glass-0003').setValue(6);    } catch (e) {} // Property = Lightness
                    // Splay spreads the refraction outwards from the edge — that is
                    // CC Glass / Blobbylize softness. Splay 0 keeps the reference 35.2.
                    try { g.property('CC Glass-0004').expression = '35.2 + 0.45 * (' + ctrlExpr('Splay') + ')'; } catch (e) {} // Softness
                    // Depth 20 (Figma default) * 1.7 = the reference height of 34.
                    try { g.property('CC Glass-0005').expression = '1.7 * (' + ctrlExpr('Depth') + ')'; } catch (e) {} // Height
                    // Refraction 80 (Figma default) * 1.5625 = the reference displacement of 125.
                    try { g.property('CC Glass-0006').expression = '1.5625 * (' + ctrlExpr('Refraction') + ')'; } catch (e) {} // Displacement
                    try { g.property('CC Glass-0017').expression = ctrlExpr('Ambient'); } catch (e) {} // Ambient <- null slider (glass brightness)
                    try { g.property('CC Glass-0018').setValue(61);   } catch (e) {} // Diffuse
                    try { g.property('CC Glass-0019').setValue(17);   } catch (e) {} // Specular
                    try { g.property('CC Glass-0021').setValue(100);  } catch (e) {} // Metal
                    var b = fx.addProperty('CC Blobbylize');
                    try { b.property('CC Blobbylize-0003').setValue(6);    } catch (e) {} // Property = Lightness
                    try { b.property('CC Blobbylize-0004').expression = '39.6 + 0.45 * (' + ctrlExpr('Splay') + ')'; } catch (e) {} // Softness
                }, 'cc glass+blobbylize', diagnostics);

                // 2. Light - Fill(black) + 2x CC Light Sweep + native Glow.
                light2 = addGlassPill(comp, 'Light', diagnostics);
                tryRun(function() {
                    var fx = light2.layer.property('ADBE Effect Parade');
                    var fill = fx.addProperty('ADBE Fill');
                    try { fill.property('ADBE Fill-0002').setValue([0, 0, 0, 1]); } catch (e) {
                        try { fill.property('ADBE Fill-0002').setValue([0, 0, 0]); } catch (e2) {}
                    }
                    // Both sweeps take their direction from the single Light angle,
                    // keeping the reference offsets between them: at Figma's default
                    // of -45° this yields exactly -30° and 140°.
                    var s1 = fx.addProperty('CC Light Sweep');
                    try { s1.property('CC Light Sweep-0002').expression = ctrlExpr('Light') + ' + 15'; } catch (e) {} // Direction
                    try { s1.property('CC Light Sweep-0004').setValue(76);  } catch (e) {} // Width
                    // Light Intensity 80 * 0.075 = the reference sweep intensity of 6.
                    try { s1.property('CC Light Sweep-0005').expression = '0.075 * (' + ctrlExpr('Light Intensity') + ')'; } catch (e) {}
                    try { s1.property('CC Light Sweep-0006').setValue(85);  } catch (e) {} // Edge Intensity
                    try { s1.property('CC Light Sweep-0009').setValue(3);   } catch (e) {} // Light Reception = Cutout (transparent, not black)
                    var s2 = fx.addProperty('CC Light Sweep');
                    try { s2.property('CC Light Sweep-0002').expression = ctrlExpr('Light') + ' + 185'; } catch (e) {} // Direction
                    try { s2.property('CC Light Sweep-0004').setValue(76);  } catch (e) {} // Width
                    try { s2.property('CC Light Sweep-0005').setValue(0);   } catch (e) {} // Sweep Intensity
                    // Edge Intensity 33 at the default; scales with Light Intensity.
                    try { s2.property('CC Light Sweep-0006').expression = '0.4125 * (' + ctrlExpr('Light Intensity') + ')'; } catch (e) {}
                    try { s2.property('CC Light Sweep-0009').setValue(1);   } catch (e) {} // Light Reception = Add
                    var glow = fx.addProperty('ADBE Glo2');
                    // Light Intensity 80 * 2.425 = the reference glow radius of 194.
                    try { glow.property('Glow Radius').expression = '2.425 * (' + ctrlExpr('Light Intensity') + ')'; } catch (e) {}
                    try { glow.property('Glow Intensity').setValue(1.2); } catch (e) {}
                    try { glow.property('Glow Colors').setValue(2); } catch (e) {} // A & B Colors
                    try { glow.property('Color A').setValue(glowRGB); } catch (e) {}
                    try { glow.property('Color B').setValue(glowRGB); } catch (e) {}
                }, 'fill+sweeps+glow', diagnostics);

                // 1 (top). Mask - reference pill, eye OFF.
                mask5 = addGlassPill(comp, 'Mask', diagnostics);
                tryRun(function() { mask5.layer.enabled = false; }, 'mask eye off', diagnostics);
                // Inner Shadow layer style on the Mask = the edge height map that
                // gives the glass its rim displacement. Exact reference values:
                // Multiply, black, opacity 88, angle 120, distance 7, choke/size 0.
                tryRun(function() {
                    var is = addLayerStyle(mask5.layer, 'Inner Shadow', 'innerShadow');
                    if (is) {
                        tryPropSet(is, 'Blend Mode', 1, 5);           // Multiply
                        tryPropSet(is, 'Opacity', 2, 88);
                        tryPropSet(is, 'Color', 3, [0, 0, 0]);
                        tryPropSet(is, 'Use Global Light', 4, false);
                        // The rim is the height map the refraction reads, so it has
                        // to follow the same Light angle — otherwise the highlight
                        // and the edge displacement point in different directions.
                        // At Figma's default of -45° this evaluates to the
                        // reference 120°.
                        tryPropSet(is, 'Angle', 5, 120);
                        tryRun(function() {
                            var expr = ctrlExpr('Light') + ' + 165';
                            try { is.property('Angle').expression = expr; }
                            catch (e) { is.property(5).expression = expr; }
                        }, 'inner shadow angle <- light', diagnostics);
                        tryPropSet(is, 'Distance', 6, 7);
                        tryPropSet(is, 'Choke', 7, 0);
                        tryPropSet(is, 'Size', 8, 0);
                    }
                }, 'mask inner shadow', diagnostics);

                // Point CC Glass Bump Map + CC Blobbylize Blob Layer at the Mask
                // layer (its Inner Shadow rim is the height map that gives the
                // edge displacement), matching the reference project.
                tryRun(function() {
                    var fx = shape3.layer.property('ADBE Effect Parade');
                    try { fx.property('CC Glass').property('CC Glass-0002').setValue(mask5.layer.index); } catch (e) {}
                    try { fx.property('CC Blobbylize').property('CC Blobbylize-0002').setValue(mask5.layer.index); } catch (e) {}
                }, 'glass bump -> mask', diagnostics);

                // Parent all 5 pills to the PineappleFX Controls null.
                tryRun(function() {
                    mask5.layer.parent   = controls;
                    light2.layer.parent  = controls;
                    shape3.layer.parent  = controls;
                    blur4.layer.parent   = controls;
                    shadow1.layer.parent = controls;
                }, 'parent to null', diagnostics);

                // Tag the whole rig so the Remove bar detects it (its pills have
                // generic names) and Remove deletes exactly these layers.
                tryRun(function() {
                    pfxTagLayer(controls);
                    pfxTagLayer(mask5.layer);
                    pfxTagLayer(light2.layer);
                    pfxTagLayer(shape3.layer);
                    pfxTagLayer(blur4.layer);
                    pfxTagLayer(shadow1.layer);
                }, 'tag rig', diagnostics);
            } catch (eFatal) {
                app.endUndoGroup();
                return err('Fatal: ' + (eFatal.message || eFatal) +
                           (diagnostics.length ? ' - before: ' + diagnostics.join(' - ') : ''));
            }
            app.endUndoGroup();

            return ok({ preset: meta.label, layers: 6, diagnostics: diagnostics });
        } catch (e) { return err(e); }
    };

    // ===================================================================
    // NUMBER COUNTER (Numbers tab).
    //
    // The expression is built panel-side (src/presets/numbers.ts) so the panel
    // preview and the rendered comp go through ONE formatter. This side only
    // places the live sliders and attaches the expression.
    // ===================================================================

    /** Reuse a slider of this name if the layer already has one, so
     *  re-applying tweaks values instead of stacking duplicates. */
    function setOrAddSlider(layer, name, value) {
        var fx = layer.property('ADBE Effect Parade');
        var existing = null;
        try { existing = fx.property(name); } catch (e) { existing = null; }
        if (existing) {
            try { existing.property(1).setValue(value); return existing; } catch (e2) {}
        }
        return addSliderEffect(layer, name, value);
    }

    /** args: { code: string, sliders: [{ name, value }] } */
    $.global.pineapplefx_apply_number_counter = function (args) {
        try {
            args = args || {};
            var code = args.code;
            var sliders = args.sliders || [];
            if (!code) return err('No expression supplied');

            var comp = activeComp();
            if (!comp) return err('Open or select a composition first');

            var layers = comp.selectedLayers;
            if (!layers || layers.length === 0) return err('Select a text layer');

            app.beginUndoGroup('PineappleFX: Number Counter');
            var applied = 0, skipped = 0, reasons = [];
            try {
                for (var i = 0; i < layers.length; i++) {
                    var layer = layers[i];
                    if (!(layer instanceof TextLayer)) { skipped++; continue; }
                    try {
                        for (var s = 0; s < sliders.length; s++) {
                            setOrAddSlider(layer, sliders[s].name, +sliders[s].value);
                        }
                        var st = getSourceText(layer);
                        if (!st) { skipped++; reasons.push(layer.name + ': no source text'); continue; }
                        st.expression = code;
                        st.expressionEnabled = true;
                        pfxTagLayer(layer);
                        applied++;
                    } catch (e) {
                        skipped++;
                        reasons.push(layer.name + ': ' + String(e.message || e));
                    }
                }
            } finally {
                app.endUndoGroup();
            }

            if (applied === 0) {
                return err(reasons.length > 0 ? reasons[0] : 'Select at least one text layer');
            }
            return ok({ applied: applied, skipped: skipped, reasons: reasons });
        } catch (e) { return err(e); }
    };

    // ===================================================================
    // TOOLS - one-click utilities.
    // ===================================================================

    /**
     * Put a text layer's anchor point at the geometric centre of the TEXT
     * ITSELF - not the layer box, not the comp - and optionally drop the layer
     * in the middle of the comp.
     *
     * sourceRectAtTime() is what makes this exact: it reports the real ink
     * bounds in layer space, so it is already correct for any font, size,
     * leading, alignment or number of lines, and it is unaffected by the
     * layer's own scale.
     *
     * Returns null on success, or a short reason string.
     */
    function centerTextLayer(textLayer, comp, centerInComp) {
        var xf = textLayer.property('ADBE Transform Group');
        var anchorProp = xf.property('ADBE Anchor Point');
        var posProp = xf.property('ADBE Position');

        // setValue() throws on an animated property, so say so rather than
        // silently doing nothing.
        if (anchorProp.numKeys > 0) return 'anchor point is keyframed';
        if (posProp.numKeys > 0) return 'position is keyframed';

        // Measure while the layer is actually on: an empty rect outside the
        // layer's own span would centre on nothing.
        var t = comp.time;
        if (t < textLayer.inPoint || t > textLayer.outPoint) t = textLayer.inPoint;

        var rect = textLayer.sourceRectAtTime(t, false);
        if (!rect || (rect.width === 0 && rect.height === 0)) return 'text is empty';

        var oldAnchor = anchorProp.value;
        var newAnchor = [rect.left + rect.width / 2, rect.top + rect.height / 2];
        if (oldAnchor.length > 2) newAnchor.push(oldAnchor[2]);

        // Moving the anchor shifts the layer visually. The correction is the
        // anchor delta run through the layer's own scale and rotation.
        var dx = newAnchor[0] - oldAnchor[0];
        var dy = newAnchor[1] - oldAnchor[1];

        var sx = 1, sy = 1;
        try {
            var sc = xf.property('ADBE Scale').value;
            sx = (sc[0] || 100) / 100;
            sy = (sc[1] || 100) / 100;
        } catch (e) {}

        var rad = 0;
        try { rad = (xf.property('ADBE Rotate Z').value || 0) * Math.PI / 180; } catch (e) {}

        var offsetX = (dx * sx) * Math.cos(rad) - (dy * sy) * Math.sin(rad);
        var offsetY = (dx * sx) * Math.sin(rad) + (dy * sy) * Math.cos(rad);

        anchorProp.setValue(newAnchor);

        var oldPos = posProp.value;
        var newPos = centerInComp
            ? [comp.width / 2, comp.height / 2]
            : [oldPos[0] + offsetX, oldPos[1] + offsetY];
        if (oldPos.length > 2) newPos.push(oldPos[2]);
        posProp.setValue(newPos);

        return null;
    }

    // ===================================================================
    // DEVICE FRAMES.
    //
    // All geometry arrives precomputed from src/presets/devices.ts as explicit
    // vertices and tangents. Nothing is recalculated here on purpose: the
    // corner maths is continuous-curve (superellipse) rather than circular, it
    // was verified visually in the panel, and re-deriving it in ExtendScript
    // would just create a second implementation to drift.
    // ===================================================================

    /** Build an AE Shape from a { vertices, inTangents, outTangents } payload. */
    function pfxShapeFromPath(path) {
        var s = new Shape();
        s.vertices = path.vertices;
        s.inTangents = path.inTangents;
        s.outTangents = path.outTangents;
        s.closed = true;
        return s;
    }

    /** Shape layer carrying one closed path and a solid fill. */
    function pfxPathLayer(comp, name, path, rgb, opacity) {
        var layer = comp.layers.addShape();
        layer.name = name;
        tryRun(function () {
            var grp = layer.property('ADBE Root Vectors Group').addProperty('ADBE Vector Group');
            var contents = grp.property('ADBE Vectors Group');
            var shapeProp = contents.addProperty('ADBE Vector Shape - Group');
            shapeProp.property('ADBE Vector Shape').setValue(pfxShapeFromPath(path));
            var fill = contents.addProperty('ADBE Vector Graphic - Fill');
            try { fill.property('ADBE Vector Fill Color').setValue(rgb); } catch (e) {}
            if (opacity !== undefined) {
                try { fill.property('ADBE Vector Fill Opacity').setValue(opacity); } catch (e) {}
            }
        }, name + ' path', []);
        return layer;
    }

    /** args: { spec: DeviceFrameSpec } */
    $.global.pineapplefx_add_device_frame = function (args) {
        try {
            args = args || {};
            var spec = args.spec;
            if (!spec || !spec.bodyPath) return err('No device geometry supplied');

            var comp = activeComp();
            if (!comp) return err('Open or select a composition first');

            app.beginUndoGroup('PineappleFX: ' + (spec.label || 'Device Frame'));
            var diagnostics = [];
            try {
                // Screen precomp at native pixel size, so a real screen
                // recording drops in at 1:1 with no scaling.
                var screenComp = app.project.items.addComp(
                    'PineappleFX Screen — ' + spec.label,
                    spec.screenPxW, spec.screenPxH, 1,
                    comp.duration, comp.frameRate
                );

                // One null holds the whole frame: drag it to move, scale it to
                // resize, and nothing inside needs touching.
                var handle = comp.layers.addNull(comp.duration);
                handle.name = 'PineappleFX Device';
                handle.guideLayer = true;
                tryRun(function () {
                    handle.transform.position.setValue([comp.width / 2, comp.height / 2]);
                }, 'device handle position', diagnostics);

                // Fit the frame to the comp with a margin, so it lands usable
                // rather than cropped.
                tryRun(function () {
                    var fit = (comp.height * 0.82) / spec.bodyH * 100;
                    if (fit > 100) fit = 100;
                    handle.transform.scale.setValue([fit, fit]);
                }, 'device handle scale', diagnostics);

                var body = pfxPathLayer(comp, 'Device Body', spec.bodyPath,
                    glassGlowColor(spec.bodyColor || '#1c1c1e'));
                tryRun(function () {
                    var ds = body.property('ADBE Effect Parade').addProperty('ADBE Drop Shadow');
                    try { ds.property(2).setValue(120); } catch (e) {} // Opacity 0-255
                    try { ds.property(3).setValue(180); } catch (e) {} // Direction
                    try { ds.property(4).setValue(28);  } catch (e) {} // Distance
                    try { ds.property(5).setValue(60);  } catch (e) {} // Softness
                }, 'device shadow', diagnostics);

                // Screen: the precomp, masked to the display path. The mask
                // arrives already in this layer's pixel space.
                var screen = comp.layers.add(screenComp);
                screen.name = 'Device Screen';
                tryRun(function () {
                    screen.transform.scale.setValue([spec.screenLayerScale, spec.screenLayerScale]);
                }, 'screen scale', diagnostics);
                tryRun(function () {
                    var mask = screen.property('ADBE Mask Parade').addProperty('ADBE Mask Atom');
                    mask.property('ADBE Mask Shape').setValue(pfxShapeFromPath(spec.screenMaskPath));
                }, 'screen mask', diagnostics);

                // Glass reflection across the display.
                var glare = pfxPathLayer(comp, 'Device Glare', spec.screenPath, [1, 1, 1], 100);
                tryRun(function () {
                    var fx = glare.property('ADBE Effect Parade');
                    var sweep = fx.addProperty('CC Light Sweep');
                    try { sweep.property('CC Light Sweep-0002').setValue(-32); } catch (e) {} // Direction
                    try { sweep.property('CC Light Sweep-0004').setValue(120); } catch (e) {} // Width
                    try { sweep.property('CC Light Sweep-0005').setValue(14);  } catch (e) {} // Sweep Intensity
                    try { sweep.property('CC Light Sweep-0009').setValue(3);   } catch (e) {} // Cutout
                    glare.transform.opacity.setValue(12);
                    glare.blendingMode = BlendingMode.ADD;
                }, 'device glare', diagnostics);

                var island = null;
                if (spec.islandPath) {
                    island = pfxPathLayer(comp, 'Device Island', spec.islandPath, [0, 0, 0]);
                    tryRun(function () {
                        island.transform.position.setValue([
                            comp.width / 2,
                            comp.height / 2 + spec.islandOffsetY
                        ]);
                    }, 'island position', diagnostics);
                }

                // Everything rides the handle. Parenting preserves each layer's
                // own offset, so the island stays where it was placed.
                tryRun(function () {
                    body.parent = handle;
                    screen.parent = handle;
                    glare.parent = handle;
                    if (island) island.parent = handle;
                }, 'parent device layers', diagnostics);

                // Top to bottom: Island, Glare, Screen, Body.
                tryRun(function () {
                    body.moveToEnd();
                    screen.moveBefore(body);
                    glare.moveBefore(screen);
                    if (island) island.moveBefore(glare);
                }, 'device layer order', diagnostics);

                tryRun(function () {
                    pfxTagLayer(body);
                    pfxTagLayer(screen);
                    pfxTagLayer(glare);
                    if (island) pfxTagLayer(island);
                }, 'tag device layers', diagnostics);

                return ok({
                    applied: 1,
                    device: spec.label,
                    screenComp: screenComp.name,
                    diagnostics: diagnostics
                });
            } finally {
                app.endUndoGroup();
            }
        } catch (e) { return err(e); }
    };

    /**
     * Reorder a list of layers for the sequencer.
     *
     * `items` arrives in stack order, top first. Centre-out sorts by distance
     * from the middle so the middle layer leads and the outer ones follow.
     */
    function pfxOrderForSequence(items, order) {
        var out = items.slice(0);
        if (order === 'bottom') {
            out.reverse();
        } else if (order === 'center') {
            var mid = (out.length - 1) / 2;
            out.sort(function (a, b) {
                return Math.abs(items.indexOf(a) - mid) - Math.abs(items.indexOf(b) - mid);
            });
        } else if (order === 'random') {
            for (var i = out.length - 1; i > 0; i--) {
                var j = Math.floor(Math.random() * (i + 1));
                var tmp = out[i]; out[i] = out[j]; out[j] = tmp;
            }
        }
        return out;
    }

    /**
     * args: { params: { offsetFrames, order, curve, from } }
     *
     * Shifts each layer's startTime rather than setting inPoint: startTime
     * moves the whole layer, keyframes included, where writing inPoint would
     * trim it instead.
     */
    $.global.pineapplefx_sequence_layers = function (args) {
        try {
            args = args || {};
            var p = args.params || {};

            var comp = activeComp();
            if (!comp) return err('Open or select a composition first');

            var selected = comp.selectedLayers;
            if (!selected || selected.length < 2) return err('Select two or more layers');

            var frames = Math.max(1, Math.round(+p.offsetFrames || 2));
            var offset = frames * comp.frameDuration;
            var order = p.order || 'top';
            var curve = p.curve || 'linear';

            // Stack order, top first — that is what "top first" has to mean.
            var items = [];
            for (var i = 0; i < selected.length; i++) items.push(selected[i]);
            items.sort(function (a, b) { return a.index - b.index; });

            var base;
            if (p.from === 'playhead') {
                base = comp.time;
            } else {
                base = items[0].inPoint;
                for (var b = 1; b < items.length; b++) {
                    if (items[b].inPoint < base) base = items[b].inPoint;
                }
            }

            var sequence = pfxOrderForSequence(items, order);
            var n = sequence.length;
            var span = offset * (n - 1);

            app.beginUndoGroup('PineappleFX: Sequence Layers');
            var moved = 0, skipped = 0;
            try {
                for (var k = 0; k < n; k++) {
                    var layer = sequence[k];
                    var x = n > 1 ? k / (n - 1) : 0;
                    var eased = curve === 'easeIn' ? x * x
                        : curve === 'easeOut' ? 1 - (1 - x) * (1 - x)
                        : x;
                    var target = base + eased * span;
                    try {
                        layer.startTime = layer.startTime + (target - layer.inPoint);
                        moved++;
                    } catch (e) { skipped++; }
                }
            } finally {
                app.endUndoGroup();
            }

            if (moved === 0) return err('Could not move the selected layers');
            return ok({ applied: moved, skipped: skipped, offsetFrames: frames });
        } catch (e) { return err(e); }
    };

    // Sequence End-to-Start: butt the selected layers together in time so each
    // one's In Point lands exactly on the previous layer's Out Point — no gaps,
    // no overlaps, a continuous run. The first layer stays put; every following
    // layer keeps its own duration (only its start time moves). Time-based, so
    // it is independent of frame rate and of any keyframes on the layers.
    $.global.pineapplefx_sequence_end_to_start = function (args) {
        try {
            args = args || {};
            var p = args.params || {};

            var comp = activeComp();
            if (!comp) return err('Open or select a composition first');

            var selected = comp.selectedLayers;
            if (!selected || selected.length < 2) return err('Select two or more layers');

            // Timeline order: top layer (index 1) first. 'bottom' reverses it.
            var items = [];
            for (var i = 0; i < selected.length; i++) items.push(selected[i]);
            items.sort(function (a, b) { return a.index - b.index; });
            if (p.order === 'bottom') items.reverse();

            app.beginUndoGroup('PineappleFX: Sequence End to Start');
            var moved = 0, skipped = 0;
            try {
                // The first layer anchors the chain and does not move.
                var prevOut = items[0].outPoint;
                for (var k = 1; k < items.length; k++) {
                    var layer = items[k];
                    try {
                        var oldIn = layer.inPoint;
                        var dur = layer.outPoint - oldIn;         // preserve duration
                        // Shift the whole layer so its In Point sits on prevOut.
                        layer.startTime = layer.startTime + (prevOut - oldIn);
                        prevOut = prevOut + dur;                  // this layer's new Out Point
                        moved++;
                    } catch (e) { skipped++; }
                }
            } finally {
                app.endUndoGroup();
            }

            if (moved === 0) return err('Could not move the selected layers');
            return ok({ applied: moved, skipped: skipped });
        } catch (e) { return err(e); }
    };

    /** Native Color Control effect, reused if the layer already has one. */
    function setOrAddColorControl(layer, name, rgb) {
        var fx = layer.property('ADBE Effect Parade');
        var existing = null;
        try { existing = fx.property(name); } catch (e) { existing = null; }
        if (!existing) {
            existing = fx.addProperty('ADBE Color Control');
            try { existing.name = name; } catch (e2) {}
        }
        try { existing.property(1).setValue(rgb); } catch (e3) {}
        return existing;
    }

    /**
     * Build a shape that hugs a text layer.
     *
     * The whole point is that nothing is baked: size and position are
     * expressions over the TEXT layer's own sourceRectAtTime, so editing the
     * copy resizes the shape with no further action. Padding, radius and fill
     * live on the shape as native controls (Slider / Color), which keeps them
     * adjustable in After Effects rather than only in the panel.
     *
     * Text scale is folded into the size, but padding is not — padding should
     * stay visually constant when the text layer is scaled.
     */
    function addTextBoxFor(textLayer, comp, variant, params, diagnostics) {
        var shape = comp.layers.addShape();
        shape.name = 'PineappleFX · Text Box';

        var ref = 'thisComp.layer("' + escExpr(textLayer.name) + '")';
        var head =
            'var T = ' + ref + ';\n' +
            'var R = T.sourceRectAtTime(time, false);\n' +
            'var S = T.transform.scale;\n' +
            'var W = R.width * S[0] / 100;\n' +
            'var H = R.height * S[1] / 100;\n';

        var padX = isNaN(+params.padX) ? 24 : +params.padX;

        // Controls shared by every variant.
        setOrAddSlider(shape, 'PineappleFX Padding X', padX);
        setOrAddColorControl(shape, 'PineappleFX Fill', glassGlowColor(params.fill || '#0a84ff'));

        var sizeExpr, roundExpr, offsetExpr;

        if (variant === 'underline') {
            setOrAddSlider(shape, 'PineappleFX Thickness', isNaN(+params.thickness) ? 8 : +params.thickness);
            setOrAddSlider(shape, 'PineappleFX Gap', isNaN(+params.gap) ? 10 : +params.gap);
            sizeExpr = head +
                'var th = effect("PineappleFX Thickness")(1);\n' +
                '[W + effect("PineappleFX Padding X")(1) * 2, th];';
            roundExpr = 'Math.min(effect("PineappleFX Thickness")(1) / 2, 999);';
            // Sit under the text: half the text height, plus the gap and half
            // the bar's own thickness.
            offsetExpr = head +
                'H / 2 + effect("PineappleFX Gap")(1) + effect("PineappleFX Thickness")(1) / 2;';
        } else if (variant === 'highlight') {
            setOrAddSlider(shape, 'PineappleFX Height', isNaN(+params.heightPct) ? 62 : +params.heightPct);
            setOrAddSlider(shape, 'PineappleFX Radius', isNaN(+params.radius) ? 4 : +params.radius);
            sizeExpr = head +
                '[W + effect("PineappleFX Padding X")(1) * 2, H * effect("PineappleFX Height")(1) / 100];';
            roundExpr = 'effect("PineappleFX Radius")(1);';
            offsetExpr = '0;';
        } else {
            // pill and card differ only in how the corner radius is derived.
            setOrAddSlider(shape, 'PineappleFX Padding Y', isNaN(+params.padY) ? 14 : +params.padY);
            sizeExpr = head +
                '[W + effect("PineappleFX Padding X")(1) * 2, H + effect("PineappleFX Padding Y")(1) * 2];';
            if (variant === 'card') {
                setOrAddSlider(shape, 'PineappleFX Radius', isNaN(+params.radius) ? 16 : +params.radius);
                roundExpr = 'effect("PineappleFX Radius")(1);';
            } else {
                roundExpr = head +
                    'Math.min(W + effect("PineappleFX Padding X")(1) * 2, H + effect("PineappleFX Padding Y")(1) * 2) / 2;';
            }
            offsetExpr = '0;';
        }

        tryRun(function () {
            var root = shape.property('ADBE Root Vectors Group');
            var grp = root.addProperty('ADBE Vector Group');
            var contents = grp.property('ADBE Vectors Group');

            var rect = contents.addProperty('ADBE Vector Shape - Rect');
            try { rect.property('ADBE Vector Rect Size').expression = sizeExpr; } catch (e) {}
            try { rect.property('ADBE Vector Rect Roundness').expression = roundExpr; } catch (e) {}

            var fill = contents.addProperty('ADBE Vector Graphic - Fill');
            try { fill.property('ADBE Vector Fill Color').expression = 'effect("PineappleFX Fill")(1);'; } catch (e) {}
        }, 'text box shape', diagnostics);

        // Follow the text: centre on its ink centre in COMP space (toComp
        // accounts for the text layer's own transform), and match its rotation.
        tryRun(function () {
            shape.property('ADBE Transform Group').property('ADBE Position').expression =
                head +
                'var c = T.toComp([R.left + R.width / 2, R.top + R.height / 2]);\n' +
                'var off = ' + offsetExpr + '\n' +
                '[c[0], c[1] + off];';
        }, 'text box position', diagnostics);

        tryRun(function () {
            shape.property('ADBE Transform Group').property('ADBE Rotate Z').expression =
                ref + '.transform.rotation;';
        }, 'text box rotation', diagnostics);

        // Behind the text, not in front of it.
        tryRun(function () { shape.moveAfter(textLayer); }, 'text box order', diagnostics);

        return shape;
    }

    /** args: { variant: 'pill'|'card'|'underline'|'highlight', params: {...} } */
    $.global.pineapplefx_add_text_box = function (args) {
        try {
            args = args || {};
            var variant = args.variant || 'pill';
            var params = args.params || {};

            var comp = activeComp();
            if (!comp) return err('Open or select a composition first');

            var layers = comp.selectedLayers;
            if (!layers || layers.length === 0) return err('Select a text layer');

            app.beginUndoGroup('PineappleFX: Text Box');
            var diagnostics = [];
            var applied = 0, skipped = 0;
            try {
                // Snapshot the selection: adding layers changes it as we go.
                var targets = [];
                for (var i = 0; i < layers.length; i++) {
                    if (layers[i] instanceof TextLayer) targets.push(layers[i]);
                    else skipped++;
                }
                for (var j = 0; j < targets.length; j++) {
                    try {
                        addTextBoxFor(targets[j], comp, variant, params, diagnostics);
                        applied++;
                    } catch (e) {
                        skipped++;
                        diagnostics.push(targets[j].name + ': ' + String(e.message || e));
                    }
                }
            } finally {
                app.endUndoGroup();
            }

            if (applied === 0) {
                return err(diagnostics.length > 0 ? diagnostics[0] : 'Select at least one text layer');
            }
            return ok({ applied: applied, skipped: skipped, diagnostics: diagnostics });
        } catch (e) { return err(e); }
    };

    /**
     * args: { centerInComp: boolean }
     *   true  (default) - anchor to text centre AND layer to comp centre
     *   false           - anchor only; the text does not move on screen
     */
    $.global.pineapplefx_center_text = function (args) {
        try {
            args = args || {};
            var centerInComp = args.centerInComp !== false;

            var comp = activeComp();
            if (!comp) return err('Open or select a composition first');

            var layers = comp.selectedLayers;
            if (!layers || layers.length === 0) return err('Select a text layer');

            app.beginUndoGroup(centerInComp ? 'PineappleFX: Center Text' : 'PineappleFX: Center Anchor');
            var applied = 0, skipped = 0, reasons = [];
            try {
                for (var i = 0; i < layers.length; i++) {
                    var layer = layers[i];
                    if (!(layer instanceof TextLayer)) { skipped++; continue; }
                    var reason;
                    try { reason = centerTextLayer(layer, comp, centerInComp); }
                    catch (e) { reason = String(e.message || e); }
                    if (reason === null) applied++;
                    else { skipped++; reasons.push(layer.name + ': ' + reason); }
                }
            } finally {
                app.endUndoGroup();
            }

            if (applied === 0) {
                return err(reasons.length > 0 ? reasons[0] : 'Select at least one text layer');
            }
            return ok({ applied: applied, skipped: skipped, reasons: reasons });
        } catch (e) { return err(e); }
    };

    // ===================================================================
    // PACKAGE E - "Liquid Glass Pro": TRUE chromatic dispersion.
    //
    // Why this needs its own architecture: dispersion means refracting the
    // background three times at slightly different indices and recombining it
    // per channel. The standard rig refracts via ADJUSTMENT layers, and those
    // chain - each one sees the result of the one below, so isolating a channel
    // in the first pass leaves nothing for the second to read.
    //
    // The fix is to make the three passes SIBLINGS instead of a stack:
    //
    //   PineappleFX Glass Source      the user's background, precomposed once
    //   PineappleFX Glass Dispersion  Mask (bump) + three sibling layers, each
    //                             sourcing Glass Source, each with its own
    //                             CC Glass displacement, each keeping one
    //                             channel, recombined with Add
    //
    // Because the three passes are separate AV layers rather than stacked
    // adjustment layers, every one of them reads the pristine background.
    //
    // Cross-comp expressions are funnelled through ONE mirror null inside the
    // dispersion comp, so the parent comp is named in a single place instead of
    // in every expression.
    // ===================================================================

    var GLASS_SOURCE_NAME = 'PineappleFX Glass Source';
    var GLASS_DISP_NAME   = 'PineappleFX Glass Dispersion';

    // Shift Channels enum. VERIFY IN AE: 10 is "Full Off" on the builds we
    // target; each set is wrapped, so a wrong value degrades to "channel not
    // isolated" (a visibly too-bright card) rather than a failed insert.
    var SC_FULL_OFF = 10, SC_RED = 2, SC_GREEN = 3, SC_BLUE = 4;

    function escExpr(s) {
        return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    // Mask path bound to the Controls null and centred on the NULL'S POSITION
    // rather than comp centre. That lets a masked layer follow the null without
    // being parented to it - essential for layers whose source is a comp, where
    // parenting would drag the whole background image around.
    function bindGlassMaskShapeAtNull(mask, diagnostics) {
        tryRun(function () {
            mask.property('ADBE Mask Shape').expression =
                'ctrl = thisComp.layer("' + CONTROLS_NAME + '");\n' +
                'w = ctrl.effect("Width")(1);\n' +
                'h = ctrl.effect("Height")(1);\n' +
                'r = Math.min(ctrl.effect("Corner")(1), w / 2, h / 2);\n' +
                'p = ctrl.transform.position;\n' +
                'cx = p[0]; cy = p[1];\n' +
                'x1 = cx - w / 2; y1 = cy - h / 2;\n' +
                'x2 = cx + w / 2; y2 = cy + h / 2;\n' +
                'c = r * 0.5523;\n' +
                'createPath(\n' +
                '  [[x1 + r, y1], [x2 - r, y1], [x2, y1 + r], [x2, y2 - r], [x2 - r, y2], [x1 + r, y2], [x1, y2 - r], [x1, y1 + r]],\n' +
                '  [[-c, 0], [0, 0], [0, -c], [0, 0], [c, 0], [0, 0], [0, c], [0, 0]],\n' +
                '  [[0, 0], [c, 0], [0, 0], [0, c], [0, 0], [-c, 0], [0, 0], [0, -c]],\n' +
                '  true\n' +
                ');';
        }, 'bind mask to null', diagnostics);
    }

    // A null inside the dispersion comp that mirrors the real Controls null in
    // the user's comp. Everything inside the dispersion comp then uses the
    // ordinary ctrlExpr() (thisComp), and only these expressions know the
    // parent comp's name.
    function addMirrorControlsNull(dispComp, parentName, sliderNames, diagnostics) {
        var nl = dispComp.layers.addNull(dispComp.duration);
        nl.name = CONTROLS_NAME;
        nl.guideLayer = true;
        var ref = 'comp("' + escExpr(parentName) + '").layer("' + CONTROLS_NAME + '")';

        tryRun(function () {
            nl.transform.position.expression = ref + '.transform.position';
        }, 'mirror null position', diagnostics);

        for (var i = 0; i < sliderNames.length; i++) {
            (function (name) {
                addSliderEffect(nl, name, 0);
                tryRun(function () {
                    nl.property('ADBE Effect Parade').property(name).property(1).expression =
                        ref + '.effect("' + name + '")(1)';
                }, 'mirror slider ' + name, diagnostics);
            })(sliderNames[i]);
        }
        return nl;
    }

    // One refraction pass: the shared source, refracted, reduced to a single
    // channel. `keep` is 'r' | 'g' | 'b'.
    function addDispersionPass(dispComp, sourceComp, name, keep, dispExpr, blend, diagnostics) {
        var layer = dispComp.layers.add(sourceComp);
        layer.name = name;
        tryRun(function () {
            var fx = layer.property('ADBE Effect Parade');
            var g = fx.addProperty('CC Glass');
            try { g.property('CC Glass-0003').setValue(6); } catch (e) {} // Property = Lightness
            try { g.property('CC Glass-0004').expression = '35.2 + 0.45 * (' + ctrlExpr('Splay') + ')'; } catch (e) {}
            try { g.property('CC Glass-0005').expression = '1.7 * (' + ctrlExpr('Depth') + ')'; } catch (e) {}
            try { g.property('CC Glass-0006').expression = dispExpr; } catch (e) {} // Displacement, per-channel
            try { g.property('CC Glass-0017').setValue(101); } catch (e) {} // Ambient
            try { g.property('CC Glass-0018').setValue(61);  } catch (e) {} // Diffuse
            try { g.property('CC Glass-0019').setValue(17);  } catch (e) {} // Specular
            try { g.property('CC Glass-0021').setValue(100); } catch (e) {} // Metal

            var sc = fx.addProperty('ADBE Shift Channels');
            try { sc.property(2).setValue(keep === 'r' ? SC_RED   : SC_FULL_OFF); } catch (e) {} // Take Red From
            try { sc.property(3).setValue(keep === 'g' ? SC_GREEN : SC_FULL_OFF); } catch (e) {} // Take Green From
            try { sc.property(4).setValue(keep === 'b' ? SC_BLUE  : SC_FULL_OFF); } catch (e) {} // Take Blue From
        }, name + ' refraction pass', diagnostics);

        if (blend !== null) {
            tryRun(function () { layer.blendingMode = blend; }, name + ' blend mode', diagnostics);
        }
        return layer;
    }

    $.global.pineapplefx_insert_glass_pro = function (args) {
        try {
            args = args || {};
            var params = args.params || {};

            var comp = activeComp();
            if (!comp) return err('Open or select a composition first');
            if (comp.numLayers === 0) {
                return err('Liquid Glass Pro refracts what is behind it - add your background layers first');
            }

            var d = REAL_GLASS_META['liquid-glass-pro'].defaults;
            function num(key) {
                return (params[key] !== undefined && !isNaN(+params[key])) ? +params[key] : d[key];
            }
            var W  = +params.width  || d.width;
            var H  = +params.height || d.height;
            var CR = num('corner');
            var LA = num('lightAngle'), LI = num('lightIntensity');
            var RF = num('refraction'), DP = num('depth'), DS = num('dispersion');
            var FR = num('frost'), SP = num('splay');
            var glowRGB = glassGlowColor(params.glowColor || d.glowColor);

            app.beginUndoGroup('PineappleFX: Liquid Glass Pro');
            var diagnostics = [];

            try {
                // 1. Precompose everything already in the comp: the shared,
                //    pristine source all three passes read. Still editable -
                //    double-click in, and edits reach every pass.
                var indices = [];
                for (var i = 1; i <= comp.numLayers; i++) indices.push(i);
                var sourceComp = comp.layers.precompose(indices, GLASS_SOURCE_NAME, true);

                // 2. Controls null in the user's comp - the single source of truth.
                var sliderNames = [
                    'Width', 'Height', 'Corner', 'Light', 'Light Intensity',
                    'Refraction', 'Depth', 'Dispersion', 'Frost', 'Splay'
                ];
                var controls = addControlsNull(comp, [
                    { name: 'Width',  value: W }, { name: 'Height', value: H },
                    { name: 'Corner', value: CR },
                    { name: 'Light',  value: LA }, { name: 'Light Intensity', value: LI },
                    { name: 'Refraction', value: RF }, { name: 'Depth', value: DP },
                    { name: 'Dispersion', value: DS }, { name: 'Frost', value: FR },
                    { name: 'Splay', value: SP }
                ]);

                // 3. Dispersion comp: three sibling passes over one source.
                var dispComp = app.project.items.addComp(
                    GLASS_DISP_NAME, comp.width, comp.height,
                    comp.pixelAspect, comp.duration, comp.frameRate
                );
                addMirrorControlsNull(dispComp, comp.name, sliderNames, diagnostics);

                // Red bends most, blue least - the same ordering as real glass.
                var baseDisp = '1.5625 * (' + ctrlExpr('Refraction') + ')';
                var spread   = '(' + ctrlExpr('Dispersion') + ' / 100 * 0.12)';
                addDispersionPass(dispComp, sourceComp, 'Glass B', 'b',
                    baseDisp + ' * (1 - ' + spread + ')', null, diagnostics);
                addDispersionPass(dispComp, sourceComp, 'Glass G', 'g',
                    baseDisp, BlendingMode.ADD, diagnostics);
                addDispersionPass(dispComp, sourceComp, 'Glass R', 'r',
                    baseDisp + ' * (1 + ' + spread + ')', BlendingMode.ADD, diagnostics);

                // Bump map: the same rounded pill with an inner shadow rim, which
                // is the height map CC Glass reads. Ends up on top, eye off.
                var bump = addGlassPill(dispComp, 'Mask', diagnostics);
                tryRun(function () { bump.layer.enabled = false; }, 'bump eye off', diagnostics);
                tryRun(function () {
                    var is = addLayerStyle(bump.layer, 'Inner Shadow', 'innerShadow');
                    if (is) {
                        tryPropSet(is, 'Blend Mode', 1, 5);
                        tryPropSet(is, 'Opacity', 2, 88);
                        tryPropSet(is, 'Color', 3, [0, 0, 0]);
                        tryPropSet(is, 'Use Global Light', 4, false);
                        tryPropSet(is, 'Distance', 6, 7);
                        tryPropSet(is, 'Choke', 7, 0);
                        tryPropSet(is, 'Size', 8, 0);
                        var expr = ctrlExpr('Light') + ' + 165';
                        try { is.property('Angle').expression = expr; }
                        catch (e) { is.property(5).expression = expr; }
                    }
                }, 'bump inner shadow', diagnostics);
                tryRun(function () {
                    for (var n = 1; n <= dispComp.numLayers; n++) {
                        var l = dispComp.layer(n);
                        if (l.name.indexOf('Glass ') !== 0) continue;
                        var g = l.property('ADBE Effect Parade').property('CC Glass');
                        try { g.property('CC Glass-0002').setValue(bump.layer.index); } catch (e) {}
                    }
                }, 'point bump maps', diagnostics);

                // 4. Back in the user's comp, bottom-up so the final order is
                //    Light / Frost / Glass Pro / Shadow / Source.
                var shadow = addGlassPill(comp, 'Shadow', diagnostics);
                tryRun(function () {
                    var ds = shadow.layer.property('ADBE Effect Parade').addProperty('ADBE Drop Shadow');
                    try { ds.property(1).setValue([0, 0, 0]); } catch (e) {}
                    try { ds.property(2).setValue(147); } catch (e) {}
                    try { ds.property(3).expression = ctrlExpr('Light') + ' + 180'; } catch (e) {}
                    try { ds.property(4).setValue(17);  } catch (e) {}
                    try { ds.property(5).setValue(21);  } catch (e) {}
                    try { ds.property(6).setValue(1);   } catch (e) {} // Shadow Only
                }, 'pro drop shadow', diagnostics);

                // The dispersed refraction, masked to the card. NOT parented -
                // the mask follows the null instead, so the image stays put.
                var glassPro = comp.layers.add(dispComp);
                glassPro.name = 'Glass Pro';
                tryRun(function () {
                    var m = glassPro.property('ADBE Mask Parade').addProperty('ADBE Mask Atom');
                    bindGlassMaskShapeAtNull(m, diagnostics);
                }, 'glass pro mask', diagnostics);

                // Frost sits ABOVE the refraction so it blurs the dispersed result.
                var frost = comp.layers.addSolid([0, 0, 0], 'Frost', comp.width, comp.height, comp.pixelAspect, comp.duration);
                tryRun(function () { frost.adjustmentLayer = true; }, 'frost adjustment', diagnostics);
                tryRun(function () {
                    var m = frost.property('ADBE Mask Parade').addProperty('ADBE Mask Atom');
                    bindGlassMaskShapeAtNull(m, diagnostics);
                }, 'frost mask', diagnostics);
                tryRun(function () {
                    var fx = frost.property('ADBE Effect Parade');
                    var gb = fx.addProperty('ADBE Gaussian Blur 2');
                    try { gb.property(1).expression = '3.5 * (' + ctrlExpr('Frost') + ')'; } catch (e) {}
                    try { gb.property(3).setValue(1); } catch (e) {}
                    var nz = fx.addProperty('ADBE Noise2');
                    try { nz.property(1).setValue(1); } catch (e) {}
                }, 'frost blur+noise', diagnostics);

                var light = addGlassPill(comp, 'Light', diagnostics);
                tryRun(function () {
                    var fx = light.layer.property('ADBE Effect Parade');
                    var fill = fx.addProperty('ADBE Fill');
                    try { fill.property('ADBE Fill-0002').setValue([0, 0, 0, 1]); } catch (e) {
                        try { fill.property('ADBE Fill-0002').setValue([0, 0, 0]); } catch (e2) {}
                    }
                    var s1 = fx.addProperty('CC Light Sweep');
                    try { s1.property('CC Light Sweep-0002').expression = ctrlExpr('Light') + ' + 15'; } catch (e) {}
                    try { s1.property('CC Light Sweep-0004').setValue(76); } catch (e) {}
                    try { s1.property('CC Light Sweep-0005').expression = '0.075 * (' + ctrlExpr('Light Intensity') + ')'; } catch (e) {}
                    try { s1.property('CC Light Sweep-0006').setValue(85); } catch (e) {}
                    try { s1.property('CC Light Sweep-0009').setValue(3);  } catch (e) {} // Cutout
                    var s2 = fx.addProperty('CC Light Sweep');
                    try { s2.property('CC Light Sweep-0002').expression = ctrlExpr('Light') + ' + 185'; } catch (e) {}
                    try { s2.property('CC Light Sweep-0004').setValue(76); } catch (e) {}
                    try { s2.property('CC Light Sweep-0005').setValue(0);  } catch (e) {}
                    try { s2.property('CC Light Sweep-0006').expression = '0.4125 * (' + ctrlExpr('Light Intensity') + ')'; } catch (e) {}
                    try { s2.property('CC Light Sweep-0009').setValue(1);  } catch (e) {} // Add
                    var glow = fx.addProperty('ADBE Glo2');
                    try { glow.property('Glow Radius').expression = '2.425 * (' + ctrlExpr('Light Intensity') + ')'; } catch (e) {}
                    try { glow.property('Glow Intensity').setValue(1.2); } catch (e) {}
                    try { glow.property('Glow Colors').setValue(2); } catch (e) {}
                    try { glow.property('Color A').setValue(glowRGB); } catch (e) {}
                    try { glow.property('Color B').setValue(glowRGB); } catch (e) {}
                }, 'pro light', diagnostics);

                tryRun(function () {
                    light.layer.parent  = controls;
                    shadow.layer.parent = controls;
                }, 'parent pro pills', diagnostics);

                // Tag everything so the existing one-click Remove can strip it.
                tryRun(function () {
                    pfxTagLayer(glassPro);
                    pfxTagLayer(frost);
                }, 'tag pro layers', diagnostics);

                // Keep the project panel tidy.
                tryRun(function () {
                    var folder = app.project.items.addFolder('PineappleFX Glass Pro');
                    sourceComp.parentFolder = folder;
                    dispComp.parentFolder = folder;
                }, 'group project items', diagnostics);

                return ok({
                    layers: comp.numLayers,
                    preset: 'liquid-glass-pro',
                    source: GLASS_SOURCE_NAME,
                    dispersion: GLASS_DISP_NAME,
                    diagnostics: diagnostics
                });
            } finally {
                app.endUndoGroup();
            }
        } catch (e) { return err(e); }
    };

    var REAL_GLASS_META = {
        'liquid-glass': {
            label: 'Liquid Glass',
            // Figma-parity defaults. The multipliers where these are consumed
            // are tuned so THESE values reproduce the reference rig exactly.
            defaults: {
                width: 312, height: 186, corner: 99, glowColor: '#ffffff',
                lightAngle: -45, lightIntensity: 80, refraction: 80,
                depth: 20, dispersion: 50, frost: 4, splay: 0
            }
        },
        'liquid-glass-pro': {
            label: 'Liquid Glass Pro',
            // Same controls; the difference is the rig, not the defaults.
            defaults: {
                width: 312, height: 186, corner: 99, glowColor: '#ffffff',
                lightAngle: -45, lightIntensity: 80, refraction: 80,
                depth: 20, dispersion: 50, frost: 4, splay: 0
            }
        }
    };


    // ---- Anamorphic Streak (native-only) --------------------------------
    // Cinematic horizontal blue light streaks with zero third-party effects:
    //   1) ADBE Glo2 with Glow Dimensions = Horizontal, tinted blue, blooms
    //      bright highlights sideways (proven Glo2 stack: Threshold/Radius/
    //      Intensity/Colors/Color A/Color B, all set by name).
    //   2) ADBE Box Blur2 with Blur Dimensions = Horizontal, smears those
    //      highlights into a long streak along X.
    //   3) ADBE Tint (low blend) so the streak reads cool blue.
    // Additive: nothing is precomposed. AE defaults keep the glow On Top so
    // the base pixels stay visible.
    function buildStyleAnamorphic(layer, params) {
        var intensity = +params.intensity || 60;   // 0-100
        var width     = +params.width     || 60;   // streak length driver
        var threshold = +params.threshold || 55;   // 0-100 -> Glow Threshold %
        var color     = colorFromAny(params.color || '#4da6ff');

        var fx = layer.property('ADBE Effect Parade');

        // 0) Wave Warp FIRST (renders before the glow): the flowing "northern
        //    lights" ripple that animates the streak. Sine, height 64, width 40,
        //    direction 23, speed 0.5, pinning None.
        var ww = fx.addProperty('ADBE Wave Warp');
        try { ww.property('ADBE Wave Warp-0001').setValue(1);   } catch (e) {} // Wave Type = Sine
        try { ww.property('ADBE Wave Warp-0002').setValue(64);  } catch (e) {} // Wave Height
        try { ww.property('ADBE Wave Warp-0003').setValue(40);  } catch (e) {} // Wave Width
        try { ww.property('ADBE Wave Warp-0004').setValue(23);  } catch (e) {} // Direction
        try { ww.property('ADBE Wave Warp-0005').setValue(0.5); } catch (e) {} // Wave Speed
        try { ww.property('ADBE Wave Warp-0006').setValue(1);   } catch (e) {} // Pinning = None

        // 1) Horizontal Glow (ADBE Glo2). Radius scales with the streak width.
        //    Only the properties proven to work on the existing Glo2 usage are
        //    set by name; Glow Dimensions (Horizontal) is the one extra real
        //    property the anamorphic look needs. tryPropSet is name-first with
        //    a numeric fallback and no-ops safely if a name/index is absent.
        var glow;
        try { glow = fx.addProperty('ADBE Glo2'); }
        catch (e) { throw new Error('Anamorphic: Glow (ADBE Glo2) not available'); }
        var glowRadius = 12 + width * 3.2;                 // width 0->12, 100->332
        var glowInt    = 0.6 + (intensity / 100) * 2.6;    // 0.6 .. 3.2
        tryPropSet(glow, 'Glow Threshold', 2, threshold);  // percent
        tryPropSet(glow, 'Glow Radius', 3, glowRadius);
        tryPropSet(glow, 'Glow Intensity', 4, glowInt);
        tryPropSet(glow, 'Glow Colors', 7, 2);             // A & B Colors
        tryPropSet(glow, 'Color A', 12, color);
        // Two colors + Triangle looping = the aurora color blend. The MOTION
        // comes from the Wave Warp above, not an animated phase.
        tryPropSet(glow, 'Color B', 13, [color[0] * 0.35, Math.min(1, color[1] + 0.15), 1]);
        tryPropSet(glow, 'Color Looping', 8, 3);           // Triangle A>B>A
        tryPropSet(glow, 'Glow Based On', 1, 2);           // Color Channels
        tryPropSet(glow, 'Composite Original', 5, 2);      // Behind
        tryPropSet(glow, 'Glow Dimensions', 14, 2);        // 1=H&V, 2=Horizontal, 3=Vertical

        // 2) Horizontal Box Blur (ADBE Box Blur2) to stretch highlights into a
        //    streak. property(1)=Radius, (2)=Dimensions, (3)=Iterations,
        //    (4)=Repeat Edge Pixels (matches existing Box Blur2 usage).
        var blur = fx.addProperty('ADBE Box Blur2');
        var blurRadius = 6 + width * 1.6;                  // width 0->6, 100->166
        tryPropSet(blur, 'Blur Radius', 1, blurRadius);
        tryPropSet(blur, 'Blur Dimensions', 2, 2);         // 1=H&V, 2=Horizontal, 3=Vertical
        try { blur.property(3).setValue(3); } catch (e) {} // Iterations (softer smear)
        tryPropSet(blur, 'Repeat Edge Pixels', 4, 1);

        // 3) Cool-blue Tint (ADBE Tint) at low blend so the streak reads blue.
        //    property(1)=Map Black To, (2)=Map White To, (3)=Amount to Tint (%).
        var tint = fx.addProperty('ADBE Tint');
        try { tint.property(1).setValue([0, 0, 0]); } catch (e) {}     // Map Black To
        try { tint.property(2).setValue(color); } catch (e) {}         // Map White To -> blue
        var tintAmt = 12 + (intensity / 100) * 20;         // 12 .. 32 %
        tryPropSet(tint, 'Amount to Tint', 3, tintAmt);
    }

    // ---- Bloom (companion, native-only) ---------------------------------
    // Soft omnidirectional highlight bloom: a single ADBE Glo2 in H&V mode,
    // keeping the original colors. Uses only the proven Glo2 properties plus
    // Glow Dimensions. AE defaults keep the glow On Top, base pixels preserved.
    function buildStyleBloom(layer, params) {
        var intensity = +params.intensity || 55;
        var radius    = +params.radius    || 40;
        var threshold = +params.threshold || 60;

        var fx = layer.property('ADBE Effect Parade');
        var glow;
        try { glow = fx.addProperty('ADBE Glo2'); }
        catch (e) { throw new Error('Bloom: Glow (ADBE Glo2) not available'); }
        var glowInt = 0.5 + (intensity / 100) * 2.2;       // 0.5 .. 2.7
        tryPropSet(glow, 'Glow Threshold', 2, threshold);
        tryPropSet(glow, 'Glow Radius', 3, radius);
        tryPropSet(glow, 'Glow Intensity', 4, glowInt);
        tryPropSet(glow, 'Glow Colors', 7, 1);             // Original Colors (natural bloom)
        tryPropSet(glow, 'Glow Dimensions', 14, 1);        // H & V
    }



    // ---- Elastic In - Bounce Up PLUS a scale pop. Each character springs up
    //      from below AND scales down from `scaleFrom`% to 100% at the same
    //      time, riding ONE damped-cosine spring. Position 3D and Scale 3D are
    //      added to the same animator, so the single Expressible selector amount
    //      (set by setBounceAmount) drives both: they overshoot and settle in
    //      lockstep, giving a real elastic entrance. The setBounceAmount clamp
    //      keeps the scale amount from ever crossing 0 (which would mirror the
    //      glyphs).
    function buildElasticIn(textLayer, params) {
        var duration  = +params.duration || 0.8;
        var distance  = (+params.distance || 60) * PFX_DIST_MUL;
        var scaleFrom = isNaN(+params.scaleFrom) ? 200 : +params.scaleFrom;
        var freq      = +params.freq || 3;
        var decay     = +params.decay || 6;
        var delayF    = +params.delayFrames || 1.8;
        setAnchorGroupingCentered(textLayer, 1); // per-character: spring + scale from each glyph's center
        // Per-glyph fade synced to the spring cadence, same as Bounce Up.
        addExprFade(textLayer, Math.min(0.3, duration * 0.45), delayF, 'char', null);
        var made = makeSpringAnimator(textLayer, 'PineappleFX · Elastic In');
        addAnimatorVal(made.anim, 'ADBE Text Position 3D', [0, distance, 0]);
        addAnimatorVal(made.anim, 'ADBE Text Scale 3D', [scaleFrom, scaleFrom, 100]);
        setBounceAmount(made.sel, freq, decay, delayF, duration, 'char', null);
    }

    // ---- Wave - continuous per-character sine ripple. Looping idle motion, no
    //      in/out. Position 3D expression on an Expressible Selector amount=100
    //      selector (so textIndex is in scope). Each glyph is phase-shifted by
    //      `spread` degrees, so the wave visibly travels along the line. Because
    //      it is a pure time-based sine it loops seamlessly forever. Mirrors the
    //      per-character branch of buildSoftBounce exactly.
    function buildWave(textLayer, params) {
        var height = (+params.height || 18) * PFX_DIST_MUL;
        var speed  = +params.speed || 1;
        var spread = +params.spread || 40; // degrees of phase per character
        setAnchorGroupingCentered(textLayer, 1);
        var animators = textLayer.property('ADBE Text Properties')
                                 .property('ADBE Text Animators');
        var anim = animators.addProperty('ADBE Text Animator');
        anim.name = 'PineappleFX · Wave';
        var sels = anim.property('ADBE Text Selectors');
        while (sels.numProperties > 0) { try { sels.property(1).remove(); } catch (e) { break; } }
        var esel = sels.addProperty('ADBE Text Expressible Selector');
        // The per-character sine MUST live on the SELECTOR amount: textIndex /
        // textTotal are only defined here, not on the animator Position (that is
        // why the old version, with textIndex on Position, did nothing). The
        // selector oscillates -100..100 per glyph and scales the Y offset below.
        var selExpr =
            'speed = ' + speed + '; spread = ' + spread + ';\n' +
            'phase = (textIndex - 1) * spread * Math.PI / 180;\n' +
            'Math.sin(time * 2 * Math.PI * speed - phase) * 100;';
        try {
            var amt = esel.property('ADBE Text Expressible Amount');
            amt.expression = selExpr; amt.expressionEnabled = true;
        } catch (e) {}
        var pp = anim.property('ADBE Text Animator Properties').addProperty('ADBE Text Position 3D');
        try { pp.setValue([0, -height, 0]); } catch (e) {}
    }

    // ---- Scramble / Decode - Source Text expression. Characters resolve left to
    //      right from random glyphs to the final text. Same mechanism as
    //      buildNumberCounter (drive the sourceText property with an expression).
    //      The final string is baked into the expression as a literal so the
    //      reveal is deterministic per character and spaces stay untouched.
    function buildScramble(textLayer, params) {
        var duration = +params.duration || 1.4;
        var rate     = +params.rate || 16;
        var target   = readSourceText(textLayer);
        // Encode the final string as an ES3 source literal so it survives inside
        // the expression string (handles quotes, backslashes, newlines safely).
        var lit = jsonStringLiteral(target);
        var expr =
            '// PineappleFX: Scramble\n' +
            'final = ' + lit + ';\n' +
            'dur = ' + duration + ';\n' +
            'rate = ' + rate + ';\n' +
            'chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#%&@";\n' +
            'nowT = time - inPoint;\n' +
            'total = final.length;\n' +
            'progress = dur > 0 ? nowT / dur : 1;\n' +
            'resolved = Math.floor(linear(progress, 0, 1, 0, total));\n' +
            'seedRandom(Math.floor(nowT * rate), true);\n' +
            'out = "";\n' +
            'for (i = 0; i < total; i++) {\n' +
            '  c = final.charAt(i);\n' +
            '  if (i < resolved || c === " " || c === "\\n" || c === "\\r" || c === "\\t") {\n' +
            '    out += c;\n' +
            '  } else {\n' +
            '    out += chars.charAt(Math.floor(random(0, chars.length)));\n' +
            '  }\n' +
            '}\n' +
            'out;';
        var sourceTextProp = getSourceText(textLayer);
        if (!sourceTextProp) throw new Error('Could not access sourceText');
        sourceTextProp.expression = expr;
        sourceTextProp.expressionEnabled = true;
    }



    // Encode an arbitrary string as an ES3 double-quoted source literal so it
    // can be embedded verbatim inside an expression string. ExtendScript has no
    // reliable JSON global, so we escape by hand: backslash, double-quote, and
    // the control whitespace chars that would break a single-line literal.
    function jsonStringLiteral(str) {
        var s = String(str == null ? '' : str);
        var out = '"';
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i);
            if (c === '\\') out += '\\\\';
            else if (c === '"') out += '\\"';
            else if (c === '\n') out += '\\n';
            else if (c === '\r') out += '\\r';
            else if (c === '\t') out += '\\t';
            else out += c;
        }
        return out + '"';
    }


    var GLASS_META = {
        'frosted-card': {
            label: 'Frosted Card',
            defaults: { width: 400, height: 260, radius: 18, fillOpacity: 22, strokeOpacity: 35, blurAmount: 32 }
        },
        'notification': {
            label: 'Notification',
            defaults: { width: 420, height: 90, radius: 22, fillOpacity: 26, strokeOpacity: 32, blurAmount: 24 }
        },
        'glass-button': {
            label: 'Glass Button',
            defaults: { width: 160, height: 44, radius: 22, fillOpacity: 28, strokeOpacity: 40, blurAmount: 18 }
        }
    };
    // ===================================================================
    // Package A / A+ - "Liquid Color" signature text fill.
    //
    // Turns the SELECTED text layer into a precomp where the text glyphs are
    // filled by a scattered field of 6 blurred gradient polystars, sharpened
    // into liquid color. A+ adds a Wave Warp that swirls the field.
    //
    // Public entry points:
    //   pineapplefx_apply_text_color(args)     - build it (args.params.wave = A+)
    //   pineapplefx_text_color_shuffle(args)   - re-randomize the 6 stars in place
    //
    // Structure created inside precomp "PineappleFX Color <name>":
    //   L3 (bottom) "PineappleFX Color Field"  SHAPE  - 6 gradient polystars + Fast
    //                                               Box Blur; matted BY the text
    //   L2         "<text> matte"          TEXT   - alpha track-matte source
    //   L1 (top)   "<text> shadow"         TEXT   - faint Drop Shadow (shadow
    //                                               only) copy for depth
    // Precomp layer gets Sharpen + Unsharp Mask + Glow. The precomp replaces
    // the original text layer in the user's comp (same position/anchor/scale).
    // ===================================================================

    var PINEAPPLEFX_COLOR_FIELD_NAME = 'PineappleFX Color Field';

    // Random float in [lo, hi).
    function pfxRand(lo, hi) { return lo + Math.random() * (hi - lo); }
    function pfxRandInt(lo, hi) { return Math.floor(pfxRand(lo, hi + 1)); }

    // HSV -> RGB, all components 0..1. Used to keep shuffled colors VIVID:
    // we sample hue fully random but pin saturation/value high.
    function pfxHsvToRgb(h, s, v) {
        var i = Math.floor(h * 6);
        var f = h * 6 - i;
        var p = v * (1 - s);
        var q = v * (1 - f * s);
        var t = v * (1 - (1 - f) * s);
        var r, g, b;
        switch (i % 6) {
            case 0: r = v; g = t; b = p; break;
            case 1: r = q; g = v; b = p; break;
            case 2: r = p; g = v; b = t; break;
            case 3: r = p; g = q; b = v; break;
            case 4: r = t; g = p; b = v; break;
            default: r = v; g = p; b = q; break;
        }
        return [r, g, b];
    }

    // One vivid random color: full-random hue, high saturation/value.
    function pfxVividColor() {
        return pfxHsvToRgb(Math.random(), pfxRand(0.72, 1.0), pfxRand(0.85, 1.0));
    }

    // Build the flat gradient-stops array AE's "ADBE Vector Grad Colors"
    // (CUSTOM_VALUE) expects:
    //   [ nColorStops, (pos,r,g,b)*n , nAlphaStops, (pos,mid,opacity)*m ]
    // 2-3 vivid stops, evenly spaced, all opaque.
    function pfxRandomGradientValue() {
        var n = pfxRandInt(2, 3);
        var arr = [n];
        for (var i = 0; i < n; i++) {
            var pos = (n === 1) ? 0 : (i / (n - 1));
            var c = pfxVividColor();
            arr.push(pos, c[0], c[1], c[2]);
        }
        // Two fully-opaque alpha stops (start + end).
        arr.push(2, 0, 0.5, 1, 1, 0.5, 1);
        return arr;
    }

    // Scatter position for a polystar group, in the shape layer's local space
    // (origin [0,0] = comp center, shared with the text). bounds = {l,t,w,h} of
    // the TEXT glyph box; stars stay NEAR the text with a small margin, never
    // across the whole comp.
    function pfxScatterPos(bounds, index, count) {
        // Distribute EVENLY across the text width (one star per slot, jittered)
        // so long text is covered along its whole length, then jitter in Y.
        var padX = bounds.w * 0.10 + 18;
        var padY = bounds.h * 0.35 + 12;
        var x0 = bounds.l - padX, x1 = bounds.l + bounds.w + padX;
        var slot = (x1 - x0) / count;
        var cx = x0 + slot * (index + pfxRand(0.2, 0.8));
        var cy = pfxRand(bounds.t - padY, bounds.t + bounds.h + padY);
        return [cx, cy];
    }

    // Give a star's contents a random vivid GRADIENT fill, robustly: set the
    // flat gradient-colors array, then READ IT BACK. Some AE versions silently
    // ignore the "ADBE Vector Grad Colors" setValue and leave the default
    // black->white; if the read-back does not match, fall back to a solid vivid
    // fill so a star is NEVER black-and-white.
    function pfxSetStarGradient(contents) {
        var gfill = null;
        try { gfill = contents.property('ADBE Vector Graphic - G-Fill'); } catch (e) {}
        var gv = pfxRandomGradientValue();
        var applied = false;
        if (gfill) {
            try {
                gfill.property('ADBE Vector Grad Type').setValue(1); // Linear
                gfill.property('ADBE Vector Grad Start Pt').setValue([pfxRand(-90, 90), pfxRand(-90, 90)]);
                gfill.property('ADBE Vector Grad End Pt').setValue([pfxRand(-90, 90), pfxRand(-90, 90)]);
                gfill.property('ADBE Vector Grad Colors').setValue(gv);
                var rb = gfill.property('ADBE Vector Grad Colors').value;
                if (rb && rb.length >= 5) {
                    var diff = Math.abs(rb[2] - gv[2]) + Math.abs(rb[3] - gv[3]) + Math.abs(rb[4] - gv[4]);
                    if (diff < 0.2) applied = true;
                }
            } catch (e) { applied = false; }
        }
        if (!applied) {
            try { if (gfill) gfill.remove(); } catch (e) {}
            try {
                var sf = contents.addProperty('ADBE Vector Graphic - Fill');
                var c = pfxVividColor();
                sf.property('ADBE Vector Fill Color').setValue([c[0], c[1], c[2]]);
                sf.property('ADBE Vector Fill Opacity').setValue(100);
            } catch (e) {}
        }
    }

    // Push a fresh set of random values into one existing Polystar group.
    // Star SIZE tracks the text HEIGHT so stars cover the text vertically;
    // sizePct (0-160) scales it. index/count drive the even scatter.
    function pfxRandomizeStar(group, bounds, index, count, sizePct) {
        var contents = group.property('ADBE Vectors Group');

        var base = bounds.h;
        if (base < 30) base = (bounds.w + bounds.h) * 0.25;
        if (base < 24) base = 24;
        var scale = (sizePct !== undefined ? sizePct : 100) / 100;

        var star = contents.property('ADBE Vector Shape - Star');
        if (star) {
            try { star.property('ADBE Vector Star Points').setValue(pfxRandInt(5, 8)); } catch (e) {}
            try { star.property('ADBE Vector Star Rotation').setValue(pfxRand(0, 360)); } catch (e) {}
            var outer = base * pfxRand(0.7, 1.15) * scale;
            var inner = outer * pfxRand(0.45, 0.85);
            try { star.property('ADBE Vector Star Inner Radius').setValue(inner); } catch (e) {}
            try { star.property('ADBE Vector Star Outer Radius').setValue(outer); } catch (e) {}
        }

        pfxSetStarGradient(contents);

        var tr = group.property('ADBE Vector Transform Group');
        if (tr) {
            try { tr.property('ADBE Vector Position').setValue(pfxScatterPos(bounds, index, count)); } catch (e) {}
            try { tr.property('ADBE Vector Rotation').setValue(pfxRand(0, 360)); } catch (e) {}
        }
    }

    // Create a single polystar group (star path + gradient fill) inside the
    // shape layer's root Vectors Group, then randomize it.
    function pfxAddStarGroup(rootVectors, bounds, index, count, sizePct) {
        var group = rootVectors.addProperty('ADBE Vector Group');
        group.name = 'Polystar ' + (index + 1);
        var contents = group.property('ADBE Vectors Group');
        contents.addProperty('ADBE Vector Shape - Star');
        // Gradient fill AFTER the star so it fills the star path.
        var gfill = contents.addProperty('ADBE Vector Graphic - G-Fill');
        try { gfill.property('ADBE Vector Fill Opacity').setValue(100); } catch (e) {}
        pfxRandomizeStar(group, bounds, index, count, sizePct);
        return group;
    }

    // Locate the shape layer's ROOT vectors group ("Contents").
    function pfxRootVectors(shapeLayer) {
        return shapeLayer.property('ADBE Root Vectors Group');
    }

    // Find the color-field shape layer inside a precomp by name.
    function pfxFindColorField(precomp) {
        for (var i = 1; i <= precomp.numLayers; i++) {
            var l = precomp.layer(i);
            if (l.name === PINEAPPLEFX_COLOR_FIELD_NAME && (l instanceof ShapeLayer)) return l;
        }
        return null;
    }

    // Text glyph box in the field's local (comp-centered) space via sourceRect.
    // The matte text sits at comp center with anchor [0,0]; the field shape
    // shares that origin, so the glyph rect maps directly to star scatter coords.
    function pfxTextBounds(textLayer, comp) {
        try {
            var r = textLayer.sourceRectAtTime(0, false);
            if (r && r.width > 0 && r.height > 0) {
                return { l: r.left, t: r.top, w: r.width, h: r.height };
            }
        } catch (e) {}
        var w = comp.width * 0.32, h = comp.height * 0.16;
        return { l: -w / 2, t: -h / 2, w: w, h: h };
    }

    // Find the alpha-matte text layer inside a color-field precomp.
    function pfxFindMatteText(comp) {
        for (var i = 1; i <= comp.numLayers; i++) {
            var l = comp.layer(i);
            if ((l instanceof TextLayer) && String(l.name).indexOf(' matte') >= 0) return l;
        }
        for (var j = 1; j <= comp.numLayers; j++) {
            if (comp.layer(j) instanceof TextLayer) return comp.layer(j);
        }
        return null;
    }

    // Build (or rebuild) the 6 scattered gradient stars in a shape layer,
    // scattered + sized to the given text glyph box (bounds = {l,t,w,h}).
    function pfxBuildColorField(shapeLayer, bounds, count, sizePct) {
        var root = pfxRootVectors(shapeLayer);
        // Clear any existing groups so shuffle is a clean regenerate.
        while (root.numProperties > 0) {
            try { root.property(root.numProperties).remove(); } catch (e) { break; }
        }
        var n = count || 8;
        for (var i = 0; i < n; i++) pfxAddStarGroup(root, bounds, i, n, sizePct);
    }

    // Add/refresh the Fast Box Blur (radius 48, iter 3) on the shape layer.
    function pfxEnsureFieldBlur(shapeLayer, blurAmt) {
        var fx = shapeLayer.property('ADBE Effect Parade');
        var blur = null;
        try { blur = fx.property('PineappleFX Field Blur'); } catch (e) {}
        if (!blur) {
            blur = fx.addProperty('ADBE Box Blur2');
            blur.name = 'PineappleFX Field Blur';
        }
        try { blur.property('ADBE Box Blur2-0001').setValue(blurAmt !== undefined ? blurAmt : 90); } catch (e) {} // Blur Radius
        try { blur.property('ADBE Box Blur2-0002').setValue(3); } catch (e) {}  // Iterations
        try { blur.property('ADBE Box Blur2-0004').setValue(1); } catch (e) {}  // Repeat Edge
    }

    // Add or update the A+ Wave Warp on the shape layer. wp = params object.
    function pfxApplyWaveWarp(shapeLayer, wp) {
        var fx = shapeLayer.property('ADBE Effect Parade');
        var ww = null;
        try { ww = fx.property('PineappleFX Wave'); } catch (e) {}
        if (!ww) {
            ww = fx.addProperty('ADBE Wave Warp');
            ww.name = 'PineappleFX Wave';
        }
        wp = wp || {};
        // Wave Warp props: 1 Type, 2 Height, 3 Width, 4 Direction, 5 Speed.
        try { ww.property('ADBE Wave Warp-0001').setValue(+wp.waveType   || 7); } catch (e) {}
        try { ww.property('ADBE Wave Warp-0002').setValue(wp.waveHeight    !== undefined ? +wp.waveHeight    : 203); } catch (e) {}
        try { ww.property('ADBE Wave Warp-0003').setValue(wp.waveWidth     !== undefined ? +wp.waveWidth     : 72.5); } catch (e) {}
        try { ww.property('ADBE Wave Warp-0004').setValue(wp.waveDirection !== undefined ? +wp.waveDirection : 29); } catch (e) {}
        try { ww.property('ADBE Wave Warp-0005').setValue(wp.waveSpeed     !== undefined ? +wp.waveSpeed     : 0.21); } catch (e) {}
        return ww;
    }

    function pfxRemoveWaveWarp(shapeLayer) {
        try {
            var ww = shapeLayer.property('ADBE Effect Parade').property('PineappleFX Wave');
            if (ww) ww.remove();
        } catch (e) {}
    }

    // Add the precomp-level look: Sharpen 45 + Unsharp Mask (25/25) + Glow 161.
    function pfxAddPrecompLook(precompLayer, glowAmt) {
        var fx = precompLayer.property('ADBE Effect Parade');

        var sharp = fx.addProperty('ADBE Sharpen');
        try { sharp.property('ADBE Sharpen-0001').setValue(45); } catch (e) {}

        var um = fx.addProperty('ADBE Unsharp Mask2');
        try { um.property('ADBE Unsharp Mask2-0001').setValue(25); } catch (e) {} // Amount
        try { um.property('ADBE Unsharp Mask2-0002').setValue(25); } catch (e) {} // Radius
        try { um.property('ADBE Unsharp Mask2-0003').setValue(0);  } catch (e) {} // Threshold

        var g = (glowAmt !== undefined ? glowAmt : 55) / 100;
        var glow = fx.addProperty('ADBE Glo2');
        try { glow.property('ADBE Glo2-0003').setValue(100 + g * 180); } catch (e) {} // Glow Radius 100..280
        try { glow.property('ADBE Glo2-0004').setValue(0.2 + g * 0.9); } catch (e) {} // Glow Intensity
        try { glow.property('ADBE Glo2-0002').setValue(106); } catch (e) {}  // Glow Threshold
    }

    // Copy the text document (font/size/fill) from a source layer onto a target
    // text layer, then set its string. Keeps the user's own typeface.
    function pfxCloneTextDoc(sourceDoc, targetLayer, str) {
        var sp = getSourceText(targetLayer);
        if (!sp) return;
        var doc = sp.value;
        try { if (sourceDoc.font) doc.font = sourceDoc.font; } catch (e) {}
        try { doc.fontSize = sourceDoc.fontSize; } catch (e) {}
        try { doc.fillColor = [1, 1, 1]; doc.applyFill = true; } catch (e) {}
        try { doc.tracking = sourceDoc.tracking; } catch (e) {}
        try { doc.justification = sourceDoc.justification; } catch (e) {}
        try { doc.text = str; } catch (e) {}
        sp.setValue(doc);
    }

    // -------------------------------------------------------------------
    // pineapplefx_apply_text_color - initial build on the selected text layer.
    // args = { params: { wave: bool, waveType, waveHeight, waveWidth,
    //                    waveDirection, waveSpeed } }
    // -------------------------------------------------------------------
    $.global.pineapplefx_apply_text_color = function (args) {
        try {
            args = args || {};
            var params = args.params || {};
            var wantWave = !!params.wave;
            var pCount = params.count !== undefined ? Math.round(+params.count) : 8;
            if (pCount < 3) pCount = 3; if (pCount > 16) pCount = 16;
            var pBlur = params.blur !== undefined ? +params.blur : 90;
            var pSize = params.size !== undefined ? +params.size : 100;
            var pGlow = params.glow !== undefined ? +params.glow : 55;

            var comp = activeComp();
            if (!comp) return err('Open a composition first');

            var layers = comp.selectedLayers;
            if (!layers || layers.length === 0) return err('Select a text layer');

            // Use the first selected TEXT layer.
            var srcLayer = null;
            for (var i = 0; i < layers.length; i++) {
                if (layers[i] instanceof TextLayer) { srcLayer = layers[i]; break; }
            }
            if (!srcLayer) return err('Select a text layer');

            var srcDoc = getSourceText(srcLayer).value;
            var str = readSourceText(srcLayer) || 'PineappleFX';

            app.beginUndoGroup('PineappleFX: Text Color' + (wantWave ? ' A+' : ''));
            try {
                // 1. New precomp, comp-sized, matching the user's comp settings.
                var precomp = app.project.items.addComp(
                    'PineappleFX Color ' + str,
                    comp.width, comp.height, comp.pixelAspect,
                    comp.duration, comp.frameRate
                );

                // 2. Color field shape layer (bottom). Anchor [0,0], sits at
                //    comp center so scatter coords are frame-centered. Content is
                //    built AFTER the matte text so stars size/scatter to the box.
                var shape = precomp.layers.addShape();
                shape.name = PINEAPPLEFX_COLOR_FIELD_NAME;
                try { shape.property('ADBE Transform Group').property('ADBE Anchor Point').setValue([0, 0, 0]); } catch (e) {}
                try { shape.property('ADBE Transform Group').property('ADBE Position').setValue([precomp.width / 2, precomp.height / 2, 0]); } catch (e) {}

                // 3. Alpha-matte text (middle). White fill; matte source.
                var matteText = precomp.layers.addText(str);
                matteText.name = str + ' matte';
                pfxCloneTextDoc(srcDoc, matteText, str);
                try {
                    matteText.property('ADBE Transform Group').property('ADBE Position').setValue([precomp.width / 2, precomp.height / 2, 0]);
                    matteText.property('ADBE Transform Group').property('ADBE Anchor Point').setValue([0, 0, 0]);
                } catch (e) {}

                // Stars sized + scattered to the text glyph box (not the comp).
                var textBounds = pfxTextBounds(matteText, precomp);
                pfxBuildColorField(shape, textBounds, pCount, pSize);
                pfxEnsureFieldBlur(shape, pBlur);
                if (wantWave) pfxApplyWaveWarp(shape, params);

                // 4. Faint shadow-only duplicate (top) for depth.
                var shadowText = precomp.layers.addText(str);
                shadowText.name = str + ' shadow';
                pfxCloneTextDoc(srcDoc, shadowText, str);
                try {
                    shadowText.property('ADBE Transform Group').property('ADBE Position').setValue([precomp.width / 2, precomp.height / 2, 0]);
                    shadowText.property('ADBE Transform Group').property('ADBE Anchor Point').setValue([0, 0, 0]);
                } catch (e) {}
                var sfx = shadowText.property('ADBE Effect Parade');
                var ds = sfx.addProperty('ADBE Drop Shadow');
                try { ds.property('ADBE Drop Shadow-0001').setValue([0, 0, 0]); } catch (e) {} // Shadow Color
                try { ds.property('ADBE Drop Shadow-0002').setValue(13); } catch (e) {}  // Opacity 0-255 (~5%)
                try { ds.property('ADBE Drop Shadow-0003').setValue(135); } catch (e) {} // Direction
                try { ds.property('ADBE Drop Shadow-0004').setValue(6); } catch (e) {}   // Distance
                try { ds.property('ADBE Drop Shadow-0005').setValue(24); } catch (e) {}  // Softness
                try { ds.property('ADBE Drop Shadow-0006').setValue(1); } catch (e) {}   // Shadow Only

                // Stack now (top->bottom): shadow(1), matte(2), field(3).
                //   addShape/addText each insert at top -> current order is
                //   shadow(1), matte(2), field(3) which already satisfies:
                //   field is matted BY matte (matte sits directly above field).
                try { shape.trackMatteType = TrackMatteType.ALPHA; } catch (e) {}

                // 5. Add precomp to the user's comp, aligned to the source layer.
                var pcLayer = comp.layers.add(precomp);
                pcLayer.name = 'PineappleFX Color ' + str;
                pfxAddPrecompLook(pcLayer, pGlow);
                try {
                    var st = srcLayer.property('ADBE Transform Group');
                    var pt = pcLayer.property('ADBE Transform Group');
                    // The precomp is comp-sized with its text centered at the
                    // precomp's center. Anchor the precomp layer at that center,
                    // then position the layer at the source text's position so the
                    // glyphs render exactly where the user's text was (drop-in).
                    pt.property('ADBE Anchor Point').setValue([comp.width / 2, comp.height / 2, 0]);
                    var srcPos = st.property('ADBE Position').value;
                    var pos3 = (srcPos.length === 2) ? [srcPos[0], srcPos[1], 0] : srcPos;
                    pt.property('ADBE Position').setValue(pos3);
                } catch (e) {}

                // Hide the user's original text layer (kept for undo / editing).
                try { srcLayer.enabled = false; } catch (e) {}

                // Move the new precomp layer just above the source for tidiness.
                try { pcLayer.moveBefore(srcLayer); } catch (e) {}
            } finally {
                app.endUndoGroup();
            }

            return ok({ precomp: 'PineappleFX Color ' + str, wave: wantWave, text: str });
        } catch (e) { return err(e); }
    };

    // -------------------------------------------------------------------
    // pineapplefx_text_color_shuffle - re-randomize the 6 stars of the active
    // color field. Works when the user has the precomp layer selected OR the
    // color-field shape layer selected. args.params may carry wave settings to
    // re-apply / toggle. args.params.wave toggles the A+ warp on/off.
    // -------------------------------------------------------------------
    $.global.pineapplefx_text_color_shuffle = function (args) {
        try {
            args = args || {};
            var params = args.params || {};
            var comp = activeComp();
            if (!comp) return err('Open a composition first');

            var layers = comp.selectedLayers;
            if (!layers || layers.length === 0) return err('Select the PineappleFX Color layer');

            // Resolve a target color-field shape + its owning comp.
            var field = null, fieldComp = null;
            for (var i = 0; i < layers.length && !field; i++) {
                var l = layers[i];
                // Case A: the color-field shape is selected directly.
                if (l.name === PINEAPPLEFX_COLOR_FIELD_NAME && (l instanceof ShapeLayer)) {
                    field = l; fieldComp = comp;
                }
                // Case B: a precomp layer whose source contains the field.
                else if (l.source && (l.source instanceof CompItem)) {
                    var f = pfxFindColorField(l.source);
                    if (f) { field = f; fieldComp = l.source; }
                }
            }
            if (!field) return err('Select an PineappleFX Color layer (or its color field)');

            app.beginUndoGroup('PineappleFX: Shuffle Color');
            try {
                var sCount = params.count !== undefined ? Math.round(+params.count) : 8;
                if (sCount < 3) sCount = 3; if (sCount > 16) sCount = 16;
                var sbounds = pfxTextBounds(pfxFindMatteText(fieldComp), fieldComp);
                pfxBuildColorField(field, sbounds, sCount, (params.size !== undefined ? +params.size : 100));
                pfxEnsureFieldBlur(field, (params.blur !== undefined ? +params.blur : 90));
                if (params.wave) pfxApplyWaveWarp(field, params);
                else if (params.wave === false) pfxRemoveWaveWarp(field);
            } finally {
                app.endUndoGroup();
            }
            return ok({ shuffled: true, wave: !!params.wave });
        } catch (e) { return err(e); }
    };


})();
