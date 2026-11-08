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
    session: 0, turn: 0, speaking: false, saying: "", prevSaying: "", spokeEndAt: 0, restarts: [], misses: 0, utts: [], rec: null, offerStart: 0, introDone: false, lastSaid: ""
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
    var m = /^(go to|change|edit|jump to)\s+(.+)$/.exec(t);
    if (m) return { go: m[2] };
    return null;
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
  function say(text, then) {
    V.lastSaid = text;
    V.saying = "";
    V.turn++; // anything heard from now on belongs to this prompt
    showPrompt(text);
    var my = ++V.session;
    if (!V.speakOK) { V.speaking = false; ensureListening(); if (then) then(); return; }
    V.speaking = true;
    if (V.duplex) ensureListening(); else stopListening(); // mic off while talking
    synth.cancel();
    var parts = text.match(/[^.?!]+[.?!]*/g) || [text];
    V.utts = [];
    V.speaking = true;
    setStatus("speaking");
    parts.forEach(function (p, i) {
      var u = new SpeechSynthesisUtterance(p.trim());
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
        showResult(micHelp("blocked"), "bad");
      } else if (e.error === "network") {
        fatal = true;
        showResult("Speech recognition needs an internet connection in this browser. You can type your answers and use the buttons instead.", "bad");
      } else if (e.error === "audio-capture") {
        fatal = true;
        showResult("No microphone was found.", "bad");
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
      if (V.restarts.length > 6) { setStatus("paused"); showResult("Listening paused. Press Speak to continue.", ""); return; }
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
    switch (item.kind) {
      case "type": q = "Are you applying as an individual, or for a business?"; break;
      case "select": q = item.label + ". Choose from: " + item.options.map(function (o) { return o[1]; }).join(", ") + "."; break;
      case "checkbox": q = item.label + "? Say yes or no."; break;
      case "checks": q = item.label + ". Say any of: " + item.options.map(function (o) { return o[1]; }).join(", ") + ". Or say none."; break;
      case "text": q = item.label + "?"; break;
      default: q = item.label + unitPhrase(item) + "?";
    }
    var cur = item.kind === "type" ? "" : currentDisplay(item);
    if (cur && item.kind !== "type") q += " Currently " + cur + ".";
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

  function ask(i, prefix) {
    if (V.phase === "ask") refreshFieldError(V.queue[V.idx]);
    $$(".voice-focus").forEach(function (e) { e.classList.remove("voice-focus"); });
    V.idx = Math.max(0, Math.min(i, V.queue.length - 1));
    V.phase = "ask";
    var item = V.queue[V.idx];
    showHeard("");      // clear the previous question's transcript…
    showResult("", ""); // …and its result / error line
    highlight(item);
    setProgress("Question " + (V.idx + 1) + " of " + V.queue.length);
    var intro = "";
    if (!V.introDone) {
      V.introDone = true;
      intro = "I'll ask you each question in turn. Answer out loud, or say skip, previous, or cancel at any time. ";
    }
    sayThenListen((prefix || "") + intro + question(item));
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
    setProgress("All questions done");
    sayThenListen((prefix || "") + "That was the last question. Say evaluate to get your credit score, previous to go back, start over, or cancel.");
  }

  function goToField(name) {
    var target = words(name);
    var best = -1, score = 0;
    V.queue.forEach(function (it, i) {
      var s = words(it.label).filter(function (w) { return target.indexOf(w) >= 0; }).length;
      if (s > score) { score = s; best = i; }
    });
    if (best < 0) return sayThenListen("I couldn't find a question called " + name + ". Try saying go to, then part of the question, like go to monthly income.");
    ask(best);
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
    if (cmd === "next") return V.phase === "end" ? sayThenListen("That was the last question. Say evaluate, previous, or cancel.") : next();
    if (cmd === "prev") return prev();
    if (cmd === "repeat") return V.phase === "end" ? end() : ask(V.idx);
    if (cmd === "restart") return ask(0);
    if (cmd === "evaluate") return doEvaluate();
    if (cmd && cmd.go) return goToField(cmd.go);
    if (V.phase === "end") return sayThenListen("Sorry, I didn't understand. Say evaluate, previous, start over, or cancel.");

    var item = V.queue[V.idx];
    var r = applyAnswer(item, alts);
    if (!r.ok) { showResult(r.msg, "bad"); return sayThenListen(r.msg); }
    // Answer accepted: move straight on so the next thing the user says belongs to the next question.
    // (Saying "previous" goes back to change it.)
    var done = "✓ " + item.label + ": " + r.display;
    var got = "Got it, " + r.display + ". ";
    if (V.idx + 1 >= V.queue.length) end(got); else ask(V.idx + 1, got);
    showResult(done, "good");
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

  function stepText(step) {
    var s = A.state, r = s.result;
    if (step === 2) {
      var pos = [], neg = [];
      r.factors.slice().sort(function (a, b) { return b.weight - a.weight; }).forEach(function (f) { pos = pos.concat(f.positives); neg = neg.concat(f.negatives); });
      var t = "Step 2, your credit score. Your score is " + r.score + " out of 850, which is rated " + r.band.label + ". ";
      if (pos.length) t += "Helping your score: " + pos.slice(0, 2).join(" ") + " ";
      if (neg.length) t += "Holding it back: " + neg.slice(0, 2).join(" ") + " ";
      if (r.hurting[0]) t += "Your best way to improve: " + r.hurting[0].tip + " That could add up to " + r.hurting[0].upside + " points. ";
      return t + "Say details to hear every factor, next for your interest rate, previous to change your answers, or cancel.";
    }
    if (step === 3) {
      var rk = s.risk, req = s.request[s.type];
      var pay = K.risk.payment(req.amount, rk.rate, req.termMonths);
      var t3 = "Step 3, risk and interest rate. You're in risk tier " + rk.tier.id + ", " + rk.tier.label + ". The estimated chance of default in the next year is " + pct(rk.pd * 100) + ". ";
      if (rk.declined) t3 += "That is above what most mainstream lenders accept. ";
      t3 += "For " + rk.product.label.split(" (")[0].toLowerCase() + " of " + money(req.amount) + " over " + A.fmtTerm(req.termMonths).replace("yr", "year") +
        ", the risk-based interest rate is " + rk.rate.toFixed(2) + " percent, about " + money(pay) + " a month. ";
      return t3 + "You can say amount followed by a number, term followed by years, the loan type such as car or mortgage, next for loan offers, previous, or cancel.";
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
    sayThenListen((prefix || "") + stepText(step));
  }

  function handlePage(alts, cmd) {
    var text = alts[0], c = clean(text), step = V.step;

    // Offer detail modal
    if (V.phase === "modal") {
      if (/^(confirm|select|select it|select this|yes|choose it|i'll take it|take it|accept)/.test(c)) {
        var btn = $("[data-confirm]"); var name = $("#modalBody h2").textContent;
        if (btn) btn.click();
        V.phase = "page";
        return sayThenListen("You've selected " + name + ". This is an indicative quote. The lender will run its own checks before making a final offer. Say repeat to hear the offers again, previous, or cancel.");
      }
      if (/^(back|no|close|go back|return|cancel)/.test(c)) {
        var close = $("[data-close]"); if (close) close.click();
        V.phase = "page";
        return sayThenListen("Back to the offers. Say choose and an option number, repeat, or cancel.");
      }
      return sayThenListen("Say confirm to select this offer, or back to return to the list.");
    }

    if (step === 4 && /^(more|more offers|next offers|the rest|rest)$/.test(c)) return sayThenListen(offersText(V.offerStart + 4));
    if (cmd === "cancel") return cancel(true);
    if (cmd === "repeat") return readStep(step);
    if (cmd === "next") {
      if (step >= 4) return sayThenListen("This is the last step. Say choose and an option number, previous, or cancel.");
      return A.go(step + 1);
    }
    if (cmd === "prev") return A.go(step - 1);
    if (cmd === "restart") return A.go(1);

    if (step === 2) {
      if (/detail|factor|breakdown|everything|more/.test(c)) {
        var t = A.state.result.factors.map(function (f) { return f.name + ": " + f.rating + ", " + f.points + " of " + f.maxPoints + " points."; }).join(" ");
        return sayThenListen(t + " Say tips to hear how to improve, next, or cancel.");
      }
      if (/tip|improve|help|better/.test(c)) {
        var h = A.state.result.hurting;
        var tt = h.length ? h.map(function (f) { return f.name + ": " + f.tip; }).join(" ") : "Nothing is seriously holding your score back. Keep doing what you're doing.";
        return sayThenListen(tt + " Say next for your interest rate, or cancel.");
      }
    }

    if (step === 3) {
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
        $("[data-choose]", pickC.el).click();
        V.phase = "modal";
        var dl = $$("#modalBody dt").map(function (dt) { return dt.textContent + ": " + dt.nextElementSibling.textContent + "."; }).join(" ");
        dl = dl.replace(/%/g, " percent").replace(/\bp\.a\.\.?/g, "a year.").replace(/(\d) yrs?\b/g, function (m, d) { return d + (d === "1" ? " year" : " years"); });
        return sayThenListen("Option " + pickC.n + ", " + pickC.name + ". " + dl + " Say confirm to select this offer, or back to return to the list.");
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
    var rk = A.state.risk, req = A.state.request[A.state.type];
    sayThenListen(msg + "The interest rate is now " + rk.rate.toFixed(2) + " percent, about " + money(K.risk.payment(req.amount, rk.rate, req.termMonths)) +
      " a month. Say another change, next for loan offers, or cancel.");
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

  function begin() {
    if (!V.on) return;
    if (V.step === 1) {
      V.queue = buildQueue();
      if (!V.listenOK && SR === undefined) showResult("Speech recognition isn't supported in this browser, so type each answer and press Next. Questions will still be read aloud.", "");
      ask(V.idx || 0);
    } else readStep(V.step);
  }

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

  function ensureMic(cb) {
    function request() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return micGranted(cb); // let SpeechRecognition prompt itself
      setStatus("Waiting for microphone…");
      showResult((remembered() ? micHelp("forgot") + " " : "") + micHelp("ask"), "");
      showPrompt("Please allow microphone access so I can hear your answers.");
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        stream.getTracks().forEach(function (t) { t.stop(); }); // we only needed the permission, not the stream
        micGranted(cb);
      }).catch(function (err) {
        V.listenOK = false;
        renderButtons();
        var blocked = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
        showResult(blocked ? micHelp("blocked") : "No microphone was found. You can type answers and use the buttons.", "bad");
        cb(); // carry on with read-aloud + typing
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
        return cb();
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
        showResult("Microphone allowed. Press Speak to answer.", "good");
      } else if (status.state === "denied") {
        V.micReady = false; V.listenOK = false;
        stopListening(); renderButtons();
        showResult(micHelp("blocked"), "bad");
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
    showPrompt("Voice assistant stopped. Press Start to continue where you left off.");
    if (spoken && V.speakOK) {
      var u = new SpeechSynthesisUtterance("Voice assistant stopped.");
      u.rate = V.rate; synth.speak(u);
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
      '<p class="vd-note">The mic turns on when I finish speaking, so I never mistake my own voice for yours. Then say <b>next</b>, <b>previous</b>, <b>repeat</b> or <b>cancel</b>. To interrupt me, press Speak or Alt+S. Keys: Alt+N next, Alt+P previous, Alt+R repeat, Alt+C cancel. Speech recognition is provided by your browser; Chrome and Edge send audio to their online speech service.</p>';
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
      var map = { n: "next", p: "prev", r: "repeat", c: "cancel", s: "mic" };
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
    if (!SR && wantListen) showResult("Speech recognition isn't available in this browser (try Chrome or Edge). " + (V.speakOK ? "Questions will be read aloud; type answers and press Next." : ""), "");
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
