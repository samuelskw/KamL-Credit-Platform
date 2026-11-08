/*
 * First-run accessibility survey.
 *
 * Asks which accessibility support the user needs and stores the answers.
 * It only COLLECTS preferences — the features themselves (text-to-speech,
 * speech-to-text, focus mode, …) are not implemented yet. Other code can read
 * the answers from KamL.accessibility.get() or listen for the
 * "kaml:accessibility" event on window.
 */
(function () {
  "use strict";
  var KamL = (window.KamL = window.KamL || {});
  var KEY = "kaml-accessibility";

  var NEEDS = [
    // One option for both: it reads everything aloud and lets you answer by speaking.
    // Saved as "tts" + "stt" so voice.js and preferences saved before the merge keep working.
    { id: "voice", icon: "🎙️", label: "Voice assistant", desc: "Reads pages, scores and explanations aloud, and lets you fill in forms by speaking" },
    { id: "attention", icon: "⚡", label: "Short attention span", desc: "Play a short looping video at the side of the page" },
    { id: "dyslexia", icon: "📖", label: "Dyslexia-friendly font", desc: "OpenDyslexic typeface with wider letter spacing" }
  ];

  var EXPLAIN = [
    { id: "simple", label: "Keep it simple", desc: "Plain English, no jargon, just the key points" },
    { id: "explained", label: "Some detail", desc: "Show the numbers, but explain financial terms" },
    { id: "full", label: "Full detail", desc: "Show everything — I'm comfortable with financial terms" }
  ];

  var SPEED = [["slow", "Slower"], ["normal", "Normal"], ["fast", "Faster"]];

  function load() {
    try { var v = localStorage.getItem(KEY); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }
  function save(p) {
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) { /* storage unavailable: keep in memory */ }
    current = p;
    window.dispatchEvent(new CustomEvent("kaml:accessibility", { detail: p }));
  }
  var current = load();

  // Older saves may have only one of the two.
  function hasVoice(needs) { return (needs || []).some(function (n) { return n === "tts" || n === "stt" || n === "voice"; }); }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function build() {
    var p = current || { needs: [], explain: "explained", speechRate: "normal" };
    // These two are stored with the display settings (Display panel and the
    // user's saved account settings), so pre-tick them from what's live.
    var live = KamL.display ? KamL.display.get() : null;
    function ticked(id) {
      if (live && (id === "dyslexia" || id === "attention")) return live[id];
      if (id === "voice") return hasVoice(p.needs);
      return p.needs.indexOf(id) >= 0;
    }
    var bg = document.createElement("div");
    bg.className = "modal-bg on";
    bg.id = "a11ySurvey";
    bg.innerHTML =
      '<form class="modal survey" role="dialog" aria-modal="true" aria-labelledby="a11yTitle" aria-describedby="a11yDesc">' +
      '<div class="eyebrow">Quick setup · 30 seconds</div>' +
      '<h2 id="a11yTitle" style="margin-top:4px">How can we make KamL work better for you?</h2>' +
      '<p class="muted small" id="a11yDesc" style="margin-top:6px">Your answers stay on this device. You can change them any time from the <b>Accessibility</b> button at the top.</p>' +

      '<fieldset class="q"><div class="q-title">1. Which of these would help you? <span class="muted small">(choose any)</span></div><div class="opts">' +
      NEEDS.map(function (n) {
        return '<label class="opt"><input type="checkbox" name="needs" value="' + n.id + '"' + (ticked(n.id) ? " checked" : "") + '>' +
          '<span class="opt-icon" aria-hidden="true">' + n.icon + '</span><span><b>' + esc(n.label) + '</b><span class="opt-desc">' + esc(n.desc) + "</span></span></label>";
      }).join("") +
      '<label class="opt"><input type="checkbox" name="needs" value="none"' + (current && !p.needs.length ? " checked" : "") + '>' +
      '<span class="opt-icon" aria-hidden="true">✓</span><span><b>None of these</b><span class="opt-desc">I\'m happy with the standard layout</span></span></label>' +
      "</div></fieldset>" +

      '<fieldset class="q"><div class="q-title">2. How would you like your finances explained?</div><div class="opts cols-3">' +
      EXPLAIN.map(function (e) {
        return '<label class="opt"><input type="radio" name="explain" value="' + e.id + '"' + (p.explain === e.id ? " checked" : "") + '>' +
          '<span><b>' + esc(e.label) + '</b><span class="opt-desc">' + esc(e.desc) + "</span></span></label>";
      }).join("") + "</div></fieldset>" +

      '<fieldset class="q" id="a11ySpeed"' + (hasVoice(p.needs) ? "" : " hidden") + '><div class="q-title">3. How fast should the voice assistant speak?</div><div class="seg" role="radiogroup">' +
      SPEED.map(function (s) {
        return '<label class="seg-opt"><input type="radio" name="speechRate" value="' + s[0] + '"' + (p.speechRate === s[0] ? " checked" : "") + "><span>" + s[1] + "</span></label>";
      }).join("") + "</div></fieldset>" +

      '<div class="actions"><button type="button" class="btn ghost" data-a11y-skip>Skip for now</button><button type="submit" class="btn">Save preferences</button></div>' +
      "</form>";
    document.body.appendChild(bg);

    var form = bg.querySelector("form");
    var opener = document.activeElement;

    form.addEventListener("change", function (e) {
      if (e.target.name !== "needs") return;
      var boxes = form.querySelectorAll('input[name="needs"]');
      if (e.target.value === "none" && e.target.checked) boxes.forEach(function (b) { if (b.value !== "none") b.checked = false; });
      else if (e.target.checked) form.querySelector('input[value="none"]').checked = false;
      form.querySelector("#a11ySpeed").hidden = !form.querySelector('input[value="voice"]').checked;
    });

    function close(msg) {
      bg.remove();
      document.removeEventListener("keydown", onKey);
      if (opener && opener.focus) opener.focus();
      if (msg) toast(msg);
    }
    function onKey(e) {
      if (e.key === "Escape") { e.stopPropagation(); close(); }
      if (e.key === "Tab") { // keep focus inside the dialog
        var f = form.querySelectorAll("input:not([hidden]), button");
        f = Array.prototype.filter.call(f, function (el) { return el.offsetParent !== null; });
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("keydown", onKey);

    bg.querySelector("[data-a11y-skip]").addEventListener("click", function () {
      if (!current) save({ needs: [], explain: "explained", speechRate: "normal", skipped: true, completedAt: new Date().toISOString() });
      close();
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var needs = Array.prototype.map.call(form.querySelectorAll('input[name="needs"]:checked'), function (b) { return b.value; })
        .filter(function (v) { return v !== "none"; });
      // "Voice assistant" turns on both reading aloud and speaking answers.
      if (needs.indexOf("voice") >= 0) needs.splice(needs.indexOf("voice"), 1, "tts", "stt");
      var explain = (form.querySelector('input[name="explain"]:checked') || {}).value || "explained";
      var rate = (form.querySelector('input[name="speechRate"]:checked') || {}).value || "normal";
      save({ needs: needs, explain: explain, speechRate: rate, skipped: false, completedAt: new Date().toISOString() });
      var LIVE = ["voice", "dyslexia", "attention"]; // voice.js, display.js
      var live = hasVoice(needs);
      var soon = NEEDS.filter(function (n) { return needs.indexOf(n.id) >= 0 && LIVE.indexOf(n.id) < 0; }).map(function (n) { return n.label; });
      var msg = live ? "Voice assistant is on — use the panel at the bottom right. " : "Thanks — your preferences are saved. ";
      if (soon.length) msg += soon.join(", ") + (soon.length > 1 ? " are" : " is") + " coming soon.";
      close(msg.trim());
    });

    var first = form.querySelector("input");
    if (first) first.focus();
  }

  function toast(msg) {
    var t = document.createElement("div");
    t.className = "toast";
    t.setAttribute("role", "status");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add("out"); }, 5000);
    setTimeout(function () { t.remove(); }, 5600);
  }

  KamL.accessibility = {
    get: function () { return current; },
    open: function () { if (!document.getElementById("a11ySurvey")) build(); },
    NEEDS: NEEDS
  };

  var btn = document.getElementById("a11yBtn");
  if (btn) btn.addEventListener("click", KamL.accessibility.open);
  if (!current) build(); // first visit
})();
