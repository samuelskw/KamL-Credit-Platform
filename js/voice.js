/*
 * Voice assistant (Web Speech API).
 *
 * Turned on when the accessibility survey says the user wants text-to-speech
 * and/or speech-to-text.
 *   - Text to speech  : window.speechSynthesis reads every question, result and offer aloud.
 *   - Speech to text  : (webkit)SpeechRecognition listens for answers and commands.
 *
 * Step 1 walks through the form one field at a time: it asks the question,
 * shows what it heard, pulls the number (or option) out of the speech,
 * validates it with the same rules as typing, fills the field, then asks
 * "next, previous, or cancel?". Steps 2–4 are read aloud and can be driven by
 * voice (change loan amount/term, sort and choose offers).
 */
(function () {
  "use strict";
  var K = window.KamL || {}, A = window.KamLApp;
  if (!A) return;
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var synth = window.speechSynthesis;
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };

  var V = {
    on: false, speakOK: false, listenOK: false, rate: 1,
    step: 1, queue: [], idx: 0, phase: "ask", // ask | confirm | end | page | modal
    session: 0, turn: 0, speaking: false, saying: "", prevSaying: "", spokeEndAt: 0, restarts: [], misses: 0, utts: [], rec: null, offerStart: 0, introDone: false, lastSaid: "",
    kb: false, focusEl: null, selfFocus: false, navFocus: false, hinted: {}, modalLender: null
  };

  // ==================================================================
  // Spoken number parsing
  // ==================================================================
  var UNITS = { zero: 0, oh: 0, nought: 0, nil: 0, none: 0, nothing: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
  var ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
  var SCALES = { thousand: 1e3, grand: 1e3, k: 1e3, million: 1e6, mil: 1e6, billion: 1e9 };

  // "£2,500.50" -> 2500.5, "two thousand five hundred" -> 2500, "one and a half" -> 1.5, "5k" -> 5000
  function parseNumber(text) {
    var t = String(text).toLowerCase()
      .replace(/(\d),(?=\d{3}\b)/g, "$1")   // thousands separators
      .replace(/[£$€]/g, " ")
      .replace(/(\d)\s*(k|m)\b/g, "$1 $2")
      .replace(/-/g, " ");
    if (/^\s*(no|none|nothing|zero|nil|nought)\s*\.?$/.test(t)) return 0;
    var toks = t.split(/[^a-z0-9.]+/).filter(Boolean);
    var total = 0, cur = 0, seen = false, dec = null;
    for (var i = 0; i < toks.length; i++) {
      var w = toks[i].replace(/\.$/, "") || toks[i];
      if (/^\d*\.?\d+$/.test(w)) {
        if (dec !== null) { dec += w.replace(".", ""); continue; }
        cur += parseFloat(w); seen = true; continue;
      }
      if (Object.prototype.hasOwnProperty.call(UNITS, w)) {
        if (dec !== null && UNITS[w] < 10) { dec += String(UNITS[w]); continue; }
        cur += UNITS[w]; seen = true; continue;
      }
      if (Object.prototype.hasOwnProperty.call(ORDINALS, w)) { cur += ORDINALS[w]; seen = true; break; } // "the second one" = 2
      if (w === "hundred") { cur = (cur || 1) * 100; seen = true; continue; }
      if (Object.prototype.hasOwnProperty.call(SCALES, w) || (w === "m" && seen)) {
        if (dec !== null) { cur += parseFloat("0." + (dec || "0")); dec = null; }
        total += (cur || 1) * (w === "m" ? 1e6 : SCALES[w]); cur = 0; seen = true; continue;
      }
      if (w === "point" && seen) { dec = ""; continue; }
      if (w === "half") { cur += 0.5; seen = true; continue; }
      if (w === "a" || w === "and") continue;
      if (seen) break; // first non-number word after a number ends it ("3 years", "2500 pounds")
    }
    if (!seen) return null;
    if (dec) cur += parseFloat("0." + dec);
    return Math.round((total + cur) * 100) / 100;
  }

  function words(s) {
    var STOP = { a: 1, an: 1, the: 1, i: 1, im: 1, am: 1, my: 1, is: 1, it: 1, and: 1, or: 1, of: 1, in: 1, a11y: 1, we: 1, are: 1, as: 1, for: 1, to: 1 };
    return String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(function (w) { return w && !STOP[w]; });
  }

  // Extra words people might say for each option value.
  var SYNONYMS = {
    "full-time": "full time permanent", "part-time": "part time", "self-employed": "self employed freelance freelancer contractor own business",
    retired: "retired pension pensioner", student: "student university college", unemployed: "unemployed not working jobseeker",
    stable: "same stable regular fixed salary", some: "little bit slightly some", high: "lot irregular varies a lot",
    healthcare: "health doctor clinic dental care pharmacy", professional: "professional consulting consultancy accounting legal law",
    technology: "technology tech software it app", manufacturing: "manufacturing factory production", wholesale: "wholesale distribution distributor",
    retail: "retail shop store ecommerce online", transport: "transport logistics haulage delivery taxi", construction: "construction builder building trades",
    hospitality: "hospitality restaurant cafe coffee hotel bar pub food catering",
    card: "card credit card cards", installment: "personal loan loan loans", car: "car auto vehicle finance", mortgage: "mortgage home loan house"
  };

  function matchOption(options, text) {
    var said = words(text), best = null, bestScore = 0, tie = false;
    options.forEach(function (o) {
      var vocab = words(o[1] + " " + o[0].replace(/-/g, " ") + " " + (SYNONYMS[o[0]] || ""));
      var score = said.filter(function (w) { return vocab.indexOf(w) >= 0; }).length;
      if (score > bestScore) { best = o; bestScore = score; tie = false; }
      else if (score && score === bestScore) tie = true;
    });
    return bestScore && !tie ? best : null;
  }

  var YES = /^(yes|yeah|yep|yup|correct|right|true|i have|i do|that's right|thats right|affirmative|sure|ok|okay)\b/;
  var NO = /^(no|nope|nah|never|none|false|i haven't|i havent|i don't|i dont|negative)\b/;

  function clean(t) { return String(t).toLowerCase().replace(/[.,!?]/g, "").trim(); }

  // Navigation commands available everywhere.
  // strict = only exact phrases (used for free-text answers like a business name,
  // and while the assistant is talking so its own voice can't trigger commands).
  function command(text, strict) {
    var exact = exactCommand(text);
    if (exact || strict) return exact;
    // Loose: a short utterance with a command word in it ("okay next", "next one please", "can you repeat that").
    var t = clean(text), w = t.split(/\s+/);
    if (w.length > 4 || /\d/.test(t)) return null;
    function has(list) { return w.some(function (x) { return list.indexOf(x) >= 0; }); }
    if (has(["cancel", "stop", "exit", "quit"])) return "cancel";
    if (has(["repeat", "again", "pardon"])) return "repeat";
    if (has(["previous", "back"])) return "prev";
    if (has(["next", "skip", "continue"])) return "next";
    if (has(["evaluate", "submit", "calculate"])) return "evaluate";
    return null;
  }

  function exactCommand(text) {
    var t = clean(text);
    if (/^(cancel|stop|exit|quit|stop listening|cancel voice|turn off)( voice| assistant| please)?$/.test(t)) return "cancel";
    if (/^(next|skip|continue|next question|next field|next one|next step|go on|move on|skip it|skip this)( please)?$/.test(t)) return "next";
    if (/^(previous|back|go back|previous question|previous field|last one|previous step|go back please|back please)$/.test(t)) return "prev";
    if (/^(repeat|say again|say that again|again|pardon|what|sorry|come again|repeat that|repeat please)$/.test(t)) return "repeat";
    if (/^(evaluate|submit|calculate|finish|done|i'm done|im done|get my score|show my score|check my score|evaluate credit)$/.test(t)) return "evaluate";
    if (/^(start over|start again|restart|from the start|from the beginning|begin again)$/.test(t)) return "restart";
    if (/^(instructions|read the instructions|what can i say|how does this work|how do i use this|voice help)$/.test(t)) return "instructions";
    var m = /^(go to|jump to)\s+(.+)$/.exec(t);
    if (m) return { go: m[2] };
    return changeCommand(text);
  }

  // "change it to 40", "set it to retired", "change age to 40", "make it 2000", "change to self employed".
  // Returns {set: value} for the current field, {go: field, set: value} for a named field,
  // or {go: field, loose: true} for "change age" (which may also be "change 40").
  function changeCommand(text) {
    var raw = String(text).trim().replace(/[.!?]+$/, ""); // keep case: a business name is an answer too
    var m = /^(?:change|edit|update|set|make|put|correct)\s+(.+)$/i.exec(raw);
    if (!m) return null;
    var rest = m[1];
    var THIS = /^(?:it|this|that|this one|that one|the value|the answer|my answer|value|answer)\b\s*/i;
    var hadThis = THIS.test(rest);
    rest = rest.replace(THIS, "");
    var to = /^(?:to|as|into|for)\s+(.+)$/i.exec(rest);
    if (to) return { set: to[1] };                          // "change (it) to X"
    if (hadThis) return rest ? { set: rest } : { again: true }; // "make it X" / "change it"
    var named = /^(.+?)\s+(?:to|as)\s+(.+)$/i.exec(rest);
    if (named) return { go: named[1], set: named[2] };     // "change age to 40"
    return { go: rest, loose: true };                      // "change age" (or "change 40")
  }

  // ==================================================================
  // Speech output / input
  // ==================================================================
  var voiceCache = null;
  function pickVoice() {
    if (voiceCache || !synth) return voiceCache;
    var vs = synth.getVoices();
    voiceCache = vs.filter(function (v) { return /en-GB/i.test(v.lang); })[0] || vs.filter(function (v) { return /^en/i.test(v.lang); })[0] || null;
    return voiceCache;
  }
  if (synth && "onvoiceschanged" in synth) synth.onvoiceschanged = function () { voiceCache = null; pickVoice(); };

  // Speak text (split into sentences — Chrome cuts off long utterances).
  // Half-duplex: browser speech recognition has no echo cancellation, so on
  // speakers the microphone would hear the assistant and treat it as the user.
  // The mic is therefore OFF while we talk and reopens shortly after. The user
  // can interrupt with the Interrupt button / Alt+S. With headphones (V.duplex)
  // the mic stays on so they can interrupt by voice.
  var RESUME_DELAY = 450; // ms after speech ends, so the tail of our voice isn't captured
  // opts.keepPrompt: speak without replacing the question shown in the panel (used by notify()).
  function say(text, then, opts) {
    opts = opts || {};
    if (!opts.keepPrompt) { V.lastSaid = text; showPrompt(text); }
    V.saying = "";
    V.turn++; // anything heard from now on belongs to this prompt
    var my = ++V.session;
    if (!V.speakOK) { V.speaking = false; ensureListening(); if (then) then(); return; }
    V.speaking = true;
    if (V.duplex) ensureListening(); else stopListening(); // mic off while talking
    synth.cancel();
    // Split into sentences only where . ? ! is followed by a space, so "4.5" or "£1,234.56" stays whole.
    var parts = text.split(/(?<=[.?!])\s+/).filter(function (p) { return p.trim(); });
    if (!parts.length) parts = [text];
    V.utts = [];
    V.speaking = true;
    setStatus("speaking");
    parts.forEach(function (p, i) {
      var u = new SpeechSynthesisUtterance(speakable(p.trim()));
      u.lang = "en-GB"; u.rate = V.rate;
      var v = pickVoice(); if (v) u.voice = v;
      u.onstart = function () { if (my === V.session) { V.prevSaying = V.saying; V.saying = p; } };
      if (i === parts.length - 1) {
        u.onend = u.onerror = function () {
          if (my !== V.session) return;
          V.speaking = false; V.spokeEndAt = Date.now();
          if (V.duplex) { ensureListening(); setStatus(V.rec ? "listening" : "idle"); }
          else {
            setStatus("idle");
            setTimeout(function () {
              if (my !== V.session || V.speaking) return;
              ensureListening();
              if (V.rec) setStatus("listening");
            }, RESUME_DELAY);
          }
          if (then) then();
        };
      }
      V.utts.push(u); // keep references so Chrome doesn't garbage-collect them mid-speech
      synth.speak(u);
    });
  }

  // Say decimals as "point": "4.5" -> "4 point 5", "8.45" -> "8 point 4 5" (digits after the point are read one by one).
  // Only the spoken words change; the text shown in the panel keeps the normal number.
  function speakable(s) {
    return s.replace(/\s*→\s*/g, ", then ").replace(/[←-⇿⌀-⏿■-➿⬀-⯿️]|[\uD83C-\uD83E][\uDC00-\uDFFF]/g, "").replace(/\s+\/\s+/g, " or ")
      .replace(/(\d)\.(\d+)/g, function (m, whole, frac) { return whole + " point " + frac.split("").join(" "); });
  }

  // Show a message in the result line AND read it out, so nothing in the panel is visual-only.
  function notify(text, kind) {
    showResult(text, kind);
    if (text && V.speakOK) say(text, null, { keepPrompt: true });
  }

  function stopSpeaking() {
    V.session++;
    V.speaking = false;
    if (synth) synth.cancel();
  }

  function stopListening() {
    V.recWanted = false;
    if (V.rec) { try { V.rec.onend = null; V.rec.onresult = null; V.rec.abort(); } catch (e) {} V.rec = null; }
    setMic(false);
  }

  // One continuous recogniser for the whole session (restarted if the browser ends it).
  function ensureListening() {
    if (!V.on || !V.listenOK || V.rec) return;
    if (V.speaking && !V.duplex) return; // never listen to ourselves on speakers
    if (V.paused || V.waitingMic) return; // paused after repeated failures / permission prompt still open
    V.recWanted = true;
    var rec = new SR(), fatal = false;
    rec.lang = "en-GB"; rec.interimResults = true; rec.maxAlternatives = 3; rec.continuous = true;
    rec.onresult = function (e) {
      if (V.rec !== rec) return; // late results from a recogniser we already stopped
      for (var r = e.resultIndex; r < e.results.length; r++) {
        var res = e.results[r], alts = [];
        for (var i = 0; i < res.length; i++) alts.push(res[i].transcript.trim());
        if (!alts[0]) continue;
        if (!res.isFinal) { if (!V.speaking) showHeard(alts[0], true); continue; }
        route(alts);
      }
    };
    rec.onerror = function (e) {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        fatal = true; V.listenOK = false; V.micReady = false;
        renderButtons();
        notify(micHelp("blocked"), "bad");
      } else if (e.error === "network") {
        fatal = true;
        notify("Speech recognition needs an internet connection in this browser. You can type your answers and use the buttons instead.", "bad");
      } else if (e.error === "audio-capture") {
        fatal = true;
        notify("No microphone was found. You can type your answers and use the buttons instead.", "bad");
      }
    };
    rec.onend = function () {
      if (V.rec === rec) V.rec = null;
      setMic(false);
      if (fatal || !V.on || !V.recWanted) return;
      // Browsers end continuous recognition after silence; restart, but don't spin if it keeps failing.
      var now = Date.now();
      V.restarts = (V.restarts || []).filter(function (t) { return now - t < 15000; });
      V.restarts.push(now);
      if (V.restarts.length > 6) { V.paused = true; notify("Listening paused. Press Speak, or Alt+S, to continue.", ""); setStatus("paused"); return; }
      setTimeout(ensureListening, 250);
    };
    try { rec.start(); V.rec = rec; setMic(true); if (!V.speaking) setStatus("listening"); }
    catch (err) { V.rec = null; setTimeout(ensureListening, 400); }
  }

  // Ignore the assistant's own voice if the microphone picks it up from the speakers.
  function isEcho(text) {
    var recent = V.speaking || Date.now() - (V.spokeEndAt || 0) < 1500;
    if (!recent) return false;
    var heard = words(text);
    if (!heard.length) return true;
    var spoken = words((V.prevSaying || "") + " " + (V.saying || ""));
    return heard.every(function (w) { return spoken.indexOf(w) >= 0; });
  }

  // Every final transcript lands here.
  function route(alts) {
    if (!V.on) return;
    var text = alts[0];
    if (V.speaking && !V.duplex) return;
    if (V.duplex && isEcho(text)) return;
    var item = V.step === 1 && V.phase === "ask" ? V.queue[V.idx] : null;
    var cmd = command(text, V.speaking || (item && item.kind === "text"));
    if (V.speaking) {
      if (!cmd) return;      // while talking, only navigation commands interrupt
      stopSpeaking();
    }
    showHeard(text, false);
    handle(alts, cmd);
  }

  function sayThenListen(text) { say(text); }
  // Speak button / Alt+S: interrupts the assistant and opens the mic straight away.
  function listen() {
    if (V.speaking) stopSpeaking();
    V.paused = false;
    V.restarts = [];
    ensureListening();
    if (V.rec) setStatus("listening");
  }

  // ==================================================================
  // Step 1 — guided form
  // ==================================================================
  function buildQueue() {
    var items = [{ kind: "type", key: "_type", label: "Applicant type" }];
    A.allFields().forEach(function (f) {
      if (f.id === "overdraftDaysPerMonth" && A.state.type === "individual") {
        (K.SPEND_CATEGORIES || []).forEach(function (c) {
          items.push({ kind: "number", key: "sp_" + c.id, label: "Monthly spending on " + c.label.toLowerCase(), unit: "£" });
        });
      }
      items.push({
        kind: { select: "select", checkbox: "checkbox", checks: "checks", text: "text" }[f.type] || "number",
        key: f.id, label: f.label, unit: f.unit, suffix: f.suffix, options: f.options, required: f.required
      });
    });
    return items;
  }
  function fieldEl(item) { return document.getElementById("f_" + item.key); }

  function unitPhrase(item) {
    if (item.unit === "£") return ", in pounds";
    return { yrs: ", in years", days: ", in days", "%": ", as a percentage" }[item.suffix] || "";
  }
  function fmtValue(item, n) {
    if (item.unit === "£") return "£" + Number(n).toLocaleString("en-GB");
    var s = { yrs: n == 1 ? " year" : " years", days: n == 1 ? " day" : " days", "%": " percent" }[item.suffix] || "";
    return Number(n).toLocaleString("en-GB") + s;
  }
  function currentDisplay(item) {
    if (item.kind === "type") return A.state.type;
    var el = fieldEl(item);
    if (item.kind === "checkbox") return el.checked ? "yes" : "no";
    if (item.kind === "checks") {
      var on = $$('[data-multi="' + item.key + '"]').filter(function (c) { return c.checked; }).map(function (c) { return labelFor(item, c.value); });
      return on.length ? on.join(", ") : "none";
    }
    if (item.kind === "select") return labelFor(item, el.value);
    if (!el.value) return "";
    return item.kind === "number" ? fmtValue(item, parseFloat(el.value)) : el.value;
  }
  function labelFor(item, value) {
    var o = (item.options || []).filter(function (o) { return o[0] === value; })[0];
    return o ? o[1] : value;
  }

  function question(item) {
    var q;
    item = Object.create(item, { label: { value: String(item.label).replace(/[?.!]\s*$/, "") } }); // no "income?."
    switch (item.kind) {
      case "type": q = "Are you applying as an individual, or for a business?"; break;
      case "select": q = item.label + ". " + listOptions(item.options.map(function (o) { return o[1]; })) + " Which one would you like?"; break;
      case "checkbox": q = item.label + "? Say yes or no."; break;
      case "checks": q = item.label + ". Say any of: " + item.options.map(function (o) { return o[1]; }).join(", ") + ". Or say none."; break;
      case "text": q = item.label + "?"; break;
      default: q = item.label + unitPhrase(item) + "?";
    }
    // Say the current answer straight after the question name, before any option list,
    // and say clearly when there isn't one yet.
    if (item.kind !== "type") {
      var cur = currentDisplay(item);
      var ans = cur ? " Your answer: " + cur + "." : " No answer yet.";
      var cut = q.indexOf(". The ") >= 0 && item.kind === "select" ? q.indexOf(". The ") + 1 : q.indexOf(". Say any of:") >= 0 ? q.indexOf(". Say any of:") + 1 : -1;
      q = cut > 0 ? q.slice(0, cut) + ans + q.slice(cut) : q + ans;
    }
    if (item.required) q += " This one is required.";
    return q;
  }

  function highlight(item) {
    $$(".voice-focus").forEach(function (e) { e.classList.remove("voice-focus"); });
    var target = item && item.kind === "type" ? $("#typeSeg") : item && fieldEl(item) ? fieldEl(item).closest(".field") : null;
    if (item && item.kind === "checks") target = $('[data-multi="' + item.key + '"]').closest(".field");
    if (target) { target.classList.add("voice-focus"); target.scrollIntoView({ block: "center", behavior: "smooth" }); }
  }

  // Re-check a field we're leaving so a stale error (e.g. from a rejected spoken answer) doesn't linger.
  function refreshFieldError(item) {
    if (!item || item.kind !== "number") return;
    var el = fieldEl(item);
    if (el) A.setErr(el, el.value ? A.checkNumber(el, false) : "");
  }

  // opts.noFocus: keyboard focus is already on the field (the user tabbed there).
  // opts.suffix: extra words read after the question (e.g. a keyboard hint).
  function ask(i, prefix, opts) {
    opts = opts || {};
    if (V.phase === "ask") refreshFieldError(V.queue[V.idx]);
    $$(".voice-focus").forEach(function (e) { e.classList.remove("voice-focus"); });
    V.idx = Math.max(0, Math.min(i, V.queue.length - 1));
    V.phase = "ask";
    var item = V.queue[V.idx];
    showHeard("");      // clear the previous question's transcript…
    showResult("", ""); // …and its result / error line
    highlight(item);
    if (V.kb && !opts.noFocus) focusItem(item); // keep keyboard focus in step with the question
    setProgress("Question " + (V.idx + 1) + " of " + V.queue.length);
    var intro = "";
    if (!V.introDone) {
      V.introDone = true;
      intro = "I'll ask you each question in turn. Answer out loud, or say skip, previous, or cancel at any time. " +
        "You can also move with Tab or the up and down arrow keys, and press Enter or Space to select. ";
    }
    var err = fieldError(item);
    if (err && (prefix || "").indexOf(err) >= 0) err = "";
    sayThenListen((prefix || "") + intro + "Question " + (V.idx + 1) + " of " + V.queue.length + ". " + (err ? "Error: " + err + " " : "") + question(item) + (opts.suffix || ""));
  }

  function itemEl(item) {
    if (item.kind === "type") return $("#typeSeg button.on") || $("#typeSeg button");
    if (item.kind === "checks") return $('[data-multi="' + item.key + '"]');
    return fieldEl(item);
  }
  function focusItem(item) { selfFocus(itemEl(item)); }
  function fieldError(item) {
    var el = item && item.kind !== "type" ? fieldEl(item) : null;
    var box = el && document.getElementById(el.id + "_err");
    return box ? textOf(box) : "";
  }

  function next() {
    if (V.idx + 1 >= V.queue.length) return end();
    ask(V.idx + 1);
  }
  function prev() {
    if (V.phase === "end") return ask(V.queue.length - 1);
    if (V.idx === 0) return sayThenListen("This is the first question. " + question(V.queue[0]));
    ask(V.idx - 1);
  }
  function end(prefix) {
    if (V.phase === "ask") refreshFieldError(V.queue[V.idx]);
    V.phase = "end";
    highlight(null);
    $("#evalBtn").closest(".card").classList.add("voice-focus");
    if (V.kb) selfFocus($("#evalBtn"));
    setProgress("All questions done");
    sayThenListen((prefix || "") + "All questions done. That was the last question. Say evaluate to get your credit score, previous to go back, start over, or cancel.");
  }

  function findField(name) {
    var target = words(name);
    var best = -1, score = 0;
    V.queue.forEach(function (it, i) {
      var s = words(it.label).filter(function (w) { return target.indexOf(w) >= 0; }).length;
      if (s > score) { score = s; best = i; }
    });
    return best;
  }
  function goToField(name) {
    var best = findField(name);
    if (best < 0) return sayThenListen("I couldn't find a question called " + name + ". Try saying go to, then part of the question, like go to monthly income.");
    ask(best);
  }

  // Apply a spoken answer to question i, then move on (shared by plain answers and "change … to …").
  function answer(i, alts) {
    var item = V.queue[i];
    var r = applyAnswer(item, alts);
    if (!r.ok) {
      if (i !== V.idx) ask(i, r.msg + " "); // changing another question: go there so they can retry
      else { showResult(r.msg, "bad"); sayThenListen(r.msg); }
      return;
    }
    V.idx = i;
    var done = "✓ " + item.label + ": " + r.display;
    var got = "Got it, " + item.label.replace(/[?.!]\s*$/, "") + ": " + r.display + ". ";
    if (i + 1 >= V.queue.length) end(got); else ask(i + 1, got);
    showResult(done, "good");
  }

  // "change …" in step 1.
  function changeForm(cmd) {
    if (cmd.again) return V.phase === "ask" ? ask(V.idx, "Sure. ") : sayThenListen("Move to a question first, then say change it to, and the new answer.");
    if (cmd.go) {
      var i = findField(cmd.go);
      if (i >= 0) return cmd.set !== undefined ? answer(i, [cmd.set]) : ask(i);
      // "change 40" / "change the value to 40" while on a question: it's an answer for this question
      if (V.phase === "ask") return answer(V.idx, [cmd.set !== undefined ? cmd.set : cmd.go]);
      return sayThenListen("I couldn't find a question called " + cmd.go + ". Say change it to, and the new answer, or go to and part of a question.");
    }
    if (V.phase !== "ask") return sayThenListen("Move to a question first, then say change it to, and the new answer.");
    answer(V.idx, [cmd.set]);
  }

  // Apply an answer for the current item. Returns {ok, display} or {ok:false, msg}.
  function applyAnswer(item, alts) {
    var text = alts[0] || "";
    if (item.kind === "type") {
      var t = /business|company|firm|limited|ltd|shop/i.test(text) ? "business" : /individual|personal|myself|me\b|person|just me|private/i.test(text) ? "individual" : null;
      if (!t) return { ok: false, msg: "Please say individual, or business." };
      if (t !== A.state.type) { A.setType(t); V.queue = buildQueue(); }
      return { ok: true, display: t === "business" ? "a business" : "an individual" };
    }
    var el = fieldEl(item);
    if (item.kind === "number") {
      var n = null;
      for (var i = 0; i < alts.length && n === null; i++) n = parseNumber(alts[i]);
      if (n === null) return { ok: false, msg: "I didn't hear a number. Please say a number, or say skip." };
      var prevVal = el.value;
      el.value = String(n);
      var err = A.checkNumber(el, false);
      if (err) { el.value = prevVal; A.setErr(el, err); return { ok: false, msg: err + " Please try again." }; }
      A.setErr(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, display: fmtValue(item, n) };
    }
    if (item.kind === "select") {
      var o = null;
      for (var j = 0; j < alts.length && !o; j++) o = matchOption(item.options, alts[j]);
      if (!o) return { ok: false, msg: "Sorry, that didn't match an option. Please say one of: " + item.options.map(function (x) { return x[1]; }).join(", ") + "." };
      el.value = o[0];
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, display: o[1] };
    }
    if (item.kind === "checkbox") {
      var c = clean(text);
      if (YES.test(c)) el.checked = true;
      else if (NO.test(c)) el.checked = false;
      else return { ok: false, msg: "Please say yes or no." };
      return { ok: true, display: el.checked ? "yes" : "no" };
    }
    if (item.kind === "checks") {
      var boxes = $$('[data-multi="' + item.key + '"]');
      if (/^(none|nothing|no|neither|zero)\b/.test(clean(text))) {
        boxes.forEach(function (b) { b.checked = false; });
        return { ok: true, display: "none" };
      }
      var said = words(text), picked = [];
      boxes.forEach(function (b) {
        var vocab = words(labelFor(item, b.value) + " " + (SYNONYMS[b.value] || ""));
        b.checked = said.some(function (w) { return vocab.indexOf(w) >= 0 && w !== "loan"; }) ||
          (b.value === "installment" && /personal loan|\bloan\b(?! home)/.test(clean(text)) && !/home loan|car loan/.test(clean(text)));
        if (b.checked) picked.push(labelFor(item, b.value));
      });
      if (!picked.length) return { ok: false, msg: "Sorry, I didn't catch which ones. Say any of: " + item.options.map(function (x) { return x[1]; }).join(", ") + ", or none." };
      return { ok: true, display: picked.join(", ") };
    }
    // free text
    el.value = text.replace(/\.$/, "");
    return { ok: true, display: el.value };
  }

  function handleForm(alts, cmd) {
    if (cmd === "cancel") return cancel(true);
    if (cmd === "instructions") return say(instructions());
    // Keyboard focus is on something that isn't a question (a button, link, heading…).
    if (V.phase === "focus") {
      var fe = focused() || V.focusEl;
      if (cmd === "next" || cmd === "prev") return moveFocus(cmd === "next" ? 1 : -1);
      if (cmd === "repeat") return fe ? say(describe(fe).text) : ask(V.idx);
      if (!cmd && PRESS.test(clean(alts[0]))) return activate(fe);
      var yn = yesNo(fe, alts[0], cmd);
      if (yn) return yn();
      if (!cmd) return say("You are on " + (fe ? describe(fe).text : "the page.") + " Say press to select it, next or previous to move, or go to and a question name.");
    }
    if (cmd === "next") return V.phase === "end" ? sayThenListen("That was the last question. Say evaluate, previous, or cancel.") : next();
    if (cmd === "prev") return prev();
    if (cmd === "repeat") return V.phase === "end" ? end() : ask(V.idx);
    if (cmd === "restart") return ask(0);
    if (cmd === "evaluate") return doEvaluate();
    if (cmd && (cmd.set !== undefined || cmd.again || cmd.loose)) return changeForm(cmd);
    if (cmd && cmd.go) return goToField(cmd.go);
    if (V.phase === "end") return sayThenListen("Sorry, I didn't understand. Say evaluate, previous, start over, or cancel.");
    // Answer accepted: move straight on so the next thing the user says belongs to the next question.
    // (Saying "previous" goes back to change it.)
    answer(V.idx, alts);
  }

  function doEvaluate() {
    stopListening();
    A.evaluate();
    if (A.state.step === 1) {
      var msg = ($("#formError").innerText || "Some answers need fixing.").trim();
      var bad = $("#form [aria-invalid='true']"), idx = -1;
      if (bad) idx = V.queue.map(function (it) { return "f_" + it.key; }).indexOf(bad.id);
      else if (/age/i.test(msg)) idx = keyIndex("age");
      else if (/income/i.test(msg)) idx = keyIndex("monthlyIncome");
      else if (/revenue/i.test(msg)) idx = keyIndex("annualRevenue");
      if (idx >= 0) ask(idx, msg + " Let's fix it. ");
      else sayThenListen(msg);
    }
    // success: the kaml:step event reads step 2
  }
  function keyIndex(k) { return V.queue.map(function (it) { return it.key; }).indexOf(k); }

  // ==================================================================
  // Steps 2–4 — read aloud & voice control
  // ==================================================================
  function money(n) { return "£" + Math.round(n).toLocaleString("en-GB"); }
  function pct(x) { return (Math.round(x * 10) / 10) + " percent"; }

  // All factors, biggest possible gain first; ties by lowest score first.
  function byGain(factors) {
    return factors.slice().sort(function (a, b) { return (b.upside - a.upside) || (a.score - b.score); });
  }

  // Every part of the step 3 rate, with why it exists (the "How the rate is built" table).
  function rateBuiltText() {
    var rk = A.state.risk;
    return rk.components.map(function (c) { return c.label + ", " + c.value.toFixed(2) + " percent: " + speakNums(String(c.note).replace(/[.\s]+$/, "")) + "."; }).join(" ") +
      " Total, " + rk.rate.toFixed(2) + " percent.";
  }
  // Step 3 cards by title (Risk grade, Risk-based interest rate, How the rate is built, Bank risk tiers).
  function riskCard(title) {
    return $$("#riskOut .card").filter(function (c) { return new RegExp("^" + title, "i").test(textOf($(".eyebrow", c) || $("h3", c))); })[0];
  }

  function stepText(step) {
    var s = A.state, r = s.result;
    if (step === 2) {
      var pos = [], neg = [];
      r.factors.slice().sort(function (a, b) { return b.weight - a.weight; }).forEach(function (f) { pos = pos.concat(f.positives); neg = neg.concat(f.negatives); });
      var t = "Step 2, your credit score. Your score is " + r.score + " out of 850, which is rated " + r.band.label + ". ";
      if (pos.length) t += "Helping your score: " + pos.slice(0, 2).join(" ") + " ";
      if (neg.length) t += "Holding it back: " + neg.slice(0, 2).join(" ") + " ";
      // Score breakdown: the "How to improve" tip shown under EVERY factor, biggest possible gain first.
      t += "Score breakdown, with how to improve each part, biggest gain first. " + byGain(r.factors).map(function (f) {
        return f.name + ", rated " + f.rating + ", " + f.points + " of " + f.maxPoints + " points. " + improveText(f);
      }).join(" ") + " ";
      if (supportText()) t += "Free, confidential help is available. Say help to hear the services and what they do. ";
      return t + "Say details to hear every factor, data to hear the data used for this score, next for your interest rate, previous to change your answers, or cancel.";
    }
    if (step === 3) {
      var rk = s.risk, req = s.request[s.type];
      var pay = K.risk.payment(req.amount, rk.rate, req.termMonths);
      var t3 = "Step 3, risk and interest rate. You're in risk tier " + rk.tier.id + ", " + rk.tier.label + ". The estimated chance of default in the next year is " + pct(rk.pd * 100) + ". ";
      if (rk.declined) t3 += "That is above what most mainstream lenders accept. ";
      t3 += "For " + rk.product.label.split(" (")[0].toLowerCase() + " of " + money(req.amount) + " over " + A.fmtTerm(req.termMonths).replace("yr", "year") +
        ", the risk-based interest rate is " + rk.rate.toFixed(2) + " percent, about " + money(pay) + " a month. ";
      t3 += "How the rate is built: " + rateBuiltText() + " ";
      return t3 + "Say tiers to hear the bank risk tiers. You can also say amount followed by a number, term followed by years, the loan type such as car or mortgage, next for loan offers, previous, or cancel.";
    }
    if (step === 4) return offersText(0);
    return "";
  }

  function offerCards() {
    return $$("#offers .offer").map(function (o, i) {
      var v = $$(".stat .v", o).map(function (x) { return x.textContent; });
      return {
        el: o, n: i + 1, name: $(".name", o).childNodes[0].textContent.trim(),
        apr: v[0], monthly: v[1], total: v[2], odds: ($(".badge", o) || {}).textContent || ""
      };
    });
  }

  function offersText(start) {
    var cards = offerCards();
    V.offerStart = start;
    if (!cards.length) return "Step 4, loan offers. No lenders can offer this loan right now. Say previous to change the amount or term, or cancel.";
    var t = start === 0 ? "Step 4, loan offers. There " + (cards.length === 1 ? "is 1 offer" : "are " + cards.length + " offers") + ", sorted by " + $("#sortBy").selectedOptions[0].text.toLowerCase() + ". " : "";
    cards.slice(start, start + 4).forEach(function (c) {
      t += "Option " + c.n + ": " + c.name + ". APR " + c.apr.replace("%", " percent") + ". " + c.monthly + " a month. Total " + c.total + ". Approval: " + c.odds + ". ";
    });
    if (cards.length > start + 4) t += "Say more to hear the rest. ";
    return t + "Say choose and an option number, sort by monthly payment, total cost or approval, previous, or cancel.";
  }

  function readStep(step, prefix) {
    V.phase = $("#modal").classList.contains("on") ? "modal" : "page";
    highlight(null);
    setProgress("Step " + step + " of 4");
    sayThenListen((prefix || "") + stepText(step).replace(/^Step (\d),/, "Step $1 of 4,"));
  }

  function handlePage(alts, cmd) {
    var text = alts[0], c = clean(text), step = V.step;

    // Offer detail modal
    if (V.phase === "modal") {
      // Clicking the dialog's buttons is announced by onClick(), the same as a keyboard press.
      if (/^(confirm|select|select it|select this|yes|choose it|i'll take it|take it|accept|press|enter|ok|okay)/.test(c)) {
        var btn = $("#modalBody [data-confirm]");
        if (btn) return btn.click();
      }
      if (/^(back|no|close|go back|return|cancel)/.test(c)) {
        var close = $("#modalBody [data-close]");
        if (close) return close.click();
      }
      return sayThenListen("Say confirm to select this offer, or back to return to the list.");
    }

    // Keyboard focus is on a control: "press" activates it; an answer fills it.
    var fe = focused();
    // "change it to 20000" / "change the amount to 20000" / "set term to five years"
    if (cmd && typeof cmd === "object" && (cmd.set !== undefined || cmd.loose || cmd.again)) {
      if (cmd.again) return fe ? say(describe(fe).text + " Say the new value.") : sayThenListen("Say change, the setting, to, and the new value. For example, change the amount to 20000.");
      var val = cmd.set !== undefined ? cmd.set : cmd.go;
      if (fe && !cmd.go && applyToFocused(fe, [val])) return;
      if (fe && cmd.loose && applyToFocused(fe, [val])) return;
      text = ((cmd.go && !cmd.loose) ? cmd.go + " " : "") + val; // fall through to the step's own parsing ("amount 20000")
      c = clean(text); alts = [text]; cmd = null;
    }
    var yn = yesNo(fe, text, cmd);
    if (yn) return yn();
    if (fe && !cmd) {
      if (PRESS.test(c)) return activate(fe);
      if (applyToFocused(fe, alts)) return;
    }

    if (step === 4 && /^(more|more offers|next offers|the rest|rest)$/.test(c)) return sayThenListen(offersText(V.offerStart + 4));
    if (cmd === "cancel") return cancel(true);
    if (cmd === "instructions") return say(instructions());
    if (cmd === "repeat") return readStep(step);
    if (cmd === "next") {
      if (step >= 4) return sayThenListen("This is the last step. Say choose and an option number, previous, or cancel.");
      return A.go(step + 1);
    }
    if (cmd === "prev") return A.go(step - 1);
    if (cmd === "restart") return A.go(1);

    if (step === 2) {
      if (/\b(data|table|my data|data used|what data)\b/.test(c) && $("#dataTable tbody tr")) {
        var tb = $("#dataTable");
        if (V.kb) { tb.setAttribute("tabindex", "0"); selfFocus(tb); }
        return sayThenListen("Data used for this score. " + tableAll(tb) + " End of table. Say next for your interest rate, or cancel.");
      }
      if (/\b(help|support|advice|services|debt help)\b/.test(c) && supportText()) {
        var sb = $("#supportBox .alert");
        if (V.kb && sb) { if (!sb.hasAttribute("tabindex")) sb.setAttribute("tabindex", "-1"); selfFocus(sb); }
        return sayThenListen(supportText());
      }
      if (/detail|factor|breakdown|everything|more/.test(c)) {
        var t = A.state.result.factors.map(function (f) { return f.name + ": " + f.rating + ", " + f.points + " of " + f.maxPoints + " points. " + improveText(f); }).join(" ");
        return sayThenListen("Score breakdown. " + t + " Say next for your interest rate, or cancel.");
      }
      if (/tip|improve|better/.test(c)) {
        var tt = "Ways to improve, biggest gain first. " + byGain(A.state.result.factors).map(function (f) { return f.name + ". " + improveText(f); }).join(" ");
        return sayThenListen(tt + " Say next for your interest rate, or cancel.");
      }
    }

    if (step === 3) {
      // Hear a section of the page again: "tiers", "why", "how is the rate built".
      var want = /\btiers?\b/.test(c) ? "Bank risk tiers" : /\b(built|breakdown|parts|made up)\b/.test(c) ? "How the rate is built" :
        /\b(why|grade|risk grade)\b/.test(c) ? "Risk grade" : null;
      if (want) {
        var card = riskCard(want), info = sectionInfo(card);
        if (info) {
          if (V.kb) { if (!card.hasAttribute("tabindex")) card.setAttribute("tabindex", "-1"); selfFocus(card); }
          return sayThenListen(info.text + " " + (info.more || "") + " Say next for loan offers, or repeat to hear this step again.");
        }
      }
      var n = parseNumber(text);
      if (/amount|borrow|pounds|£/.test(c) && n !== null) return setLoan("lf_amount", n, "Amount set to " + money(n) + ". ");
      if (/base rate|bank rate/.test(c) && n !== null) return setLoan("lf_base", n, "Base rate set to " + n + " percent. ");
      if (/year|month|term/.test(c) && n !== null) {
        var months = /month/.test(c) ? n : n * 12;
        var opts = $$("#lf_term option").map(function (o) { return +o.value; });
        var best = opts.reduce(function (a, b) { return Math.abs(b - months) < Math.abs(a - months) ? b : a; }, opts[0]);
        var note = best !== months ? "The closest available term is " + A.fmtTerm(best).replace("yr", "year") + ". " : "";
        return setLoan("lf_term", best, note + "Term set to " + A.fmtTerm(best).replace("yr", "year") + ". ");
      }
      var prodOpts = $$("#lf_product option").map(function (o) { return [o.value, o.textContent]; });
      var PROD = { personal: "personal", car: "car vehicle auto", consolidation: "consolidate consolidation debt", home: "home improvement renovation", mortgage: "mortgage house",
        working: "working capital cash flow", equipment: "equipment machinery asset", expansion: "growth expansion expand", property: "commercial property premises" };
      var said = words(text), match = null;
      prodOpts.forEach(function (o) { if (!match && words(PROD[o[0]] || o[1]).some(function (w) { return said.indexOf(w) >= 0; })) match = o; });
      if (match) return setLoan("lf_product", match[0], "Loan type set to " + match[1] + ". ");
    }

    if (step === 4) {
      if (/^more|next offers|rest/.test(c)) return sayThenListen(offersText(V.offerStart + 4));
      var sort = /monthly|month/.test(c) ? "monthly" : /total|cost|cheapest/.test(c) ? "total" : /approval|chance|likely/.test(c) ? "likelihood" : /apr|rate|interest/.test(c) ? "apr" : null;
      if (/sort|order/.test(c) && sort) {
        var sel = $("#sortBy"); sel.value = sort; sel.dispatchEvent(new Event("change", { bubbles: true }));
        return sayThenListen("Sorted. " + offersText(0));
      }
      var num = parseNumber(text);
      if (/choose|select|pick|option|number|take|want/.test(c) || (num !== null && c.split(" ").length <= 2)) {
        var cards = offerCards();
        var pickC = cards[(num || 0) - 1];
        if (!pickC) return sayThenListen("Please say an option number between 1 and " + cards.length + ".");
        return $("[data-choose]", pickC.el).click(); // onClick() reads the offer details
      }
    }
    sayThenListen("Sorry, I didn't understand that. Say repeat to hear the options again, next, previous, or cancel.");
  }

  function setLoan(id, value, msg) {
    var el = document.getElementById(id);
    if (!el) return;
    el.value = String(value);
    if (el.dataset.num) {
      var err = A.checkNumber(el, true);
      if (err) { A.setErr(el, err); return sayThenListen(err + " Please try again."); }
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    showResult("✓ " + msg, "good");
    // Changing the loan type re-draws the form, so put keyboard focus back on the same control.
    var again = document.getElementById(id);
    if (V.kb && again && document.activeElement !== again && (V.focusEl === el || !document.contains(V.focusEl))) selfFocus(again);
    sayThenListen(msg + rateLine() + " Say another change, next for loan offers, or cancel.");
  }
  function rateLine() {
    var rk = A.state.risk, req = A.state.request[A.state.type];
    return "The interest rate is now " + rk.rate.toFixed(2) + " percent, about " + money(K.risk.payment(req.amount, rk.rate, req.termMonths)) + " a month.";
  }

  function modalText() {
    var name = textOf($("#modalBody h2"));
    var c = offerCards().filter(function (x) { return x.name === name; })[0];
    var dl = $$("#modalBody dt").map(function (dt) { return dt.textContent + ": " + dt.nextElementSibling.textContent + "."; }).join(" ");
    dl = dl.replace(/%/g, " percent").replace(/\bp\.a\.\.?/g, "a year.").replace(/(\d) yrs?\b/g, function (m, d) { return d + (d === "1" ? " year" : " years"); });
    return (c ? "Option " + c.n + ", " : "") + name + ". " + dl +
      " Say confirm, or press Enter on Select this offer, to choose it. Say back, or press Escape, to return to the list.";
  }

  // ==================================================================
  // Dispatch
  // ==================================================================
  function handle(alts, cmd) {
    if (!alts.length || !alts[0]) return;
    if (cmd === undefined) cmd = command(alts[0]);
    if (V.step === 1) handleForm(alts, cmd);
    else handlePage(alts, cmd);
  }

  // Button presses mirror spoken commands.
  function button(action) {
    if (action === "start") return start();
    if (action === "cancel") return cancel(true);
    if (!V.on) return start();
    if (action === "mic") return listen();
    if (action === "instructions") return say(instructions());
    if (action === "repeat") return V.step === 1 ? (V.phase === "end" ? end() : ask(V.idx)) : readStep(V.step);
    if (V.step === 1) {
      if (action === "next") return next();
      if (action === "prev") return prev();
    } else {
      if (action === "next") return V.step < 4 ? A.go(V.step + 1) : sayThenListen("This is the last step.");
      if (action === "prev") return A.go(V.step - 1);
    }
  }

  function onStep(e) {
    var step = e.detail.step;
    var was = V.step;
    V.step = step;
    if (!V.on || step === was && step === 1) return;
    if (step === 1) {
      V.queue = buildQueue();
      return ask(Math.min(V.idx, V.queue.length - 1), "Back to your answers. ");
    }
    if (V.kb) { // move keyboard focus to the new page's heading so Tab/arrows start there
      var h = $("#panel-" + step + " h2");
      if (h) { if (!h.hasAttribute("tabindex")) h.setAttribute("tabindex", "-1"); selfFocus(h); }
    }
    readStep(step);
  }

  function start() {
    if (!V.speakOK && !V.listenOK) {
      showDock();
      showResult("Your browser doesn't support the Web Speech API. Try Chrome or Edge.", "bad");
      return;
    }
    V.on = true;
    V.misses = 0;
    showDock();
    renderButtons();
    // Ask for the microphone once up front (not on every question).
    if (V.listenOK && !V.micReady) return ensureMic(begin);
    begin();
  }

  // msg: something to say first (e.g. a microphone problem). The panel's instructions are read on the first start.
  function begin(msg) {
    if (!V.on) return;
    var notice = typeof msg === "string" ? msg : "";
    if (!V.listenOK && SR === undefined) {
      notice += (notice ? " " : "") + "Speech recognition isn't supported in this browser, so type each answer and press Next. Questions will still be read aloud.";
    }
    var pre = notice ? notice + " " : "";
    if (!V.noteRead) { V.noteRead = true; V.introDone = true; pre += instructions() + " "; }
    if (V.step === 1) { V.queue = buildQueue(); ask(V.idx || 0, pre); }
    else readStep(V.step, pre);
    if (notice) showResult(notice, msg ? "bad" : ""); // after ask(), which clears the result line
  }
  // The instructions note at the bottom of the panel, as spoken text.
  function instructions() {
    var n = $(".vd-note");
    return n ? textOf(n).replace(/Alt\+(\w)/g, "Alt $1") : "";
  }

  // ==================================================================
  // Keyboard navigation (for blind and keyboard-only users)
  // ==================================================================
  // While the assistant is on:
  //   Tab / Shift+Tab   move between controls (browser default)
  //   Up / Down arrows  move through everything: controls, headings and key text
  //   Left / Right      change the choice in a drop-down list
  //   Enter / Space     select (buttons, links, tick boxes, lists); Enter in an
  //                     edit box confirms a typed answer and moves on
  // Whatever gets focus is read aloud straight away. If it needs an answer, the
  // mic opens after the assistant finishes so the user can just say it.
  var PRESS = /^(press|press it|press enter|select|select it|click|click it|choose it|open|open it|activate|enter|ok|okay|go)( please)?$/;
  var NAV_SEL = 'a[href], button:not([disabled]), summary, input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  var READ_SEL = ".panel.active h2, .panel.active h3, .panel.active .reasons li, .panel.active .kpis > *, .panel.active .notice, #modalBody h2, #modalBody p, " +
    "#riskOut .alert, #riskOut .card, " + // step 3 is read card by card (see sectionInfo)
    "#supportBox .alert, " +              // step 2 support message (see supportText)
    ".panel.active #dataTable, .panel.active #dataTable tbody tr"; // step 2 data table: the table, then each row
  var lastKeyAt = 0;

  function textOf(el) {
    var t = el ? (el.innerText || el.textContent || "") : "";
    // Drop arrows / emoji the speech engine would read out literally ("black right-pointing triangle").
    return t.replace(/[←-⇿⌀-⏿■-➿⬀-⯿️]|[\uD83C-\uD83E][\uDC00-\uDFFF]/g, "").replace(/\s+/g, " ").trim();
  }
  function selfFocus(el) {
    if (!el) return;
    V.focusEl = el;
    if (document.activeElement === el) return;
    V.selfFocus = true; // our own focus moves aren't announced (the caller already speaks)
    try { el.focus({ preventScroll: true }); } finally { V.selfFocus = false; }
  }
  function focused() {
    var el = V.focusEl;
    return el && document.activeElement === el && !el.closest("#voiceDock") ? el : null;
  }
  function isVisible(el) { return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); }
  function navRoot() {
    if ($("#a11ySurvey")) return null; // the survey dialog does its own keyboard handling
    return $("#modal").classList.contains("on") ? $("#modalBody") : document.body;
  }
  function navItems(root) {
    return $$(NAV_SEL + ", " + READ_SEL, root).filter(function (el) {
      if (!isVisible(el) || el.closest("svg, .stack, .legend")) return false; // diagrams and charts are skipped
      if (el.closest("#riskOut")) return el.matches("#riskOut .card, #riskOut .alert") && !$("svg", el); // whole cards; no rate graph
      return true;
    });
  }

  // ---- Step 3: each card is one "section" with a summary and an optional "why" ----
  function speakNums(t) {
    return String(t).replace(/(\d)\s*%/g, "$1 percent").replace(/\s*[–—-]\s*(?=\d|£)/g, " to ").replace(/<\s*/g, "under ")
      .replace(/\s*→\s*/g, ", then ").replace(/\s*·\s*/g, ", ").replace(/\s{2,}/g, " ");
  }
  function sectionInfo(el) {
    if (!el || !el.closest || !el.closest("#riskOut") || !el.matches(".card, .alert")) return null;
    var s = A.state, rk = s.risk, req = s.request[s.type];
    if (!rk) return null;
    if (el.classList.contains("alert")) return { text: "Warning: " + textOf(el) };
    var title = textOf($(".eyebrow", el) || $("h3", el));
    var loanName = rk.product.label.split(" (")[0].toLowerCase();
    if (/^Risk grade/i.test(title)) {
      return {
        text: "Risk grade. Tier " + rk.tier.id + ", " + rk.tier.label + " risk. " + rk.tier.desc +
          " Probability of default in the next 12 months: " + pct(rk.pd * 100) + ". Loss given default for " + loanName + ": " + pct(rk.lgd * 100) +
          ". Expected loss: " + pct(rk.el * 100) + ".",
        ask: "Do you want to see why? Press Enter or say yes.",
        more: "Why: your credit score of " + s.result.score + " puts you in tier " + rk.tier.id + ". Out of every 1,000 borrowers with a score like yours, about " +
          Math.round(rk.pd * 1000) + " are expected to stop repaying within a year. That is the probability of default. If that happens, the bank expects to lose " +
          pct(rk.lgd * 100) + " of what is owed on " + loanName + ". That is the loss given default. Multiply the two and you get the expected loss, " +
          pct(rk.el * 100) + ", which the bank adds to your interest rate. A higher score means a better tier and a lower rate."
      };
    }
    var parts = rk.components.map(function (c) { return c.label + ", " + c.value.toFixed(2) + " percent"; }).join(". ");
    if (/^Risk-based interest rate/i.test(title)) {
      return {
        text: "Risk-based interest rate. " + rk.rate.toFixed(2) + " percent a year. For " + money(req.amount) + " over " + A.fmtTerm(req.termMonths).replace("yrs", "years").replace("yr", "year") +
          ", about " + money(K.risk.payment(req.amount, rk.rate, req.termMonths)) + " a month before lender adjustments. Risk premium: " + rk.riskPremium.toFixed(2) + " percent.",
        ask: "Do you want to see why? Press Enter or say yes.",
        more: "Why: your rate is made up of these parts. " + parts + ". Total, " + rk.rate.toFixed(2) + " percent. The risk premium of " + rk.riskPremium.toFixed(2) +
          " percent is the extra you pay because of your credit risk. Improving your score lowers it."
      };
    }
    if (/^How the rate is built/i.test(title)) {
      return {
        text: "How the rate is built. Rate equals the base rate, plus funding spread, expected loss, capital charge, operating cost, and margin. Total, " + rk.rate.toFixed(2) + " percent.",
        ask: "Do you want to see why each part exists? Press Enter or say yes.",
        more: rateBuiltText()
      };
    }
    if (/^Bank risk tiers/i.test(title)) {
      var rows = $$("tbody tr", el).map(function (tr) {
        var td = $$("td", tr).map(textOf);
        return "Tier " + speakNums(td[0]) + ": scores " + speakNums(td[1]) + ", default probability " + speakNums(td[2]) + ", rate " + speakNums(td[3]) + ".";
      });
      return {
        text: "Bank risk tiers. Banks group borrowers into tiers A to E. You are in tier " + rk.tier.id + ", " + rk.tier.label + ".",
        ask: "Do you want to hear every tier? Press Enter or say yes.",
        more: rows.join(" ")
      };
    }
    return { text: speakNums(textOf(el)) };
  }

  // ---- Step 2: score factor rows (expand to hear the explanation) ----
  function factorName(el) { // the h4 is: chevron, name text, rating badge, weight
    var h4 = $("h4", el), node = h4 && h4.childNodes[1];
    return node && node.nodeType === 3 ? node.textContent.trim() : textOf(h4 || el);
  }
  function factorInfo(el) {
    var name = factorName(el);
    var rating = textOf($(".badge", el)), share = textOf($(".small", el)), pts = textOf($(".pts", el)).replace(/(\d+) \/ (\d+) pts/, "$1 of $2 points");
    var open = el.getAttribute("aria-expanded") === "true";
    var f = factorByName(name);
    return {
      text: name + ". Rated " + rating + ". " + speakNums(share) + ". " + pts + "." + (f ? " " + improveText(f) : ""),
      ask: open ? "Press Enter to hide the explanation." : "Press Enter, or say yes, to hear why you got this rating."
    };
  }
  function factorByName(name) {
    var r = A.state.result;
    return r ? r.factors.filter(function (f) { return f.name === name; })[0] : null;
  }
  // "How to improve: … This could add up to 4 points." (or "already at the maximum")
  function improveText(f) {
    var t = "How to improve: " + speakNums(String(f.tip || "").trim());
    if (!/[.!?]$/.test(t)) t += ".";
    if (f.upside > 0) t += " This could add up to " + f.upside + (f.upside === 1 ? " point." : " points.");
    else if (f.points >= f.maxPoints) t += " You already have full points here.";
    return t;
  }
  function factorDetails(el) {
    var body = el.nextElementSibling;
    if (!body) return "";
    var good = $$(".reasons.pos li", body).map(textOf), bad = $$(".reasons.neg li", body).map(textOf);
    var t = factorName(el) + ". ";
    if (good.length) t += "Helping: " + speakNums(good.join(" ")) + " ";
    if (bad.length) t += "Holding it back: " + speakNums(bad.join(" ")) + " ";
    var f = factorByName(factorName(el));
    t += (f ? improveText(f) : speakNums(textOf($(".tip", body)))) + " " + textOf($(".uses", body)) + ".";
    return t.replace(/\.\./g, ".");
  }

  // ---- Buttons: say what pressing them will do, as a question ----
  function stepName(n) { var b = $('.step-btn[data-step="' + n + '"] .t'); return b ? textOf(b).toLowerCase() : ""; }
  function buttonQuestion(el) {
    if (el.closest("#voiceDock")) return "";
    if (el.id === "evalBtn") return "Do you want to evaluate your credit and go to the next step, step 2, " + stepName(2) + "? Press Enter or say yes.";
    var n = el.dataset.goto || (el.classList.contains("step-btn") ? el.dataset.step : null);
    if (n) {
      n = +n;
      if (n === V.step) return "This is the step you are on.";
      return "Do you want to go " + (n > V.step ? "to the next step" : "back") + ", step " + n + ", " + stepName(n) + "? Press Enter or say yes.";
    }
    if (el.matches("[data-choose]")) return "Do you want to see this offer in full? Press Enter or say yes.";
    if (el.matches("[data-confirm]")) return "Do you want to select this offer? Press Enter or say yes.";
    if (el.matches("[data-close]")) return "Do you want to go back to the offers? Press Enter or say yes.";
    if (el.matches("[data-persona]")) return "Do you want to fill in the form with this example? Press Enter or say yes.";
    return "";
  }
  // Things a "yes" (or Enter) can activate.
  function canActivate(el) {
    if (!el) return false;
    if (el.matches("button, a[href], summary, [data-toggle], [role=button], #dataTable")) return true;
    var sec = sectionInfo(el);
    return !!(sec && sec.more);
  }

  // Move focus to the next / previous item in reading order.
  function moveFocus(dir) {
    var root = navRoot();
    if (!root) return;
    var items = navItems(root), cur = document.activeElement, i = items.indexOf(cur);
    if (i < 0) { // focus is somewhere not in the list: continue from its position in the page
      i = dir > 0 ? -1 : items.length;
      if (cur && cur !== document.body) {
        for (var k = 0; k < items.length; k++) {
          if (cur.compareDocumentPosition(items[k]) & Node.DOCUMENT_POSITION_FOLLOWING) { i = dir > 0 ? k - 1 : k; break; }
        }
      }
    }
    var nxt = items[i + dir];
    if (!nxt) return say(dir > 0 ? "End of the page. Press the up arrow to go back." : "Top of the page.");
    if (!nxt.matches(NAV_SEL) && !nxt.hasAttribute("tabindex")) nxt.setAttribute("tabindex", "-1"); // text: focusable by script only
    V.navFocus = true;
    try { nxt.focus(); } finally { V.navFocus = false; }
    if (nxt.scrollIntoView) nxt.scrollIntoView({ block: "nearest" });
  }

  function nameOf(el) {
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
    if (el.matches("[data-choose]")) {
      var card = el.closest(".offer"), c = offerCards().filter(function (x) { return x.el === card; })[0];
      if (c) return "Choose option " + c.n + ", " + c.name + ". APR " + c.apr.replace("%", " percent") + ", " + c.monthly + " a month, total " + c.total + ", approval " + c.odds;
    }
    if (el.matches("[data-toggle]")) return textOf(el).replace(/(\d+) \/ (\d+) pts/, "$1 of $2 points");
    if (el.id) {
      var l = document.querySelector('label[for="' + el.id + '"]');
      if (l) return textOf(l).replace(/\s*\*$/, "");
    }
    var wrap = el.closest("label");
    if (wrap) return textOf(wrap) || "Upload a bank statement";
    return textOf(el) || el.title || el.placeholder || "";
  }

  // The words describing a link: its aria-describedby text, or the rest of its list item
  // (e.g. "National Debtline — free debt advice and tools…" -> "Free debt advice and tools…").
  function linkDescription(a) {
    var ids = (a.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    var d = ids.map(function (id) { return textOf(document.getElementById(id)); }).join(" ").trim();
    if (!d && a.closest("li")) {
      var li = a.closest("li").cloneNode(true);
      $$("a", li).forEach(function (x) { x.remove(); });
      d = textOf(li).replace(/^[\s—–:-]+/, "");
    }
    return d ? d.charAt(0).toUpperCase() + d.slice(1) + (/[.!?]$/.test(d) ? "" : ".") : "";
  }

  // Step 2 support message (shown for Poor / Very poor scores): intro plus every service and what it does.
  function supportText() {
    var box = $("#supportBox");
    if (!box || box.hidden || !$(".alert", box)) return "";
    var clone = $(".alert", box).cloneNode(true);
    $$("ul, ol", clone).forEach(function (x) { x.remove(); });
    var services = $$("#supportBox li a").map(function (a) { return textOf(a) + ": " + linkDescription(a); });
    return textOf(clone) + " " + services.join(" ") + " Use the down arrow to reach each link, and press Enter to open it in a new tab.";
  }

  // "The options are: Personal loan, Car finance, … and Mortgage." (spoken-friendly: "3 yrs" -> "3 years")
  function spokenOption(x) {
    return x ? speakNums(textOf(x)).replace(/\byrs?\b/g, function (w) { return w === "yr" ? "year" : "years"; }).replace(/\bmths?\b/g, "months") : "nothing";
  }
  function optionsText(sel) { return listOptions($$("option", sel).map(spokenOption)); }
  // "Term: 5 years selected." (a label ending in "?" keeps its question mark: "What do you want to borrow for? Car finance selected.")
  function selectedLine(sel) {
    var n = nameOf(sel);
    return n + (/[?.!:]$/.test(n) ? " " : ": ") + spokenOption(sel.selectedOptions[0]) + " selected.";
  }
  function listOptions(o) {
    if (!o.length) return "";
    return o.length === 1 ? "The only option is " + o[0] + "." : "The " + o.length + " options are: " + o.slice(0, -1).join(", ") + ", and " + o[o.length - 1] + ".";
  }
  // Short form after a change (arrow keys): don't re-read every option each time.
  function selectedText(sel) { return selectedLine(sel); }

  // ---- Step 2 "Data used for this score" table ----
  function tableRows(table) { return $$("tbody tr", table); }
  // Header names as written (textContent): CSS shows them in capitals, which innerText would copy.
  function tableHeads(table) { return $$("thead th", table).map(function (th) { return th.textContent.replace(/\s+/g, " ").trim(); }); }
  function rowText(tr) {
    var table = tr.closest("table"), heads = tableHeads(table), rows = tableRows(table);
    var cells = $$("td", tr).map(function (td, i) {
      var v = speakNums(textOf(td).replace(/\s*\/\s*month\b/, " a month"))
        .replace(/\b(\d+(?:\.\d+)?) ?yrs?\b/g, function (m, n) { return n + (n === "1" ? " year" : " years"); }).replace(/\bmths?\b/g, "months");
      return (heads[i] ? heads[i] + ": " : "") + v;
    });
    return "Row " + (rows.indexOf(tr) + 1) + " of " + rows.length + ". " + cells.join(". ") + ".";
  }
  function tableSummary(table) {
    var card = table.closest(".card"), title = card && $("h3", card) ? textOf($("h3", card)) : "Table";
    return title + ". " + tableRows(table).length + " rows, each with " + tableHeads(table).join(", ") + ".";
  }
  function tableAll(table) {
    return tableRows(table).map(function (tr) { return rowText(tr).replace(/^Row \d+ of \d+\. /, ""); }).join(" ");
  }

  // What to say when an element gets focus: {text, hint}.
  function describe(el) {
    if (el.matches("#dataTable")) return { text: tableSummary(el) + " Press the down arrow to read it row by row, or Enter to hear every row.", hint: "" };
    if (el.matches("#dataTable tbody tr")) return { text: rowText(el), hint: "" };
    if (el.matches("#supportBox .alert")) return { text: supportText(), hint: "" };
    var sec = sectionInfo(el);
    if (sec) return { text: sec.text + (sec.ask ? " " + sec.ask : ""), hint: "" };
    if (el.matches("[data-toggle]")) { var fi = factorInfo(el); return { text: fi.text + " " + fi.ask, hint: "" }; }
    var name = nameOf(el), tag = el.tagName, type = (el.type || "").toLowerCase(), text, hint = "";
    if (tag === "SELECT") {
      text = selectedLine(el) + " " + optionsText(el) +
        " Which one would you like? Say it, or use the left and right arrows.";
    } else if (type === "checkbox" || type === "radio") {
      var word = type === "radio" ? "selected" : "ticked";
      text = name + ", " + (el.checked ? word : "not " + word);
      hint = "Press Space to " + (type === "radio" ? "select it." : "tick or untick it.");
      if (el.dataset.multi) { // one of a group of tick boxes (step 1)
        var grp = $$('[data-multi="' + el.dataset.multi + '"]');
        text += ", option " + (grp.indexOf(el) + 1) + " of " + grp.length;
        hint = "Use the left and right arrows to move between options, and Space to tick or untick.";
      }
      text += ".";
    } else if (type === "file") {
      text = name + ".";
      hint = "Press Enter to choose a CSV file.";
    } else if (tag === "INPUT" || tag === "TEXTAREA") {
      var box = el.closest(".input"), unit = box && $(".unit", box), suf = box && $(".suffix", box);
      var sfx = suf ? " " + ({ yrs: "years", "%": "percent" }[textOf(suf)] || textOf(suf)) : "";
      text = name + ", " + (el.value ? (unit ? textOf(unit) : "") + el.value + sfx : "blank") + ".";
      hint = "Say your answer, or type it and press Enter.";
    } else if (tag === "A") {
      var about = linkDescription(el);
      text = name + "." + (about ? " " + about : "") + (el.target === "_blank" ? " Opens in a new tab." : "");
      hint = "Press Enter to open it.";
    } else if (tag === "SUMMARY") {
      text = name + ", " + (el.parentNode.open ? "open" : "closed") + ".";
      hint = "Press Enter to open or close it.";
    } else if (tag === "BUTTON" || el.getAttribute("role") === "button") {
      var st = [];
      if (el.hasAttribute("aria-expanded")) st.push(el.getAttribute("aria-expanded") === "true" ? "open" : "closed");
      if ((el.closest(".seg") && el.classList.contains("on")) || el.classList.contains("active")) st.push(el.classList.contains("step-btn") ? "current step" : "selected");
      text = name + (st.length ? ", " + st.join(", ") : "") + ".";
      var q = buttonQuestion(el);
      if (q) text += " " + q; // always asked: it tells the user what Enter will do
      else hint = el.hasAttribute("aria-expanded") ? "Press Enter to open or close it." : "Press Enter to select it.";
    } else if (/^H[1-6]$/.test(tag)) {
      text = name + (/[.!?:]$/.test(name) ? "" : ".");
    } else {

      text = speakNums(name) + (/[.!?:]$/.test(name) ? "" : ".");
    }
    var err = el.id && document.getElementById(el.id + "_err");
    if (err && textOf(err)) text += " Error: " + textOf(err);
    return { text: text, hint: hint };
  }
  // Give each kind of hint the first two times only, so navigation stays quick.
  function hintText(d) {
    if (!d.hint) return "";
    V.hinted[d.hint] = (V.hinted[d.hint] || 0) + 1;
    return V.hinted[d.hint] <= 2 ? " " + d.hint : "";
  }

  // Which step-1 question does this element belong to? (-1 = none)
  function queueIndexFor(el) {
    var key = el.closest("#typeSeg") ? "_type" : el.closest("#form") ? (el.dataset.multi || (el.id && el.id.indexOf("f_") === 0 ? el.id.slice(2) : null)) : null;
    if (!key) return -1;
    var i = keyIndex(key);
    if (i < 0) { V.queue = buildQueue(); i = keyIndex(key); }
    return i;
  }

  function onFocusIn(e) {
    var el = e.target;
    if (!V.on || V.selfFocus || !el || el === document.body || el === document) return;
    if (!V.navFocus && Date.now() - lastKeyAt > 1000) return; // mouse clicks and app focus moves aren't announced
    if (el.closest("#a11ySurvey")) return;
    V.focusEl = el;
    var d = describe(el);
    if (V.step === 1 && !el.closest("#voiceDock")) {
      var idx = queueIndexFor(el);
      if (idx >= 0) {
        var item = V.queue[idx];
        // Moving between the tick boxes of one question: just read the box.
        if (item.kind === "checks" && V.phase === "ask" && V.idx === idx) return say(d.text + hintText(d));
        if (item.kind === "type") return ask(idx, d.text + " ", { noFocus: true });
        return ask(idx, "", { noFocus: true, suffix: (item.kind === "checks" ? " " + d.text : "") + hintText(d) });
      }
      V.phase = "focus";
      highlight(null);
    }
    say(d.text + hintText(d));
  }

  function onKeyDown(e) {
    if (e.key === "Tab" || /^Arrow/.test(e.key)) V.kb = true;
    // Step 3 sections are text, not controls: give them a Tab stop while the assistant is on
    // (done here, before the browser moves focus, because the cards are redrawn when the loan changes).
    if (e.key === "Tab" && V.on) {
      $$("#riskOut .card, #riskOut .alert").forEach(function (c) { if (!$("svg", c)) c.setAttribute("tabindex", "0"); });
      var dt = $("#dataTable"); if (dt) dt.setAttribute("tabindex", "0"); // one Tab stop for the whole table; arrows go row by row
    }
    lastKeyAt = Date.now();
    if (!V.on || e.altKey || e.ctrlKey || e.metaKey) return;
    var el = e.target, tag = el.tagName || "", type = (el.type || "").toLowerCase();
    if (el.closest && el.closest("#a11ySurvey")) return;
    var modalOn = $("#modal").classList.contains("on");

    if (e.key === "Escape" && modalOn) { // app.js closes it; we announce and restore focus
      setTimeout(function () { if (!$("#modal").classList.contains("on")) afterModal("Closed. "); }, 0);
      return;
    }
    if (e.key === "Tab" && modalOn) { // keep Tab inside the offer dialog
      var f = navItems($("#modalBody")).filter(function (x) { return x.matches(NAV_SEL); });
      var at = f.indexOf(el);
      if (f.length && (e.shiftKey ? at <= 0 : at < 0 || at === f.length - 1)) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
      return;
    }
    if (e.shiftKey) return;
    // Step 1 groups (tick boxes like "Types of credit", Individual / Business): left and right move between the options.
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && ((type === "checkbox" && el.dataset.multi) || el.closest("#typeSeg"))) {
      var group = el.dataset.multi ? $$('[data-multi="' + el.dataset.multi + '"]') : $$("#typeSeg button");
      var j = group.indexOf(el) + (e.key === "ArrowRight" ? 1 : -1);
      e.preventDefault();
      if (j < 0 || j >= group.length) return say((j < 0 ? "First option. " : "Last option. ") + describe(el).text);
      V.navFocus = true;
      try { group[j].focus(); } finally { V.navFocus = false; }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (type === "radio" || type === "range" || tag === "TEXTAREA" || el.isContentEditable) return; // arrows already mean something there
      e.preventDefault(); // also stops number boxes counting up/down
      return moveFocus(e.key === "ArrowDown" ? 1 : -1);
    }
    if (e.key === "Enter") return onEnter(e, el, tag, type);
    if (e.key === " " && el.getAttribute && (el.getAttribute("tabindex") === "-1" || sectionInfo(el) || el.matches("#dataTable"))) { e.preventDefault(); activate(el); }
  }

  function onEnter(e, el, tag, type) {
    if (tag === "BUTTON" || tag === "A" || tag === "SUMMARY" || tag === "TEXTAREA" || el.matches("[data-toggle]")) return; // browser / app.js handles these
    if (type === "file") { e.preventDefault(); el.click(); return; }
    if (type === "checkbox" || type === "radio") { e.preventDefault(); el.click(); say(describe(el).text); return; }
    if (tag === "SELECT") {
      e.preventDefault();
      try { el.showPicker(); } catch (x) { say(describe(el).text); }
      return;
    }
    if (tag === "INPUT") { e.preventDefault(); return commitTyped(el); }
    if (el.getAttribute("tabindex") === "-1" || sectionInfo(el) || el.matches("#dataTable")) { e.preventDefault(); activate(el); } // step 3 section: "why"; data table: every row
  }

  // Enter in an edit box: check the typed answer, then move on like a spoken one.
  function commitTyped(el) {
    if (V.step === 1) {
      var idx = queueIndexFor(el);
      if (idx < 0) return;
      var item = V.queue[idx];
      if (item.kind === "number" && el.value) {
        var err = A.checkNumber(el, false);
        A.setErr(el, err);
        if (err) return say(err + " Please type it again, or say it.");
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      var shown = el.value ? (item.kind === "number" ? fmtValue(item, parseFloat(el.value)) : el.value) : "";
      var got = shown ? "Got it, " + item.label.replace(/[?.!]\s*$/, "") + ": " + shown + ". " : "";
      V.idx = idx; V.phase = "ask";
      if (idx + 1 >= V.queue.length) end(got); else ask(idx + 1, got);
      if (shown) showResult("✓ " + item.label + ": " + shown, "good");
      return;
    }
    if (el.closest("#loanForm") && el.dataset.num) {
      var v = parseFloat(el.value);
      setLoan(el.id, el.value, nameOf(el) + " set to " + (el.id === "lf_amount" ? money(v || 0) : el.value + " percent") + ". ");
    }
  }

  // Answering the question a focused button / row / section asked ("Do you want to…?").
  // Returns a function to run, or null if this isn't a yes or no for it.
  function yesNo(el, text, cmd) {
    if (cmd || !el || !canActivate(el)) return null;
    var c = clean(text);
    if (YES.test(c) || /^(please|do it|go ahead|go on|show me|tell me|why)\b/.test(c)) return function () { activate(el); };
    if (NO.test(c) || /^(not now|no thanks|skip)\b/.test(c)) return function () { say("OK. Use the arrow keys or Tab to move on."); };
    return null;
  }

  // "Press" by voice, or the Speak-free equivalent of Enter.
  function activate(el) {
    if (!el || !document.contains(el)) return say("Nothing is selected. Use Tab or the arrow keys to move.");
    var tag = el.tagName, type = (el.type || "").toLowerCase();
    var sec = sectionInfo(el);
    if (sec) return say(sec.more ? sec.more + " Press the down arrow to move on." : sec.text);
    if (el.matches("#dataTable")) return say(tableAll(el) + " End of table.");
    if (el.getAttribute("tabindex") === "-1" && !el.matches(NAV_SEL)) return say(describe(el).text); // plain text: read it again
    if (tag === "SELECT") { try { el.showPicker(); } catch (x) {} return say(describe(el).text); }
    if (tag === "INPUT" && type !== "checkbox" && type !== "radio" && type !== "file") return say(describe(el).text + " Say your answer.");
    el.click();
    if (type === "checkbox" || type === "radio") say(describe(el).text);
  }

  // A spoken answer for the focused control on steps 2–4 (loan form, sort list).
  function applyToFocused(el, alts) {
    var i;
    if (el.tagName === "SELECT") {
      var opts = $$("option", el).map(function (o) { return [o.value, textOf(o)]; }), o = null;
      for (i = 0; i < alts.length && !o; i++) o = matchOption(opts, alts[i]);
      if (!o) { // "five years" -> the "5 yrs" option
        var n = parseNumber(alts[0]);
        if (n !== null) o = opts.filter(function (x) { return parseNumber(x[1]) === n || +x[0] === n; })[0] || null;
      }
      if (!o) return false;
      if (el.closest("#loanForm")) { setLoan(el.id, o[0], nameOf(el) + ": " + o[1] + ". "); return true; }
      el.value = o[0];
      el.dispatchEvent(new Event("change", { bubbles: true }));
      if (el.id === "sortBy") sayThenListen("Sorted by " + o[1] + ". " + offersText(0));
      else say(selectedText(el));
      return true;
    }
    if (el.tagName === "INPUT" && el.dataset.num && el.closest("#loanForm")) {
      var v = null;
      for (i = 0; i < alts.length && v === null; i++) v = parseNumber(alts[i]);
      if (v === null) return false;
      setLoan(el.id, v, nameOf(el) + " set to " + (el.id === "lf_amount" ? money(v) : v + " percent") + ". ");
      return true;
    }
    return false;
  }

  // Lists and tick boxes changed with the keyboard: read the new value.
  function onChange(e) {
    var el = e.target;
    if (!V.on || !e.isTrusted || el.closest("#a11ySurvey")) return;
    var type = (el.type || "").toLowerCase();
    if (el.tagName !== "SELECT" && type !== "checkbox" && type !== "radio") return;
    if (el.closest("#loanForm")) { // app.js has already re-priced (and maybe re-drawn the form)
      var again = document.getElementById(el.id) || el;
      if (again !== document.activeElement && document.activeElement === document.body) selfFocus(again);
      return say((again.tagName === "SELECT" ? selectedText(again) : describe(again).text) + " " + rateLine());
    }
    if (el.id === "sortBy") return say("Sorted by " + textOf(el.selectedOptions[0]) + ". " + offersText(0));
    say(el.tagName === "SELECT" ? selectedText(el) : describe(el).text);
  }

  // Button presses from the keyboard (or voice): read what happened.
  function onClick(e) {
    if (!V.on) return;
    // Clicking a step 3 section with the mouse reads it, including the "why".
    var card = e.target.closest && !e.target.closest("button, a, input, select") && e.target.closest("#riskOut .card, #riskOut .alert");
    if (card && !$("svg", card)) { var info = sectionInfo(card); if (info) return say(info.text + (info.more ? " " + info.more : "")); }
    var t = e.target.closest && e.target.closest("[data-choose], [data-confirm], [data-close], button, a, summary, [data-toggle]");
    if (!t || t.closest("#voiceDock") || t.closest("#a11ySurvey")) return;
    if (t.matches("[data-choose]")) {
      V.phase = "modal";
      V.modalLender = t.dataset.choose;
      if (V.kb) selfFocus($("#modalBody [data-confirm]"));
      return say(modalText());
    }
    if (t.matches("[data-confirm]")) {
      var name = textOf($("#modalBody h2"));
      return afterModal("You've selected " + name + ". This is an indicative quote. The lender will run its own checks before making a final offer. ");
    }
    if (t.matches("[data-close]")) return afterModal("");
    // Mouse clicks are only announced for score breakdown rows (they reveal how to improve).
    if (e.detail !== 0 && !t.matches("[data-toggle]")) return;
    var s = V.session;
    setTimeout(function () { // only if nothing else (like a step change) has spoken
      if (!V.on || V.session !== s) return;
      if (t.id === "evalBtn" && A.state.step === 1) return say((textOf($("#formError")) || "Some answers need fixing.") + " Use the arrow keys to find the question.");
      if (t.matches("[data-toggle]")) { // step 2 factor: read the explanation when it opens
        return say(t.getAttribute("aria-expanded") === "true" ? factorDetails(t) + " Press Enter to hide it, or the down arrow to move on." : factorName(t) + ". Explanation hidden.");
      }
      say(t.hasAttribute("aria-expanded") || t.tagName === "SUMMARY" || t.closest(".seg") ? describe(t).text : "Pressed " + nameOf(t) + ".");
    }, 60);
  }
  function afterModal(msg) {
    V.phase = "page";
    if (V.kb) selfFocus($('[data-choose="' + V.modalLender + '"]') || $("[data-choose]") || $("#sortBy"));
    sayThenListen(msg + "Back to the offers. Say choose and an option number, or use the arrow keys.");
  }

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("mousedown", function () { lastKeyAt = 0; }, true);
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("change", onChange);
  document.addEventListener("click", onClick);

  // ==================================================================
  // Microphone permission
  // ==================================================================
  // A page can't grant itself permanent access — only the browser's
  // "Allow on every visit" choice (or site settings) can. We request access
  // once, guide the user to pick the persistent option, and detect when the
  // browser has forgotten it.
  var MIC_KEY = "kaml-mic-granted";
  var IS_FILE = location.protocol === "file:";
  function remembered() { try { return localStorage.getItem(MIC_KEY) === "1"; } catch (e) { return false; } }
  function remember() { try { localStorage.setItem(MIC_KEY, "1"); } catch (e) {} }

  function micHelp(kind) {
    var where = /Edg\//.test(navigator.userAgent) ? "Edge" : "Chrome";
    if (kind === "ask") {
      return "Your browser will ask to use the microphone. Choose “Allow on every visit” (or “Always allow”) so you won't be asked again." +
        (IS_FILE ? " Note: pages opened directly from a file may still ask each time — open the app through a local server (e.g. VS Code Live Server) for the setting to stick." : "");
    }
    if (kind === "forgot") {
      return "Your browser didn't keep the microphone permission from last time." +
        (IS_FILE ? " Browsers often can't remember permissions for pages opened from a file — open the app through a local server (e.g. VS Code Live Server)." : " When asked, choose “Allow on every visit”.");
    }
    return "Microphone access is blocked. To fix it: click the 🔒 / site-settings icon at the left of the " + where +
      " address bar → Microphone → Allow, then press Start again. You can still type answers and use the buttons.";
  }

  function micGranted(cb) {
    V.micReady = true;
    remember();
    showResult("", "");
    cb();
  }

  // cb(message): message (if any) is shown and spoken before the first question, so it isn't cut off.
  function ensureMic(cb) {
    function request() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return micGranted(cb); // let SpeechRecognition prompt itself
      setStatus("Waiting for microphone…");
      var help = (remembered() ? micHelp("forgot") + " " : "") + micHelp("ask");
      showResult(help, "");
      V.waitingMic = true; // don't start the recogniser while the browser's permission prompt is open
      say("Please allow microphone access so I can hear your answers. " + help);
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        stream.getTracks().forEach(function (t) { t.stop(); }); // we only needed the permission, not the stream
        V.waitingMic = false;
        micGranted(cb);
      }).catch(function (err) {
        V.waitingMic = false;
        V.listenOK = false;
        renderButtons();
        var blocked = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
        var msg = blocked ? micHelp("blocked") : "No microphone was found. You can type answers and use the buttons.";
        showResult(msg, "bad");
        cb(msg); // carry on with read-aloud + typing
      });
    }
    if (!navigator.permissions || !navigator.permissions.query) return request();
    navigator.permissions.query({ name: "microphone" }).then(function (status) {
      watchPermission(status);
      if (status.state === "granted") return micGranted(cb);
      if (status.state === "denied") {
        V.listenOK = false;
        renderButtons();
        showResult(micHelp("blocked"), "bad");
        return cb(micHelp("blocked"));
      }
      request();
    }).catch(request); // some browsers don't support querying "microphone"
  }

  // React if the user changes the permission in site settings mid-session.
  var watching = false;
  function watchPermission(status) {
    if (watching) return;
    watching = true;
    status.onchange = function () {
      if (status.state === "granted") {
        V.micReady = true; remember();
        V.listenOK = !!SR && (((K.accessibility && K.accessibility.get()) || {}).needs || []).some(function (n) { return n === "tts" || n === "stt"; });
        renderButtons();
        notify("Microphone allowed. Press Speak to answer.", "good");
      } else if (status.state === "denied") {
        V.micReady = false; V.listenOK = false;
        stopListening(); renderButtons();
        notify(micHelp("blocked"), "bad");
      } else {
        V.micReady = false; // reset to "ask" — request again next time we start
      }
    };
  }

  function cancel(spoken) {
    V.session++;
    stopListening();
    if (synth) synth.cancel();
    V.on = false;
    V.speaking = false;
    highlight(null);
    renderButtons();
    setStatus("off");
    setProgress("");
    var bye = "Voice assistant stopped. Press Start to continue where you left off.";
    showPrompt(bye);
    if (spoken && V.speakOK) {
      var u = new SpeechSynthesisUtterance(bye);
      u.lang = "en-GB"; u.rate = V.rate; synth.speak(u);
    }
  }

  // ==================================================================
  // Dock UI
  // ==================================================================
  var dock, mini;
  function buildDock() {
    dock = document.createElement("section");
    dock.id = "voiceDock";
    dock.className = "voice-dock";
    dock.setAttribute("aria-label", "Voice assistant");
    dock.hidden = true;
    dock.innerHTML =
      '<div class="vd-head"><span class="vd-title">🎙 Voice assistant</span><span class="vd-status" id="vdStatus">Ready</span>' +
      '<button type="button" class="vd-x" id="vdHide" aria-label="Hide voice assistant">×</button></div>' +
      '<div class="vd-progress" id="vdProgress"></div>' +
      '<p class="vd-prompt" id="vdPrompt" aria-live="polite">Press Start and I\'ll guide you through each step out loud.</p>' +
      '<div class="vd-heard" id="vdHeard" aria-live="polite"></div>' +
      '<div class="vd-result" id="vdResult" aria-live="polite"></div>' +
      '<div class="vd-ctrl">' +
      '<button type="button" data-v="prev">◀ Previous</button>' +
      '<button type="button" data-v="mic" class="vd-mic" id="vdMic">🎙 Speak</button>' +
      '<button type="button" data-v="repeat">↻ Repeat</button>' +
      '<button type="button" data-v="next">Next ▶</button></div>' +
      '<div class="vd-ctrl2"><button type="button" class="btn sm" data-v="start" id="vdStart">Start voice assistant</button>' +
      '<button type="button" class="btn ghost sm" data-v="cancel" id="vdCancel">Cancel</button></div>' +
      '<label class="vd-hp"><input type="checkbox" id="vdHp"> 🎧 I am using headphones — let me interrupt by voice</label>' +
      '<p class="vd-note">The mic turns on when I finish speaking, so I never mistake my own voice for yours. Then say <b>next</b>, <b>previous</b>, <b>repeat</b> or <b>cancel</b>. To interrupt me, press Speak or Alt+S. Move with Tab or the up and down arrows and I will read each item; press Enter or Space to select. Keys: Alt+N next, Alt+P previous, Alt+R repeat, Alt+C cancel, Alt+H to hear these instructions again (or say instructions). Speech recognition is provided by your browser; Chrome and Edge send audio to their online speech service.</p>';
    document.body.appendChild(dock);

    mini = document.createElement("button");
    mini.type = "button";
    mini.className = "voice-mini";
    mini.hidden = true;
    mini.setAttribute("aria-label", "Open voice assistant");
    mini.textContent = "🎙 Voice";
    document.body.appendChild(mini);

    dock.addEventListener("click", function (e) { var b = e.target.closest("[data-v]"); if (b) button(b.dataset.v); });
    $("#vdHide").addEventListener("click", function () { cancel(false); dock.hidden = true; mini.hidden = false; document.body.classList.remove("has-voice"); });
    mini.addEventListener("click", function () { showDock(); start(); });

    // Keyboard shortcuts — work at any time, including while the assistant is speaking.
    document.addEventListener("keydown", function (e) {
      if (!V.on || !e.altKey || e.ctrlKey || e.metaKey) return;
      var map = { n: "next", p: "prev", r: "repeat", c: "cancel", s: "mic", h: "instructions" };
      var a = map[(e.key || "").toLowerCase()];
      if (!a) return;
      e.preventDefault();
      button(a);
    });

    // Headphones mode: no echo reaches the mic, so it can stay on while we talk.
    var hp = $("#vdHp");
    try { V.duplex = localStorage.getItem(HP_KEY) === "1"; } catch (e) { V.duplex = false; }
    hp.checked = V.duplex;
    hp.addEventListener("change", function () {
      V.duplex = hp.checked;
      try { localStorage.setItem(HP_KEY, V.duplex ? "1" : "0"); } catch (e) {}
      if (V.on && V.speaking) { if (V.duplex) ensureListening(); else stopListening(); setStatus("speaking"); }
    });
  }
  var HP_KEY = "kaml-voice-headphones";
  function showDock() { dock.hidden = false; mini.hidden = true; document.body.classList.add("has-voice"); }
  function renderButtons() {
    $("#vdStart").hidden = V.on;
    $("#vdCancel").hidden = !V.on;
    $("#vdMic").hidden = !V.listenOK;
  }
  var STATUS = { idle: "Ready", speaking: "🔊 Speaking…", listening: "🎙 Listening…", paused: "Paused", off: "Off", type: "⌨ Type your answer" };
  function setStatus(s) {
    var el = $("#vdStatus");
    var label = s === "speaking" && !V.duplex ? "🔊 Speaking · mic off" : STATUS[s] || s;
    if (el) { el.textContent = label; el.dataset.s = s; }
    var m = $("#vdMic");
    if (m) m.textContent = V.speaking ? "✋ Interrupt" : "🎙 Speak";
  }
  function setMic(on) { var m = $("#vdMic"); if (m) m.classList.toggle("on", on); }
  function setProgress(t) { $("#vdProgress").textContent = t; }
  function showPrompt(t) { $("#vdPrompt").textContent = t; }
  function showHeard(t, interim) {
    var h = $("#vdHeard");
    h.innerHTML = t ? '<span class="vd-label">You said:</span> <span class="' + (interim ? "interim" : "") + '"></span>' : "";
    if (t) h.lastChild.textContent = "“" + t + "”";
  }
  function showResult(t, kind) { var r = $("#vdResult"); r.textContent = t || ""; r.className = "vd-result " + (kind || ""); }

  // ==================================================================
  // Activation from accessibility preferences
  // ==================================================================
  function applyPrefs(p, fromSurvey) {
    var needs = (p && p.needs) || [];
    var wantSpeak = needs.indexOf("tts") >= 0, wantListen = needs.indexOf("stt") >= 0 || wantSpeak;
    V.rate = { slow: 0.8, normal: 1, fast: 1.25 }[p && p.speechRate] || 1;
    V.speakOK = wantSpeak && !!synth;
    V.listenOK = wantListen && !!SR;
    var enabled = wantSpeak || wantListen;
    // Browser speech recognition (Chrome/Edge) is cloud-based, so the "nothing leaves your device" badge must change.
    var badge = $(".privacy");
    if (badge) {
      if (!badge.dataset.orig) badge.dataset.orig = badge.textContent;
      badge.textContent = V.listenOK ? "🔒 Your financial data stays in your browser · 🎙 spoken answers use your browser's speech service" : badge.dataset.orig;
    }
    if (!enabled) { if (V.on) cancel(false); dock.hidden = true; mini.hidden = true; document.body.classList.remove("has-voice"); return; }
    showDock();
    renderButtons();
    if (!SR && wantListen) {
      var nsr = "Speech recognition isn't available in this browser (try Chrome or Edge). " + (V.speakOK ? "Questions will be read aloud; type answers and press Next." : "");
      if (fromSurvey) showResult(nsr, ""); else notify(nsr, ""); // from the survey, start() reads it before the first question
    }
    // The survey's Save click counts as a user gesture, so speech can start right away.
    if (fromSurvey) start();
  }

  buildDock();
  window.addEventListener("kaml:step", onStep);
  window.addEventListener("kaml:accessibility", function (e) { applyPrefs(e.detail, true); });
  V.step = A.state.step || 1;
  if (K.accessibility) applyPrefs(K.accessibility.get(), false);

  K.voice = { parseNumber: parseNumber, matchOption: matchOption, start: start, cancel: cancel, state: V, _handle: handle, _route: route };
})();
