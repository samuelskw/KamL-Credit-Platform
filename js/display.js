/*
 * Display preferences: text size and colour-vision palettes.
 *
 * Adds an "Aa Display" button to the header that opens a small panel with:
 *   - Text size   : sets --fs, which every font size in the stylesheet is
 *                   multiplied by (inline font sizes in generated HTML are
 *                   scaled directly), without zooming the layout,
 *                   so pages reflow instead of scrolling sideways.
 *   - Dyslexia font: switches the whole page to OpenDyslexic (loaded from
 *                   jsDelivr only when turned on) with extra letter, word
 *                   and line spacing. Ticking "Dyslexia-friendly font" in the
 *                   accessibility survey turns it on too.
 *   - Colour vision: swaps the status colours (good / warning / serious /
 *                   critical) and chart series colours for palettes that stay
 *                   distinguishable with protanopia, deuteranopia, tritanopia
 *                   or no colour vision. Palettes live in css/styles.css under
 *                   :root[data-cvd="…"].
 *
 * Choices are stored in localStorage ("kaml-display").
 *
 * app.js saves get() to the user's Firestore profile (preferences.display)
 * whenever "kaml:display" fires, and calls set() with it after login.
 *
 * API: KamL.display.get(), .set({ scale, cvd, dyslexia }), .open(), .close()
 * Event: "kaml:display" on window with the new preferences as detail.
 */
(function () {
  "use strict";
  var KamL = (window.KamL = window.KamL || {});
  var KEY = "kaml-display";
  var root = document.documentElement;

  var SIZES = [
    { value: 0.9, label: "Smaller" },
    { value: 1, label: "Default" },
    { value: 1.15, label: "Large" },
    { value: 1.3, label: "Larger" },
    { value: 1.5, label: "Largest" }
  ];
  var CVD = [
    { id: "none", label: "Standard colours", desc: "The default palette" },
    { id: "protan", label: "Protanopia", desc: "Red-blind: reds look dark or brown" },
    { id: "deutan", label: "Deuteranopia", desc: "Green-blind: reds and greens look alike" },
    { id: "tritan", label: "Tritanopia", desc: "Blue-yellow: blues and greens look alike" },
    { id: "mono", label: "Monochrome", desc: "No colour: uses shades of grey only" }
  ];
  var DEFAULTS = { scale: 1, cvd: "none", dyslexia: false };

  // ------------------------------------------------------------------
  // Storage
  // ------------------------------------------------------------------
  function load() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || "null");
      if (v && typeof v === "object") return { scale: validScale(v.scale), cvd: validCvd(v.cvd), dyslexia: v.dyslexia === true };
    } catch (e) { /* storage blocked or corrupt */ }
    return null;
  }
  function store(p) {
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) { /* keep in memory only */ }
  }
  function validScale(s) {
    s = Number(s);
    return SIZES.some(function (o) { return o.value === s; }) ? s : 1;
  }
  function validCvd(c) {
    return CVD.some(function (o) { return o.id === c; }) ? c : "none";
  }

  var stored = load();
  var prefs = stored || Object.assign({}, DEFAULTS);

  // ------------------------------------------------------------------
  // Text scaling
  // ------------------------------------------------------------------
  // Every font size in css/styles.css is written as calc(Npx * var(--fs, 1)),
  // so scaling is just setting --fs on <html>. (Reading stylesheet rules from
  // JS isn't an option: Chrome blocks it when the page is opened from disk.)
  var INLINE_ATTR = "data-fs-base";
  function scaleInline(el, scale) {
    var base = el.getAttribute(INLINE_ATTR);
    if (base === null) {
      var m = /^([\d.]+)px$/.exec((el.style.fontSize || "").trim());
      if (!m) return;
      base = m[1];
      el.setAttribute(INLINE_ATTR, base);
    }
    el.style.fontSize = round(parseFloat(base) * scale) + "px";
  }
  function scaleInlineWithin(node, scale) {
    if (node.nodeType !== 1 || node instanceof SVGElement) return;
    if (node.style && node.style.fontSize) scaleInline(node, scale);
    Array.prototype.forEach.call(node.querySelectorAll('[style*="font-size"]'), function (el) {
      if (!(el instanceof SVGElement)) scaleInline(el, scale);
    });
  }
  function round(n) { return Math.round(n * 100) / 100; }

  function applyScale(scale) {
    root.style.setProperty("--fs", String(scale));
    scaleInlineWithin(document.body, scale);
    if (scale === 1) root.removeAttribute("data-fontscale");
    else root.setAttribute("data-fontscale", scale > 1 ? "up" : "down");
  }

  // app.js / voice.js render HTML with inline font sizes after load; catch those.
  var observer = new MutationObserver(function (muts) {
    if (prefs.scale === 1) return;
    muts.forEach(function (m) {
      Array.prototype.forEach.call(m.addedNodes, function (n) { scaleInlineWithin(n, prefs.scale); });
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // ------------------------------------------------------------------
  // Colour vision
  // ------------------------------------------------------------------
  function applyCvd(cvd) {
    if (cvd === "none") root.removeAttribute("data-cvd");
    else root.setAttribute("data-cvd", cvd);
  }

  // ------------------------------------------------------------------
  // Dyslexia-friendly font (styles in css/styles.css under [data-dyslexia])
  // ------------------------------------------------------------------
  function applyDyslexia(on) {
    if (on) root.setAttribute("data-dyslexia", "");
    else root.removeAttribute("data-dyslexia");
  }

  function apply(announce) {
    applyScale(prefs.scale);
    applyCvd(prefs.cvd);
    applyDyslexia(prefs.dyslexia);
    syncPanel();
    if (announce) window.dispatchEvent(new CustomEvent("kaml:display", { detail: get() }));
  }
  function get() { return { scale: prefs.scale, cvd: prefs.cvd, dyslexia: prefs.dyslexia }; }
  function set(p) {
    if (p.scale !== undefined) prefs.scale = validScale(p.scale);
    if (p.cvd !== undefined) prefs.cvd = validCvd(p.cvd);
    if (p.dyslexia !== undefined) prefs.dyslexia = p.dyslexia === true;
    store(prefs);
    apply(true);
  }

  // ------------------------------------------------------------------
  // Panel UI
  // ------------------------------------------------------------------
  var btn, panel;

  function buildButton() {
    btn = document.createElement("button");
    btn.type = "button";
    btn.id = "displayBtn";
    btn.className = "btn ghost sm";
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "displayPanel");
    btn.setAttribute("aria-label", "Text size and colour settings");
    btn.innerHTML = '<span aria-hidden="true">Aa</span> Display';
    var anchor = document.getElementById("themeBtn") || document.getElementById("a11yBtn");
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor);
    else document.body.appendChild(btn);
    btn.addEventListener("click", function () { panel.hidden ? open() : close(); });
  }

  function buildPanel() {
    panel = document.createElement("div");
    panel.id = "displayPanel";
    panel.className = "display-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-labelledby", "displayTitle");
    panel.hidden = true;
    panel.innerHTML =
      '<div class="dp-head"><h3 id="displayTitle">Display</h3>' +
      '<button type="button" class="dp-x" data-dp-close aria-label="Close display settings">×</button></div>' +

      '<fieldset class="dp-group"><legend>Text size</legend>' +
      '<div class="seg dp-sizes" role="radiogroup" aria-label="Text size">' +
      SIZES.map(function (s, i) {
        return '<label class="seg-opt" title="' + s.label + " (" + Math.round(s.value * 100) + '%)">' +
          '<input type="radio" name="dpScale" value="' + s.value + '">' +
          '<span><span class="dp-a" aria-hidden="true" style="font-size:' + (11 + i * 3) + 'px">A</span>' +
          '<span class="dp-sr">' + s.label + "</span></span></label>";
      }).join("") +
      "</div>" +
      '<p class="dp-note" id="dpScaleNote"></p></fieldset>' +

      '<fieldset class="dp-group"><legend>Font</legend>' +
      '<label class="opt dp-opt"><input type="checkbox" name="dpDyslexia">' +
      '<span class="dp-text"><b class="dp-dys-sample">Dyslexia-friendly font</b>' +
      '<span class="opt-desc">OpenDyslexic, with extra spacing between letters, words and lines</span></span></label>' +
      "</fieldset>" +

      '<fieldset class="dp-group"><legend>Colour vision</legend><div class="dp-cvd">' +
      CVD.map(function (c) {
        return '<label class="opt dp-opt" data-cvd-preview="' + c.id + '">' +
          '<input type="radio" name="dpCvd" value="' + c.id + '">' +
          '<span class="dp-text"><b>' + c.label + '</b><span class="opt-desc">' + c.desc + "</span></span>" +
          '<span class="dp-swatches" aria-hidden="true"><i class="sw-good"></i><i class="sw-warning"></i><i class="sw-serious"></i><i class="sw-critical"></i></span>' +
          "</label>";
      }).join("") +
      "</div></fieldset>" +

      '<div class="dp-foot"><button type="button" class="btn ghost sm" data-dp-reset>Reset to default</button></div>';
    document.body.appendChild(panel);

    panel.addEventListener("change", function (e) {
      if (e.target.name === "dpScale") set({ scale: parseFloat(e.target.value) });
      if (e.target.name === "dpCvd") set({ cvd: e.target.value });
      if (e.target.name === "dpDyslexia") set({ dyslexia: e.target.checked });
    });
    panel.querySelector("[data-dp-close]").addEventListener("click", function () { close(true); });
    panel.querySelector("[data-dp-reset]").addEventListener("click", function () {
      set({ scale: 1, cvd: "none", dyslexia: false });
      toast("Display settings reset to default.");
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !panel.hidden) { e.stopPropagation(); close(true); }
    });
    document.addEventListener("mousedown", function (e) {
      if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) close(false);
    });
  }

  function syncPanel() {
    if (!panel) return;
    Array.prototype.forEach.call(panel.querySelectorAll('input[name="dpScale"]'), function (r) {
      r.checked = parseFloat(r.value) === prefs.scale;
    });
    Array.prototype.forEach.call(panel.querySelectorAll('input[name="dpCvd"]'), function (r) {
      r.checked = r.value === prefs.cvd;
    });
    panel.querySelector('input[name="dpDyslexia"]').checked = prefs.dyslexia;
    var size = SIZES.filter(function (s) { return s.value === prefs.scale; })[0];
    panel.querySelector("#dpScaleNote").textContent = size.label + " · " + Math.round(size.value * 100) + "%";
  }

  function open() {
    syncPanel();
    var header = btn.closest(".bar") || btn;
    panel.style.top = Math.round(header.getBoundingClientRect().bottom + 8) + "px"; // header grows with text size
    panel.style.maxHeight = "calc(100vh - " + (parseInt(panel.style.top, 10) + 16) + "px)";
    panel.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    var checked = panel.querySelector('input[name="dpScale"]:checked');
    if (checked) checked.focus();
  }
  function close(returnFocus) {
    if (panel.hidden) return;
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    if (returnFocus) btn.focus();
  }

  function toast(msg) {
    var t = document.createElement("div");
    t.className = "toast";
    t.setAttribute("role", "status");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add("out"); }, 3000);
    setTimeout(function () { t.remove(); }, 3600);
  }

  // ------------------------------------------------------------------
  // Survey: saving it with "Dyslexia-friendly font" ticked or unticked turns
  // the font on or off. (survey.js pre-ticks the box from get().dyslexia, so
  // the two stay in step.) A skipped survey changes nothing.
  // ------------------------------------------------------------------
  window.addEventListener("kaml:accessibility", function (e) {
    var p = e.detail;
    if (!p || p.skipped) return;
    var want = (p.needs || []).indexOf("dyslexia") >= 0;
    if (want !== prefs.dyslexia) set({ dyslexia: want });
  });

  // ------------------------------------------------------------------
  // Init
  // ------------------------------------------------------------------
  buildButton();
  buildPanel();
  apply(false);

  KamL.display = { get: get, set: set, open: open, close: close, SIZES: SIZES, CVD: CVD };
})();
