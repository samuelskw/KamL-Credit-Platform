/*  */(function () {
  "use strict";
  var K = window.KamL, S = K.scoring, R = K.risk, L = K.lenders, T = K.transactions;
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };
  var money = S.money, pct = S.pct;
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function money2(v) { return "£" + v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  // ------------------------------------------------------------------
  // Form schema. `factor` links each input to the score factor it feeds.
  // ------------------------------------------------------------------
  var SCHEMA = {
    individual: [
      { title: "Income & employment", desc: "Used to judge stability and affordability.", fields: [
        { id: "age", label: "Age", suffix: "yrs", factor: null, note: "Eligibility only (18+)", def: 30 },
        { id: "employmentStatus", label: "Employment status", type: "select", factor: "stability", def: "full-time",
          options: [["full-time", "Employed full-time"], ["part-time", "Employed part-time"], ["self-employed", "Self-employed"], ["retired", "Retired"], ["student", "Student"], ["unemployed", "Unemployed"]] },
        { id: "yearsEmployed", label: "Years in current job", suffix: "yrs", factor: "stability", step: 0.5 },
        { id: "monthlyIncome", label: "Monthly income (after tax)", unit: "£", factor: "dti", required: true },
        { id: "incomeVariability", label: "How regular is your income?", type: "select", factor: "stability", def: "stable",
          options: [["stable", "Same every month"], ["some", "Varies a little"], ["high", "Varies a lot"]] },
        { id: "yearsAtAddress", label: "Years at current address", suffix: "yrs", factor: "stability", step: 0.5 }
      ]},
      { title: "Credit & debt", desc: "Your existing borrowing.", fields: [
        { id: "monthlyDebtPayments", label: "Monthly debt repayments", unit: "£", factor: "dti", help: "Loans, cards, car finance, mortgage" },
        { id: "totalCreditLimit", label: "Total card & overdraft limits", unit: "£", factor: "utilisation" },
        { id: "totalCreditBalance", label: "Current balances on those", unit: "£", factor: "utilisation" },
        { id: "oldestAccountYears", label: "Age of oldest credit account", suffix: "yrs", factor: "history", step: 0.5 },
        { id: "numAccounts", label: "Number of credit accounts", factor: "history" },
        { id: "hardInquiries12m", label: "Credit applications (12 months)", factor: "inquiries" },
        { id: "creditMix", label: "Types of credit you hold", type: "checks", factor: "history", wide: true,
          options: [["card", "Credit card"], ["installment", "Personal loan"], ["car", "Car finance"], ["mortgage", "Mortgage"]] }
      ]},
      { title: "Repayment record", desc: "The biggest single driver of your score. Rent and utility history counts too — good news if you're new to credit.", fields: [
        { id: "latePayments12m", label: "Late payments, last 12 months", factor: "payment" },
        { id: "latePaymentsOlder", label: "Late payments, 1–6 years ago", factor: "payment" },
        { id: "defaults", label: "Defaults or CCJs", factor: "payment" },
        { id: "rentOnTimeMonths", label: "Months of on-time rent/bills", factor: "payment", help: "Out of the last 12–24" },
        { id: "bankruptcy", label: "Bankruptcy / IVA (last 6 yrs)", type: "checkbox", factor: "payment" }
      ]},
      { title: "Savings", desc: "Your cushion against unexpected costs.", fields: [
        { id: "savings", label: "Cash savings", unit: "£", factor: "savings" },
        { id: "investments", label: "Investments / ISAs / pensions accessible", unit: "£", factor: "savings" }
      ]},
      { title: "Monthly spending habits", desc: "Average per month — or upload a bank statement to fill these in automatically.", spending: true, fields: [
        { id: "overdraftDaysPerMonth", label: "Days overdrawn per month", factor: "spending" }
      ]}
    ],
    business: [
      { title: "About the business", desc: "", fields: [
        { id: "businessName", label: "Business name", type: "text", factor: null, note: "Not scored" },
        { id: "industry", label: "Industry", type: "select", factor: "maturity", def: "retail",
          options: Object.keys(S.INDUSTRY_RISK).map(function (k) { return [k, S.INDUSTRY_RISK[k].label]; }) },
        { id: "yearsInOperation", label: "Years trading", suffix: "yrs", factor: "maturity", step: 0.5 },
        { id: "employees", label: "Employees", factor: null, note: "Not scored" },
        { id: "ownerCreditScore", label: "Owner's personal credit score", factor: "maturity", help: "300–850, optional" }
      ]},
      { title: "Financial performance", desc: "From your latest accounts or management figures.", fields: [
        { id: "annualRevenue", label: "Revenue, last 12 months", unit: "£", factor: "growth", required: true },
        { id: "prevAnnualRevenue", label: "Revenue, prior 12 months", unit: "£", factor: "growth" },
        { id: "annualOperatingExpenses", label: "Operating expenses (12m)", unit: "£", factor: "profit", help: "All costs except loan repayments" },
        { id: "cashReserves", label: "Cash reserves", unit: "£", factor: "liquidity" }
      ]},
      { title: "Debt & repayment record", desc: "", fields: [
        { id: "totalBusinessDebt", label: "Total business debt", unit: "£", factor: "leverage" },
        { id: "annualDebtService", label: "Annual loan repayments", unit: "£", factor: "dscr", help: "Principal + interest" },
        { id: "latePayments12m", label: "Late payments, last 12 months", factor: "payment" },
        { id: "defaults", label: "Defaults or CCJs", factor: "payment" },
        { id: "supplierDaysBeyondTerms", label: "Avg. days paying suppliers late", suffix: "days", factor: "payment" }
      ]},
      { title: "Spending & cash flow", desc: "Upload a business bank statement to derive these.", fields: [
        { id: "overdraftDaysPerMonth", label: "Days overdrawn per month", factor: "liquidity" },
        { id: "discretionaryExpenseShare", label: "Non-essential spend share", suffix: "%", factor: "spending", help: "Entertainment, travel, subscriptions…" }
      ]}
    ]
  };

  var NEVER_USED = ["Race or ethnicity", "Religion", "Gender", "Sexual orientation", "Marital status", "Nationality", "Disability", "Pregnancy", "Postcode / neighbourhood", "Social media", "Age (beyond 18+ check)"];

  var state = {
    type: "individual",
    data: { individual: {}, business: {} },
    result: null, risk: null,
    request: { individual: { productId: "personal", amount: 10000, termMonths: 36 }, business: { productId: "working", amount: 50000, termMonths: 36 } },
    settings: { baseRate: R.SETTINGS.baseRate },
    sort: "apr", chosen: null, maxStep: 1
  };

  // ------------------------------------------------------------------
  // Firebase authentication and per-user cloud profile persistence.
  // Uses the existing KamLAuth interface in auth.js (no new backend code).
  // ------------------------------------------------------------------
  var defaultState = JSON.parse(JSON.stringify(state));
  var authUser = null, authEpoch = 0, profileLoading = true;
  var signingOut = false, saveTimer = null, saveRevision = 0;
  var authMode = "login", guestActive = false;
  var GUEST_PROFILE_KEY = "kaml-guest-profile-v1";
  var GUEST_SESSION_KEY = "kaml-guest-session-v1";

  // Guest data never touches Firebase. It belongs only to this browser.
  function guestSessionSaved() {
    try { return localStorage.getItem(GUEST_SESSION_KEY) === "1"; }
    catch (error) { return false; }
  }

  function rememberGuestSession(active) {
    try {
      if (active) localStorage.setItem(GUEST_SESSION_KEY, "1");
      else localStorage.removeItem(GUEST_SESSION_KEY);
    } catch (error) { console.warn("Guest session cannot be remembered:", error); }
  }

  function readGuestProfile() {
    try {
      var value = localStorage.getItem(GUEST_PROFILE_KEY);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.warn("Guest profile could not be restored:", error);
      return null;
    }
  }

  function saveStatus(message) {
    var el = $("#saveStatus");
    el.textContent = message || "";
    el.title = message || "";
  }

  function setAppVisible(visible) {
    $("#authGate").style.display = visible ? "none" : "block";
    $("#appMain").style.display = visible ? "block" : "none";
    $("#steps").style.display = visible ? "flex" : "none";
    $("#authUserEmail").style.display = visible ? "inline" : "none";
    $("#saveStatus").style.display = visible ? "inline" : "none";
    $("#logoutBtn").style.display = (visible || authUser) ? "inline-block" : "none";
    $("#logoutBtn").textContent = guestActive ? "Sign in" : "Log out";
    $(".privacy").textContent = guestActive
      ? "Guest mode"
      : "🔒 Your account profile is stored in Firebase";
  }

  function resetProfile() {
    Object.keys(defaultState).forEach(function (key) {
      state[key] = JSON.parse(JSON.stringify(defaultState[key]));
    });
    state.step = 1;
    state.csvApplied = null;
    state.lastOffers = null;
    $("#csvResult").innerHTML = "";
    $("#formError").innerHTML = "";
    $("#sortBy").value = "apr";
    $$("#typeSeg button").forEach(function (b) {
      b.classList.toggle("on", b.dataset.type === state.type);
    });
    renderForm();
    go(1);
  }

  function isRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value);
  }

  // Display settings live alongside the financial profile in Firestore.
  // Use explicit defaults for accounts created before preferences were saved,
  // so a different account's browser-local choices do not carry across.
  function applyAccountPreferences(saved) {
    var display = isRecord(saved) && isRecord(saved.display) ? saved.display : {};
    if (K.display) {
      K.display.set({
        scale: display.scale === undefined ? 1 : display.scale,
        cvd: display.cvd === undefined ? "none" : display.cvd,
        dyslexia: display.dyslexia === true,
        attention: display.attention === true
      });
    }
    var theme = isRecord(saved) ? saved.theme : null;
    if (theme === "light" || theme === "dark") {
      document.documentElement.dataset.theme = theme;
      try { localStorage.setItem("kaml-theme", theme); } catch (err) {}
    } else {
      document.documentElement.removeAttribute("data-theme");
      try { localStorage.removeItem("kaml-theme"); } catch (err) {}
    }
  }

  function applySavedProfile(profile) {
    resetProfile();
    applyAccountPreferences(isRecord(profile) ? profile.preferences : null);
    if (!isRecord(profile)) return;
    state.type = profile.type === "business" ? "business" : "individual";
    if (isRecord(profile.data)) {
      ["individual", "business"].forEach(function (t) {
        if (isRecord(profile.data[t])) state.data[t] = profile.data[t];
      });
    }
    if (isRecord(profile.request)) {
      ["individual", "business"].forEach(function (t) {
        if (isRecord(profile.request[t])) {
          state.request[t] = Object.assign({}, defaultState.request[t], profile.request[t]);
        }
      });
    }
    if (isRecord(profile.settings) && Number.isFinite(profile.settings.baseRate)) {
      state.settings.baseRate = profile.settings.baseRate;
    }
    if (["apr", "monthly", "total", "likelihood"].indexOf(profile.sort) >= 0) state.sort = profile.sort;
    state.chosen = typeof profile.chosen === "string" ? profile.chosen : null;
    state.csvApplied = typeof profile.csvApplied === "string" ? profile.csvApplied : null;
    $$("#typeSeg button").forEach(function (b) {
      b.classList.toggle("on", b.dataset.type === state.type);
    });
    $("#sortBy").value = state.sort;
    renderForm();
    if (profile.evaluated === true) {
      try {
        state.result = S.evaluate(state.type, state.data[state.type]);
        state.maxStep = 4;
        renderScore();
        renderLoanForm();
        renderRisk();
        renderOffers();
      } catch (error) {
        state.result = null;
        state.maxStep = 1;
        console.warn("Saved evaluation could not be rebuilt:", error);
      }
    }
    var step = Number(profile.step);
    go(Number.isInteger(step) && step >= 1 && step <= state.maxStep ? step : 1);
  }

  function snapshotProfile() {
    state.data[state.type] = readForm();
    return {
      type: state.type,
      data: state.data,
      request: state.request,
      settings: state.settings,
      sort: state.sort,
      chosen: state.chosen,
      csvApplied: state.csvApplied || null,
      evaluated: state.maxStep >= 4 && !!state.result,
      step: state.step || 1,
      preferences: {
        display: K.display ? K.display.get() : { scale: 1, cvd: "none", dyslexia: false, attention: false },
        theme: document.documentElement.dataset.theme || "system"
      }
    };
  }

  function scheduleSave() {
    if ((!authUser && !guestActive) || profileLoading || signingOut) return;
    clearTimeout(saveTimer);
    saveStatus("Unsaved changes…");
    ++saveRevision;
    saveTimer = setTimeout(function () { saveTimer = null; persistProfile(); }, 650);
  }

  async function persistProfile() {
    if ((!authUser && !guestActive) || profileLoading || signingOut) return;
    var userId = guestActive ? null : authUser.uid, revision = saveRevision;
    try {
      var data = snapshotProfile();
      saveStatus("Saving…");
      if (guestActive) {
        // Local-only guest profile: do not call KamLAuth.save / Firestore.
        localStorage.setItem(GUEST_PROFILE_KEY, JSON.stringify(data));
        if (guestActive && revision === saveRevision) saveStatus("Saved ✓");
      } else {
        await window.KamLAuth.save(data);
        if (authUser && authUser.uid === userId && revision === saveRevision) saveStatus("Saved ✓");
      }
    } catch (error) {
      if (guestActive || (authUser && authUser.uid === userId)) saveStatus("Save failed: " + error.message);
    }
  }

  function enterGuest() {
    clearTimeout(saveTimer);
    saveTimer = null;
    ++authEpoch;
    authUser = null;
    guestActive = true;
    profileLoading = true;
    rememberGuestSession(true);
    applySavedProfile(readGuestProfile());
    profileLoading = false;
    setAppVisible(true);
    $("#authUserEmail").textContent = "Guest";
    saveStatus("Ready");
    window.KamLApp.authReady = true;
    window.dispatchEvent(new CustomEvent("kaml:authenticated"));
  }

  function closeVoiceUi() {
    if (window.KamL && window.KamL.voice) window.KamL.voice.cancel(false);
    var voiceDock = $("#voiceDock"), voiceMini = $(".voice-mini");
    if (voiceDock) voiceDock.hidden = true;
    if (voiceMini) voiceMini.hidden = true;
    document.body.classList.remove("has-voice");
  }

  function displayAuthForm(message) {
    setAppVisible(false);
    $("#authForm").style.display = "block";
    $("#guestBtn").style.display = "block";
    $("#authRetry").style.display = "none";
    $("#authStatus").textContent = message || "Log in to continue.";
    $("#authSubmit").disabled = false;
    $("#authSubmit").textContent = authMode === "login" ? "Log in" : "Create account";
  }

  function setAuthMode(mode) {
    authMode = mode;
    var register = mode === "register";
    $("#authTitle").textContent = register ? "Create an account" : "Log in";
    $("#authConfirmWrap").style.display = register ? "block" : "none";
    $("#authConfirm").required = register;
    $("#authPassword").autocomplete = register ? "new-password" : "current-password";
    $("#authSubmit").textContent = register ? "Create account" : "Log in";
    $("#authSwitchLabel").textContent = register ? "Already have an account?" : "Don't have an account?";
    $("#authSwitch").textContent = register ? "Log in instead" : "Create an account";
    $("#authError").textContent = "";
  }

  async function loadCurrentAccount(user, epoch) {
    profileLoading = true;
    setAppVisible(false);
    $("#authForm").style.display = "none";
    $("#guestBtn").style.display = "none";
    $("#authRetry").style.display = "none";
    $("#authStatus").textContent = "Loading your saved profile…";
    try {
      var saved = await window.KamLAuth.load();
      if (epoch !== authEpoch || !authUser || authUser.uid !== user.uid) return;
      applySavedProfile(saved);
      profileLoading = false;
      setAppVisible(true);
      $("#authUserEmail").textContent = user.email || "Signed in";
      saveStatus("All changes saved automatically");
      window.KamLApp.authReady = true;
      window.dispatchEvent(new CustomEvent("kaml:authenticated"));
    } catch (error) {
      if (epoch !== authEpoch) return;
      $("#authStatus").textContent = "Your profile could not be loaded: " + error.message;
      $("#authRetry").style.display = "inline-block";
      $("#logoutBtn").style.display = "inline-block";
    }
  }

  function bindAuthentication() {
    var api = window.KamLAuth;
    if (!api) {
      $("#authStatus").textContent = "Authentication is unavailable. Check the Firebase scripts.";
      return;
    }
    $("#authSwitch").addEventListener("click", function () {
      setAuthMode(authMode === "login" ? "register" : "login");
    });
    $("#guestBtn").addEventListener("click", function () {
      if (signingOut || authUser) return;
      enterGuest();
    });
    $("#authForm").addEventListener("submit", async function (event) {
      event.preventDefault();
      $("#authError").textContent = "";
      var email = $("#authEmail").value.trim();
      var password = $("#authPassword").value;
      if (!email || !password) {
        $("#authError").textContent = "Enter your email and password.";
        return;
      }
      if (authMode === "register" && password !== $("#authConfirm").value) {
        $("#authError").textContent = "Passwords do not match.";
        return;
      }
      $("#authSubmit").disabled = true;
      $("#authSubmit").textContent = "Please wait…";
      try {
        if (authMode === "register") await api.register(email, password);
        else await api.login(email, password);
        $("#authStatus").textContent = "Signing you in…";
      } catch (error) {
        $("#authError").textContent = error.message;
        $("#authSubmit").disabled = false;
        $("#authSubmit").textContent = authMode === "login" ? "Log in" : "Create account";
      }
    });
    $("#authRetry").addEventListener("click", function () {
      if (authUser) loadCurrentAccount(authUser, authEpoch);
    });
    $("#logoutBtn").addEventListener("click", async function () {
      if (signingOut) return;
      if (guestActive) {
        // Switch to the login screen without logging into or writing to Firebase.
        clearTimeout(saveTimer);
        saveTimer = null;
        await persistProfile();
        guestActive = false;
        rememberGuestSession(false);
        profileLoading = true;
        window.KamLApp.authReady = false;
        resetProfile();
        applyAccountPreferences(null);
        closeVoiceUi();
        setAuthMode("login");
        displayAuthForm("Sign in to use your online profile, or continue as a guest.");
        return;
      }
      signingOut = true;
      $("#logoutBtn").disabled = true;
      clearTimeout(saveTimer);
      saveTimer = null;
      try {
        if (!profileLoading) {
          saveStatus("Saving before logout…");
          await api.save(snapshotProfile());
        }
        await api.logout();
      } catch (error) {
        $("#authStatus").textContent = "Could not log out: " + error.message;
        saveStatus("Could not save/log out: " + error.message);
      } finally {
        signingOut = false;
        $("#logoutBtn").disabled = false;
      }
    });
    if (!api.available()) {
      if (guestSessionSaved()) enterGuest();
      else {
        displayAuthForm(api.setupMessage);
        $("#authSubmit").disabled = true;
      }
      return;
    }
    api.onSessionChanged(function (user, error) {
      var epoch = ++authEpoch;
      clearTimeout(saveTimer);
      saveTimer = null;
      authUser = user || null;
      guestActive = false;
      window.KamLApp.authReady = false;
      if (!user) {
        if (guestSessionSaved()) {
          enterGuest();
          return;
        }
        profileLoading = true;
        resetProfile();
        setAuthMode("login");
        $("#authPassword").value = "";
        $("#authConfirm").value = "";
        $("#authUserEmail").textContent = "";
        closeVoiceUi();
        displayAuthForm(error ? error.message : "Log in, create an account, or continue as a guest.");
        return;
      }
      // Real signed-in accounts take precedence over a remembered guest session.
      rememberGuestSession(false);
      loadCurrentAccount(user, epoch);
    });
  }

  // ------------------------------------------------------------------
  // Number validation
  // ------------------------------------------------------------------
  // Per-field rules (default: decimal, min 0, no max). int = whole numbers only.
  var LIMITS = {
    age: { int: true, min: 18, max: 120, minMsg: "You must be 18 or over to apply for credit." },
    yearsEmployed: { max: 90 }, yearsAtAddress: { max: 100 }, oldestAccountYears: { max: 80 },
    numAccounts: { int: true, max: 100 }, hardInquiries12m: { int: true, max: 100 },
    latePayments12m: { int: true, max: 365 }, latePaymentsOlder: { int: true, max: 1000 }, defaults: { int: true, max: 100 },
    rentOnTimeMonths: { int: true, max: 24 }, overdraftDaysPerMonth: { int: true, max: 31 },
    yearsInOperation: { max: 500 }, employees: { int: true }, supplierDaysBeyondTerms: { int: true, max: 365 },
    ownerCreditScore: { int: true, min: 300, max: 850 }, discretionaryExpenseShare: { max: 100 },
    lf_amount: { min: 100, max: 100000000 }, lf_base: { max: 25 }
  };
  function limitFor(key) { return LIMITS[key] || {}; }

  function numInputHTML(id, key, value, extra) {
    var lim = limitFor(key);
    return '<input type="text" inputmode="' + (lim.int ? "numeric" : "decimal") + '" autocomplete="off" data-num="' + key + '"' +
      (lim.int ? " data-int" : "") + ' id="' + id + '"' + (extra || "") + ' value="' + (value === undefined ? "" : esc(value)) +
      '" aria-describedby="' + id + '_err">';
  }
  function errHTML(id) { return '<div class="err" id="' + id + '_err" aria-live="polite"></div>'; }

  function setErr(el, msg) {
    var box = document.getElementById(el.id + "_err");
    if (box) box.textContent = msg || "";
    if (msg) el.setAttribute("aria-invalid", "true"); else el.removeAttribute("aria-invalid");
  }

  // Strip anything that isn't a digit (or a single decimal point) as the user types or pastes.
  function sanitizeNumber(el) {
    var isInt = el.hasAttribute("data-int"), v = el.value;
    // Whole-number fields drop everything after a decimal point (so a pasted "3.5" becomes 3, not 35).
    var clean = isInt ? v.split(".")[0].replace(/[^0-9]/g, "") : v.replace(/[^0-9.]/g, "");
    if (!isInt) {
      var dot = clean.indexOf(".");
      if (dot >= 0) clean = clean.slice(0, dot + 1) + clean.slice(dot + 1).replace(/\./g, "");
    }
    if (clean !== v) {
      var pos = Math.max(0, (el.selectionStart || clean.length) - (v.length - clean.length));
      el.value = clean;
      try { el.setSelectionRange(pos, pos); } catch (e) {}
      setErr(el, isInt ? "Whole numbers only (0–9)." : "Numbers only — digits and one decimal point.");
    } else setErr(el, "");
  }

  // Full check (range, whole number). Returns an error message or "".
  function checkNumber(el, required) {
    var lim = limitFor(el.dataset.num), v = el.value.trim();
    if (v === "") return required ? "This field is required." : "";
    if (!/^\d+(\.\d+)?$|^\.\d+$|^\d+\.$/.test(v)) return "Enter a number using digits only.";
    var n = parseFloat(v);
    if (lim.int && n % 1 !== 0) return "Enter a whole number.";
    var min = lim.min === undefined ? 0 : lim.min;
    if (n < min) return lim.minMsg || "Must be at least " + min.toLocaleString("en-GB") + ".";
    if (lim.max !== undefined && n > lim.max) return "Must be " + lim.max.toLocaleString("en-GB") + " or less.";
    return "";
  }

  // ------------------------------------------------------------------
  // Form rendering
  // ------------------------------------------------------------------
  function fieldHTML(f) {
    var id = "f_" + f.id, h = '<div class="field"' + (f.wide ? ' style="grid-column:1/-1"' : "") + ">";
    if (f.type === "checkbox") {
      return h + '<label>&nbsp;</label><div class="checks"><label><input type="checkbox" id="' + id + '" data-k="' + f.id + '"> ' + esc(f.label) + "</label></div></div>";
    }
    h += '<label for="' + id + '">' + esc(f.label) + (f.required ? " *" : "") + "</label>";
    if (f.type === "select") {
      h += '<select id="' + id + '" data-k="' + f.id + '">' + f.options.map(function (o) { return '<option value="' + o[0] + '">' + esc(o[1]) + "</option>"; }).join("") + "</select>";
    } else if (f.type === "checks") {
      h += '<div class="checks">' + f.options.map(function (o) {
        return '<label><input type="checkbox" data-multi="' + f.id + '" value="' + o[0] + '"> ' + esc(o[1]) + "</label>";
      }).join("") + "</div>";
    } else if (f.type === "text") {
      h += '<div class="input"><input type="text" id="' + id + '" data-k="' + f.id + '"></div>';
    } else {
      h += '<div class="input' + (f.unit ? " has-unit" : "") + '">' + (f.unit ? '<span class="unit">' + f.unit + "</span>" : "") +
        numInputHTML(id, f.id, "", ' data-k="' + f.id + '" placeholder="0"' + (f.required ? ' aria-required="true"' : "")) +
        (f.suffix ? '<span class="suffix">' + f.suffix + "</span>" : "") + "</div>" + errHTML(id);
    }
    if (f.help || f.note) h += '<div class="help">' + esc(f.help || f.note) + "</div>";
    return h + "</div>";
  }

  function renderForm() {
    var groups = SCHEMA[state.type];
    var html = groups.map(function (g) {
      var fields = g.fields.slice();
      var body = "";
      if (g.spending) {
        body += K.SPEND_CATEGORIES.map(function (c) {
          return fieldHTML({ id: "sp_" + c.id, label: c.label, unit: "£", help: c.essential ? "Essential" : "Discretionary" });
        }).join("");
      }
      body += fields.map(fieldHTML).join("");
      return '<fieldset class="group"><div class="gtitle">' + esc(g.title) + "</div>" + (g.desc ? '<div class="gdesc">' + esc(g.desc) + "</div>" : "") + '<div class="fields">' + body + "</div></fieldset>";
    }).join("");
    $("#form").innerHTML = html;
    writeForm(state.data[state.type]);
    renderDataUsed();
  }

  function allFields(type) {
    var out = [];
    SCHEMA[type].forEach(function (g) { g.fields.forEach(function (f) { out.push(f); }); });
    return out;
  }

  function writeForm(d) {
    $$("#form [data-num]").forEach(function (el) { setErr(el, ""); });
    allFields(state.type).forEach(function (f) {
      var v = d[f.id];
      if (v === undefined) v = f.def !== undefined ? f.def : "";
      if (f.type === "checks") {
        $$('[data-multi="' + f.id + '"]').forEach(function (cb) { cb.checked = (v || []).indexOf(cb.value) >= 0; });
      } else if (f.type === "checkbox") {
        $("#f_" + f.id).checked = !!v;
      } else {
        $("#f_" + f.id).value = v;
      }
    });
    if (state.type === "individual") {
      K.SPEND_CATEGORIES.forEach(function (c) {
        var v = d.spending && d.spending[c.id];
        $("#f_sp_" + c.id).value = v === undefined || v === null ? "" : v;
      });
    }
  }

  function readForm() {
    var d = {};
    allFields(state.type).forEach(function (f) {
      if (f.type === "checks") d[f.id] = $$('[data-multi="' + f.id + '"]').filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
      else if (f.type === "checkbox") d[f.id] = $("#f_" + f.id).checked;
      else if (f.type === "select" || f.type === "text") d[f.id] = $("#f_" + f.id).value;
      else { var raw = $("#f_" + f.id).value; d[f.id] = raw === "" ? "" : parseFloat(raw); }
    });
    if (state.type === "individual") {
      d.spending = {};
      K.SPEND_CATEGORIES.forEach(function (c) { var v = $("#f_sp_" + c.id).value; d.spending[c.id] = v === "" ? 0 : parseFloat(v); });
    }
    return d;
  }

  function factorMeta(type) {
    // run on an empty profile purely to read factor names/weights/data lists
    return S.evaluate(type, type === "individual" ? { spending: {} } : {}).factors;
  }

  function renderDataUsed() {
    var fs = factorMeta(state.type);
    $("#dataUsed").innerHTML = fs.map(function (f) {
      return "<li><div><b>" + esc(f.name) + '</b><div class="small muted">' + esc(f.data.join(" · ")) + '</div></div><span class="w">' + Math.round(f.weight * 100) + "%</span></li>";
    }).join("");
    $("#neverUsed").innerHTML = NEVER_USED.map(function (n) { return "<span>" + esc(n) + "</span>"; }).join("");
  }

  function renderPersonas() {
    $("#personas").innerHTML = Object.keys(K.PERSONAS).map(function (k) {
      var p = K.PERSONAS[k];
      return '<button class="chip" type="button" data-persona="' + k + '">' + (p.type === "business" ? "🏢 " : "👤 ") + esc(p.label) + "</button>";
    }).join("");
  }

  // ------------------------------------------------------------------
  // Navigation
  // ------------------------------------------------------------------
  function go(step) {
    step = +step;
    if (step > state.maxStep) return;
    $$(".panel").forEach(function (p) { p.classList.toggle("active", p.id === "panel-" + step); });
    $$(".step-btn").forEach(function (b) {
      var n = +b.dataset.step;
      b.classList.toggle("active", n === step);
      b.classList.toggle("done", n < step);
      b.disabled = n > state.maxStep;
    });
    window.scrollTo(0, 0);
    state.step = step;
    scheduleSave();
    window.dispatchEvent(new CustomEvent("kaml:step", { detail: { step: step } }));
  }

  // ------------------------------------------------------------------
  // Step 2: score
  // ------------------------------------------------------------------
  function polar(cx, cy, r, v) {
    var a = Math.PI * (1 - (v - 300) / 550);
    return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
  }
  function arc(cx, cy, r, v1, v2) {
    var p1 = polar(cx, cy, r, v1), p2 = polar(cx, cy, r, v2);
    return "M" + p1[0].toFixed(2) + " " + p1[1].toFixed(2) + " A" + r + " " + r + " 0 0 1 " + p2[0].toFixed(2) + " " + p2[1].toFixed(2);
  }
  function gaugeSVG(score, band) {
    var cx = 170, cy = 170, r = 140;
    var segs = [[300, 500, "critical"], [500, 580, "serious"], [580, 670, "warning"], [670, 850, "good"]];
    var g = '<svg class="gauge" viewBox="0 0 340 200" role="img" aria-label="Credit score ' + score + " out of 850, " + band.label + '">';
    segs.forEach(function (s) {
      g += '<path d="' + arc(cx, cy, r, s[0] + (s[0] > 300 ? 1.5 : 0), s[1] - (s[1] < 850 ? 1.5 : 0)) + '" fill="none" stroke="var(--' + s[2] + ')" stroke-width="16" stroke-linecap="butt" opacity="' + (score >= s[0] && score < s[1] + (s[1] === 850 ? 1 : 0) ? 1 : 0.28) + '"/>';
    });
    var m = polar(cx, cy, r, score);
    g += '<circle cx="' + m[0] + '" cy="' + m[1] + '" r="11" fill="var(--surface)" />';
    g += '<circle cx="' + m[0] + '" cy="' + m[1] + '" r="8" fill="var(--text)" />';
    [300, 580, 670, 850].forEach(function (t) {
      var p = polar(cx, cy, r - 26, t);
      g += '<text x="' + p[0] + '" y="' + (p[1] + 4) + '" text-anchor="middle">' + t + "</text>";
    });
    g += '<text class="num" x="170" y="160" text-anchor="middle">' + score + "</text>";
    g += '<text class="sub" x="170" y="186" text-anchor="middle">out of 850 · ' + esc(band.label) + "</text></svg>";
    return g;
  }

  function renderScore() {
    var res = state.result, d = state.data[state.type];
    var who = state.type === "business" ? (d.businessName || "Your business") + "'s" : "Your";
    $("#scoreFor").textContent = who + " credit score";
    $("#gauge").innerHTML = gaugeSVG(res.score, res.band);
    $("#scoreHeadline").innerHTML = res.score + ' <span class="badge ' + res.band.status + '">' + esc(res.band.label) + "</span>";

    var top = res.hurting[0], best = res.helping[0];
    var summary = "";
    if (best) summary += "Your strongest area is <b>" + esc(best.name.toLowerCase()) + "</b>. ";
    if (top) summary += "The biggest drag is <b>" + esc(top.name.toLowerCase()) + "</b> — improving it could add up to <b>" + top.upside + " points</b>.";
    else summary += "No factor is seriously holding you back — keep doing what you're doing.";
    $("#scoreSummary").innerHTML = summary;

    var pd = R.probabilityOfDefault(res.score, res.type);
    $("#scoreKpis").innerHTML =
      kpi(res.potential, "Achievable score if you act on the tips") +
      kpi(res.helping.length + " / " + res.factors.length, "Factors rated good or better") +
      kpi(pct(pd * 100), "Est. 12-month default probability");

    function li(list) {
      return list.length ? list.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") : '<li class="muted">Nothing notable.</li>';
    }
    var pos = [], neg = [];
    res.factors.slice().sort(function (a, b) { return b.weight - a.weight; }).forEach(function (f) {
      pos = pos.concat(f.positives); neg = neg.concat(f.negatives);
    });
    $("#helping").innerHTML = li(pos.slice(0, 7));
    $("#hurting").innerHTML = li(neg.slice(0, 7));

    $("#factors").innerHTML = res.factors.map(function (f, i) {
      var status = f.score >= 70 ? "good" : f.score >= 50 ? "warning" : f.score >= 30 ? "serious" : "critical";
      return '<div class="factor' + (i < 2 || f.score < 50 ? " open" : "") + '">' +
        '<div class="factor-head" data-toggle tabindex="0" role="button" aria-expanded="' + (i < 2 || f.score < 50 ? "true" : "false") + '"><h4><span class="chev">▸</span>' + esc(f.name) + ' <span class="badge ' + status + '">' + f.rating + "</span>" +
        '<span class="small muted" style="font-weight:500">' + Math.round(f.weight * 100) + "% of score</span></h4>" +
        '<div class="pts"><b>' + f.points + "</b> / " + f.maxPoints + " pts</div>" +
        '<div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + f.score + '" aria-label="' + esc(f.name) + '"><i style="width:' + f.score + '%"></i></div></div>' +
        '<div class="factor-body">' +
        (f.positives.length ? '<ul class="reasons pos">' + f.positives.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") + "</ul>" : "") +
        (f.negatives.length ? '<ul class="reasons neg">' + f.negatives.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") + "</ul>" : "") +
        '<div class="tip"><b>How to improve' + (f.upside ? " (up to +" + f.upside + " pts)" : "") + ":</b> " + esc(f.tip) + "</div>" +
        '<div class="uses">Data used: ' + esc(f.data.join(", ")) + "</div></div></div>";
    }).join("");

    // Data table: every input, its value, and what it feeds
    var names = {};
    res.factors.forEach(function (f) { names[f.id] = f.name; });
    var rows = allFields(state.type).map(function (f) {
      var v = d[f.id], shown;
      if (f.type === "checks") shown = (v || []).map(function (x) { var o = f.options.filter(function (o) { return o[0] === x; })[0]; return o ? o[1] : x; }).join(", ") || "None";
      else if (f.type === "checkbox") shown = v ? "Yes" : "No";
      else if (f.type === "select") { var o = f.options.filter(function (o) { return o[0] === v; })[0]; shown = o ? o[1] : v; }
      else if (v === "" || v === undefined) shown = "—";
      else shown = f.unit ? money(v) : v + (f.suffix ? " " + f.suffix : "");
      return "<tr><td>" + esc(f.label) + "</td><td>" + esc(shown) + "</td><td>" + esc(f.factor ? names[f.factor] : f.note || "Not scored") + "</td></tr>";
    });
    if (state.type === "individual") {
      rows.push("<tr><td>Monthly spending (" + K.SPEND_CATEGORIES.length + " categories)</td><td>" + money(K.spendTotal(d.spending)) + " / month</td><td>" + esc(names.spending) + ", " + esc(names.savings) + "</td></tr>");
    }
    if (state.csvApplied) rows.push("<tr><td>Bank statement</td><td>" + state.csvApplied + "</td><td>" + esc(names.spending) + "</td></tr>");
    $("#dataTable").innerHTML = "<thead><tr><th>Data point</th><th>Your value</th><th>Feeds into</th></tr></thead><tbody>" + rows.join("") + "</tbody>";
  }
  function kpi(v, l) { return '<div class="kpi"><div class="v">' + v + '</div><div class="l">' + esc(l) + "</div></div>"; }

  // ------------------------------------------------------------------
  // Step 3: risk
  // ------------------------------------------------------------------
  function productsFor(type) {
    return Object.keys(R.PRODUCTS).filter(function (k) { return R.PRODUCTS[k].who === type; });
  }
  function termOptions(p) {
    var opts = [6, 12, 18, 24, 36, 48, 60, 72, 84, 120, 180, 240, 300, 360, 420];
    return opts.filter(function (t) { return t >= p.minTerm && t <= p.maxTerm; });
  }
  function fmtTerm(m) { return m % 12 === 0 ? m / 12 + " yr" + (m > 12 ? "s" : "") : m + " months"; }

  function renderLoanForm() {
    var req = state.request[state.type], prods = productsFor(state.type);
    if (prods.indexOf(req.productId) < 0) req.productId = prods[0];
    var p = R.PRODUCTS[req.productId], terms = termOptions(p);
    if (terms.indexOf(req.termMonths) < 0) req.termMonths = terms[Math.min(2, terms.length - 1)];
    $("#loanForm").innerHTML =
      '<div class="field" style="flex:2;min-width:220px"><label for="lf_product">What do you want to borrow for?</label><select id="lf_product">' +
      prods.map(function (k) { return '<option value="' + k + '"' + (k === req.productId ? " selected" : "") + ">" + esc(R.PRODUCTS[k].label) + "</option>"; }).join("") + "</select></div>" +
      '<div class="field"><label for="lf_amount">Amount</label><div class="input has-unit"><span class="unit">£</span>' + numInputHTML("lf_amount", "lf_amount", req.amount) + "</div>" + errHTML("lf_amount") + "</div>" +
      '<div class="field"><label for="lf_term">Term</label><select id="lf_term">' + terms.map(function (t) { return '<option value="' + t + '"' + (t === req.termMonths ? " selected" : "") + ">" + fmtTerm(t) + "</option>"; }).join("") + "</select></div>" +
      '<div class="field" style="max-width:150px"><label for="lf_base">Central bank base rate</label><div class="input">' + numInputHTML("lf_base", "lf_base", state.settings.baseRate) + '<span class="suffix">%</span></div>' + errHTML("lf_base") + "</div>";
  }

  function recompute() {
    state.risk = R.assess(state.result, state.request[state.type].productId, state.settings);
  }

  function rateCurveSVG() {
    var type = state.type, pid = state.request[type].productId, cfg = state.settings;
    var W = 900, H = 300, l = 44, r = 12, t = 12, b = 30;
    var pts = [], maxRate = 0;
    for (var s = 450; s <= 850; s += 5) {
      var a = R.assess({ score: s, type: type }, pid, cfg);
      pts.push([s, a.rate, a.declined]);
      if (!a.declined) maxRate = Math.max(maxRate, a.rate);
    }
    maxRate = Math.ceil(maxRate / 5) * 5 || 10;
    function x(s) { return l + ((s - 450) / 400) * (W - l - r); }
    function y(v) { return t + (1 - Math.min(v, maxRate) / maxRate) * (H - t - b); }
    var svg = '<svg id="rateCurve" viewBox="0 0 ' + W + " " + H + '" style="width:100%;height:auto;display:block" role="img" aria-label="Interest rate by credit score">';
    for (var g = 0; g <= maxRate; g += maxRate / 5) {
      svg += '<line x1="' + l + '" x2="' + (W - r) + '" y1="' + y(g) + '" y2="' + y(g) + '" stroke="var(--border)" stroke-width="1"/>';
      svg += '<text x="' + (l - 6) + '" y="' + (y(g) + 4) + '" text-anchor="end" font-size="11" fill="var(--text-3)">' + Math.round(g) + "%</text>";
    }
    [450, 500, 580, 670, 740, 800, 850].forEach(function (s) {
      svg += '<text x="' + x(s) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="11" fill="var(--text-3)">' + s + "</text>";
    });
    var declinedEnd = pts.filter(function (p) { return p[2]; }).pop();
    if (declinedEnd) {
      svg += '<rect x="' + l + '" y="' + t + '" width="' + (x(declinedEnd[0]) - l) + '" height="' + (H - t - b) + '" fill="var(--critical-soft)"/>';
      svg += '<text x="' + (l + 6) + '" y="' + (t + 16) + '" font-size="11" fill="var(--text-2)">Declined zone</text>';
    }
    var line = pts.filter(function (p) { return !p[2]; }).map(function (p, i) { return (i ? "L" : "M") + x(p[0]).toFixed(1) + " " + y(p[1]).toFixed(1); }).join(" ");
    svg += '<path d="' + line + '" fill="none" stroke="var(--series-1)" stroke-width="2"/>';
    var me = state.result.score, mr = state.risk.rate;
    if (me >= 450 && !state.risk.declined) {
      svg += '<circle cx="' + x(me) + '" cy="' + y(mr) + '" r="7" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2"/>';
      svg += '<text x="' + x(me) + '" y="' + (y(mr) - 12) + '" text-anchor="' + (me > 780 ? "end" : "middle") + '" font-size="12" font-weight="600" fill="var(--text)">You: ' + mr.toFixed(2) + "%</text>";
    }
    svg += '<line id="rcX" x1="0" x2="0" y1="' + t + '" y2="' + (H - b) + '" stroke="var(--text-3)" stroke-width="1" opacity="0"/>';
    svg += '<circle id="rcDot" r="5" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2" opacity="0"/>';
    svg += '<rect id="rcHit" x="' + l + '" y="' + t + '" width="' + (W - l - r) + '" height="' + (H - t - b) + '" fill="transparent"/>';
    svg += "</svg>";
    return { svg: svg, pts: pts, x: x, y: y, W: W, l: l, r: r };
  }

  function renderRisk() {
    recompute();
    var rk = state.risk, res = state.result, req = state.request[state.type];
    var colors = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)"];
    var html = "";

    if (rk.declined) {
      html += '<div class="alert critical"><b>High default risk.</b> At a ' + pct(rk.pd * 100) + " estimated default probability, most mainstream lenders would decline this application. Credit-builder lenders may still help — see Step 4, and use the tips in Step 2 to raise your score.</div>";
    }

    html += '<div class="grid-even" style="margin-top:16px">';
    html += '<div class="card"><div class="eyebrow">Risk grade</div><h2 style="margin-top:4px">Tier ' + rk.tier.id + ' <span class="badge ' + rk.tier.status + '">' + rk.tier.label + "</span></h2>" +
      '<p class="muted" style="margin-top:6px">' + esc(rk.tier.desc) + "</p>" +
      '<div class="kpis">' + kpi(pct(rk.pd * 100), "Probability of default (PD), 12 months") + kpi(pct(rk.lgd * 100), "Loss given default (LGD) for " + rk.product.label.split(" (")[0].toLowerCase()) + kpi(pct(rk.el * 100), "Expected loss = PD × LGD") + "</div></div>";
    html += '<div class="card"><div class="eyebrow">Risk-based interest rate</div><h2 style="margin-top:4px;font-size:34px">' + rk.rate.toFixed(2) + '% <span class="small muted" style="font-weight:500">p.a.</span></h2>' +
      '<p class="muted" style="margin-top:4px">For ' + money(req.amount) + " over " + fmtTerm(req.termMonths) + ": about <b>" + money2(R.payment(req.amount, rk.rate, req.termMonths)) + "</b>/month before lender adjustments. Risk premium: <b>" + rk.riskPremium.toFixed(2) + "%</b>.</p>" +
      '<div class="stack" id="stack" style="margin-top:14px">' +
      rk.components.map(function (c, i) { return '<div data-tip="' + esc(c.label + ": " + c.value.toFixed(2) + "% — " + c.note) + '" style="flex:' + Math.max(c.value, 0.05) + ";background:" + colors[i] + '"></div>'; }).join("") +
      '</div><div class="legend">' + rk.components.map(function (c, i) { return '<span><i style="background:' + colors[i] + '"></i>' + esc(c.label) + " " + c.value.toFixed(2) + "%</span>"; }).join("") + "</div></div>";
    html += "</div>";

    html += '<div class="card"><h3>How the rate is built</h3><p class="small muted" style="margin:4px 0 10px">Rate = base rate + funding spread + expected loss + capital charge + operating cost + margin</p><div class="table-scroll"><table><thead><tr><th>Component</th><th>Why it exists</th><th class="r">Rate</th></tr></thead><tbody>' +
      rk.components.map(function (c) { return "<tr><td>" + esc(c.label) + '</td><td class="muted">' + esc(c.note) + '</td><td class="r">' + c.value.toFixed(2) + "%</td></tr>"; }).join("") +
      '</tbody><tfoot><tr><td>Total</td><td></td><td class="r">' + rk.rate.toFixed(2) + "%</td></tr></tfoot></table></div></div>";

    var curve = rateCurveSVG();
    html += '<div class="card"><h3>Interest rate by credit score</h3><p class="small muted" style="margin:4px 0 10px">' + esc(rk.product.label) + ". Hover to explore how much a better score would save you.</p>" + curve.svg + "</div>";

    // tier ladder
    html += '<div class="card"><h3>Bank risk tiers</h3><div class="table-scroll" style="margin-top:8px"><table><thead><tr><th>Tier</th><th>Score range</th><th>Default probability</th><th class="r">Rate for this loan</th></tr></thead><tbody>';
    var mid = res.type === "business" ? 500 : 480, prevPD = 0;
    R.TIERS.forEach(function (tr) {
      var lo = tr.maxPD >= 1 ? 300 : Math.ceil(mid + 55 * Math.log((1 - tr.maxPD) / tr.maxPD));
      var hi = prevPD === 0 ? 850 : Math.floor(mid + 55 * Math.log((1 - prevPD) / prevPD));
      var rLo = R.assess({ score: hi, type: res.type }, req.productId, state.settings);
      var rHi = R.assess({ score: lo, type: res.type }, req.productId, state.settings);
      var rateTxt = rHi.declined ? (rLo.declined ? "Declined" : rLo.rate.toFixed(1) + "% → declined") : rLo.rate.toFixed(1) + "% – " + rHi.rate.toFixed(1) + "%";
      html += "<tr" + (tr.id === rk.tier.id ? ' class="me"' : "") + "><td>" + tr.id + " · " + tr.label + (tr.id === rk.tier.id ? " (you)" : "") + "</td><td>" + lo + " – " + hi + "</td><td>" +
        (prevPD === 0 ? "< " : pct(prevPD * 100) + " – ") + (tr.maxPD >= 1 ? "100%" : pct(tr.maxPD * 100)) + '</td><td class="r">' + rateTxt + "</td></tr>";
      prevPD = tr.maxPD;
    });
    html += "</tbody></table></div></div>";

    $("#riskOut").innerHTML = html;
    bindCurve(curve);
  }

  function bindCurve(c) {
    var svg = $("#rateCurve"), hit = $("#rcHit"), X = $("#rcX"), dot = $("#rcDot");
    if (!svg) return;
    function move(ev) {
      var rect = svg.getBoundingClientRect();
      var px = ((ev.clientX - rect.left) / rect.width) * c.W;
      var s = Math.round(450 + ((px - c.l) / (c.W - c.l - c.r)) * 400 / 5) * 5;
      s = Math.max(450, Math.min(850, s));
      var p = c.pts.filter(function (q) { return q[0] === s; })[0];
      if (!p) return;
      X.setAttribute("x1", c.x(s)); X.setAttribute("x2", c.x(s)); X.setAttribute("opacity", 0.6);
      if (p[2]) { dot.setAttribute("opacity", 0); showTip(ev, "Score " + s + ": declined (default risk too high)"); return; }
      dot.setAttribute("cx", c.x(s)); dot.setAttribute("cy", c.y(p[1])); dot.setAttribute("opacity", 1);
      var req = state.request[state.type];
      var diff = (R.payment(req.amount, state.risk.rate, req.termMonths) - R.payment(req.amount, p[1], req.termMonths)) * req.termMonths;
      showTip(ev, "<b>Score " + s + "</b><br>Rate " + p[1].toFixed(2) + "%" + (state.risk.declined ? "" : "<br>" + (diff >= 0 ? "Saves " : "Costs ") + money(Math.abs(diff)) + " vs. your rate over the term"));
    }
    hit.addEventListener("mousemove", move);
    hit.addEventListener("mouseleave", function () { X.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); hideTip(); });
  }

  // tooltip
  function showTip(ev, html) {
    var t = $("#tooltip");
    t.innerHTML = html; t.classList.add("on");
    var x = Math.min(ev.clientX + 14, window.innerWidth - t.offsetWidth - 8);
    t.style.left = x + "px"; t.style.top = ev.clientY + 14 + "px";
  }
  function hideTip() { $("#tooltip").classList.remove("on"); }

  // ------------------------------------------------------------------
  // Step 4: offers
  // ------------------------------------------------------------------
  function renderOffers() {
    var req = state.request[state.type];
    var o = L.offers(state.result, state.risk, req, state.data[state.type]);
    var list = o.eligible.slice();
    var sorters = {
      apr: function (a, b) { return a.apr - b.apr; },
      monthly: function (a, b) { return a.monthly - b.monthly; },
      total: function (a, b) { return a.total - b.total; },
      likelihood: function (a, b) { return b.likelihood.value - a.likelihood.value || a.apr - b.apr; }
    };
    list.sort(sorters[state.sort]);
    var minApr = Math.min.apply(null, list.map(function (x) { return x.apr; }));

    $("#offersSub").innerHTML = esc(R.PRODUCTS[req.productId].label) + " · " + money(req.amount) + " over " + fmtTerm(req.termMonths) +
      " · score " + state.result.score + " (Tier " + state.risk.tier.id + ") · " + list.length + " offer" + (list.length === 1 ? "" : "s");

    if (!list.length) {
      $("#offers").innerHTML = '<div class="card empty"><h3>No lenders can offer this loan right now</h3><p style="margin-top:6px">Try a smaller amount or longer term in Step 3, or follow the tips in Step 2 to raise your score. Reasons are listed below.</p></div>';
    } else {
      $("#offers").innerHTML = list.map(function (x, i) {
        var dsrTxt = state.type === "individual" ? pct(x.dsr) + " of income" : x.dsr.toFixed(2) + "× DSCR";
        return '<div class="offer' + (x.apr === minApr ? " best" : "") + (state.chosen === x.lender.id ? " best" : "") + '">' +
          '<div><div class="name">' + esc(x.lender.name) + (x.apr === minApr ? '<span class="flag">Lowest APR</span>' : "") + (state.chosen === x.lender.id ? '<span class="flag">Selected</span>' : "") + "</div>" +
          '<div class="kind">' + esc(x.lender.kind) + '</div><div class="perks">' + esc(x.lender.perks.join(" · ")) + "</div></div>" +
          stat(x.apr.toFixed(1) + "%", "APR (rate " + x.rate.toFixed(2) + "%)") +
          stat(money2(x.monthly), "per month") +
          stat(money(x.total), "total repayable" + (x.fee ? " incl. " + money(x.fee) + " fee" : "")) +
          '<div class="stat"><span class="badge ' + x.likelihood.status + '">' + x.likelihood.label + '</span><div class="l" style="margin-top:4px">Repayments: ' + dsrTxt + "</div></div>" +
          '<div><button class="btn sm" data-choose="' + x.lender.id + '">Choose</button></div></div>';
      }).join("");
    }
    state.lastOffers = o;

    var inel = $("#inelig");
    if (o.ineligible.length) {
      inel.style.display = "";
      inel.innerHTML = "<summary>" + o.ineligible.length + " lender" + (o.ineligible.length > 1 ? "s" : "") + " can't offer this loan — see why</summary>" +
        o.ineligible.map(function (x) { return '<div class="row"><b>' + esc(x.lender.name) + '</b> <span class="muted small">' + esc(x.lender.kind) + '</span><div class="small muted">' + esc(x.reasons.join(" · ")) + "</div></div>"; }).join("");
    } else inel.style.display = "none";
  }
  function stat(v, l) { return '<div class="stat"><div class="v">' + v + '</div><div class="l">' + esc(l) + "</div></div>"; }

  function openOffer(id) {
    var x = state.lastOffers.eligible.filter(function (o) { return o.lender.id === id; })[0];
    if (!x) return;
    var req = state.request[state.type];
    $("#modalBody").innerHTML = '<div class="eyebrow">' + esc(x.lender.kind) + "</div><h2>" + esc(x.lender.name) + "</h2>" +
      '<p class="muted" style="margin-top:4px">' + esc(R.PRODUCTS[req.productId].label) + "</p><dl>" +
      "<dt>Loan amount</dt><dd>" + money(req.amount) + "</dd><dt>Term</dt><dd>" + fmtTerm(req.termMonths) + "</dd>" +
      "<dt>Interest rate</dt><dd>" + x.rate.toFixed(2) + "% p.a.</dd><dt>Representative APR</dt><dd>" + x.apr.toFixed(1) + "%</dd>" +
      "<dt>Arrangement fee</dt><dd>" + (x.fee ? money(x.fee) : "None") + "</dd><dt>Monthly repayment</dt><dd>" + money2(x.monthly) + "</dd>" +
      "<dt>Total interest & fees</dt><dd>" + money(x.interest) + "</dd><dt>Total repayable</dt><dd>" + money(x.total) + "</dd>" +
      "<dt>Approval chance</dt><dd>" + x.likelihood.label + "</dd></dl>" +
      '<p class="small muted">This is an indicative quote based on your KamL score of ' + state.result.score + " (Tier " + state.risk.tier.id + "). The lender will run its own checks, including a hard credit search, before making a final offer.</p>" +
      '<div class="actions"><button class="btn ghost" data-close>Back to offers</button><button class="btn" data-confirm="' + x.lender.id + '">Select this offer</button></div>';
    $("#modal").classList.add("on");
  }

  // ------------------------------------------------------------------
  // CSV
  // ------------------------------------------------------------------
  function applyCSV(text, name) {
    var out = $("#csvResult");
    try {
      var a = T.analyse(text);
      var d = readForm();
      var spendTotal = K.spendTotal(a.spending);
      if (state.type === "individual") {
        d.spending = a.spending;
        d.monthlyIncome = a.monthlyIncome || d.monthlyIncome;
        d.incomeVariability = a.incomeVariability;
        d.overdraftDaysPerMonth = a.overdraftDaysPerMonth;
      } else {
        var disc = ["dining", "shopping", "entertainment", "travel", "gambling"].reduce(function (s, k) { return s + a.spending[k]; }, 0);
        d.annualRevenue = a.monthlyIncome * 12 || d.annualRevenue;
        d.annualOperatingExpenses = spendTotal * 12 || d.annualOperatingExpenses;
        d.discretionaryExpenseShare = spendTotal ? Math.round((disc / spendTotal) * 100) : 0;
        d.overdraftDaysPerMonth = a.overdraftDaysPerMonth;
      }
      state.data[state.type] = d;
      writeForm(d);
      state.csvApplied = a.transactions + " transactions over " + a.months + " month" + (a.months > 1 ? "s" : "");
      var top = Object.keys(a.spending).filter(function (k) { return a.spending[k] > 0; }).sort(function (x, y) { return a.spending[y] - a.spending[x]; }).slice(0, 4);
      scheduleSave();
      out.innerHTML = '<div class="alert" style="background:var(--good-soft)"><b>' + esc(name) + "</b>: analysed " + state.csvApplied + ".<br>Avg. income " + money(a.monthlyIncome) +
        "/mo (" + a.incomeVariability + "), spending " + money(spendTotal) + "/mo. Top: " + top.map(function (k) { return k + " " + money(a.spending[k]); }).join(", ") +
        (a.overdraftDaysPerMonth ? ". Overdrawn ~" + a.overdraftDaysPerMonth + " days/mo." : ".") + "<br>The form has been updated.</div>";
    } catch (e) {
      out.innerHTML = '<div class="alert critical">' + esc(e.message) + "</div>";
    }
  }

  // ------------------------------------------------------------------
  // Evaluate
  // ------------------------------------------------------------------
  function evaluate() {
    // Field-level number checks first: flag every bad field inline.
    var bad = [];
    $$("#form [data-num]").forEach(function (el) {
      var f = allFields(state.type).filter(function (x) { return "f_" + x.id === el.id; })[0];
      var msg = checkNumber(el, !!(f && f.required));
      setErr(el, msg);
      if (msg) bad.push(el);
    });
    if (bad.length) {
      $("#formError").innerHTML = '<div class="alert critical">Please fix ' + bad.length + " field" + (bad.length > 1 ? "s" : "") + " with invalid numbers (highlighted above).</div>";
      bad[0].focus();
      bad[0].scrollIntoView({ block: "center" });
      return;
    }
    var d = readForm(), err = [];
    state.data[state.type] = d;
    if (state.type === "individual") {
      if (!(d.monthlyIncome >= 0) && d.employmentStatus !== "unemployed") err.push("Enter a valid monthly income.");
      if (d.age === "" || !Number.isFinite(Number(d.age)) || Number(d.age) < 18) {
        err.push("You must enter a valid age of 18 or over to apply for credit.");
      }
    } else if (!(d.annualRevenue > 0)) err.push("Enter the business's annual revenue.");
    if (err.length) {
      $("#formError").innerHTML = '<div class="alert critical">' + err.map(esc).join("<br>") + "</div>";
      return;
    }
    $("#formError").innerHTML = "";
    state.result = S.evaluate(state.type, d);
    state.chosen = null;
    state.maxStep = 4;
    renderScore();
    renderLoanForm();
    renderRisk();
    renderOffers();
    go(2);
    scheduleSave();
  }

  // ------------------------------------------------------------------
  // Events
  // ------------------------------------------------------------------
  function setType(t) {
    if (t === state.type) return;
    state.data[state.type] = readForm();
    state.type = t;
    state.csvApplied = null;
    $("#csvResult").innerHTML = "";
    $$("#typeSeg button").forEach(function (b) { b.classList.toggle("on", b.dataset.type === t); });
    state.maxStep = 1;
    renderForm();
    go(1);
    scheduleSave();
  }

  function bind() {
    // Live filter on every numeric field (form + loan inputs): only digits / one decimal point survive.
    document.addEventListener("input", function (e) { if (e.target.dataset && e.target.dataset.num) sanitizeNumber(e.target); });
    // Save form changes, including text fields, checkboxes and spending.
    $("#form").addEventListener("input", scheduleSave);
    $("#form").addEventListener("change", scheduleSave);
    document.addEventListener("focusout", function (e) {
      var el = e.target;
      if (el.dataset && el.dataset.num && el.closest("#form")) setErr(el, checkNumber(el, false));
    });
    $("#typeSeg").addEventListener("click", function (e) { var b = e.target.closest("button"); if (b) setType(b.dataset.type); });
    $("#personas").addEventListener("click", function (e) {
      var b = e.target.closest("[data-persona]"); if (!b) return;
      var p = K.PERSONAS[b.dataset.persona];
      setType(p.type);
      state.data[p.type] = JSON.parse(JSON.stringify(p.data));
      state.request[p.type] = Object.assign({}, p.request);
      writeForm(state.data[p.type]);
      scheduleSave();
    });
    $("#resetBtn").addEventListener("click", function () { state.data[state.type] = {}; writeForm({}); $("#csvResult").innerHTML = ""; state.csvApplied = null; scheduleSave(); });
    $("#evalBtn").addEventListener("click", evaluate);
    $("#steps").addEventListener("click", function (e) { var b = e.target.closest(".step-btn"); if (b && !b.disabled) go(b.dataset.step); });
    document.addEventListener("click", function (e) {
      var g = e.target.closest("[data-goto]"); if (g) go(g.dataset.goto);
      var t = e.target.closest("[data-toggle]");
      if (t) { t.parentNode.classList.toggle("open"); t.setAttribute("aria-expanded", t.parentNode.classList.contains("open") ? "true" : "false"); }
      var c = e.target.closest("[data-choose]"); if (c) openOffer(c.dataset.choose);
      if (e.target.closest("[data-close]") || e.target.id === "modal") $("#modal").classList.remove("on");
      var cf = e.target.closest("[data-confirm]");
      if (cf) { state.chosen = cf.dataset.confirm; $("#modal").classList.remove("on"); renderOffers(); scheduleSave(); }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") $("#modal").classList.remove("on");
      // Factor rows are div "buttons": activate with Enter or Space like a real button.
      if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches("[data-toggle]")) { e.preventDefault(); e.target.click(); }
    });
    $("#expandAll").addEventListener("click", function () {
      var all = $$(".factor"), open = all.every(function (f) { return f.classList.contains("open"); });
      all.forEach(function (f) { f.classList.toggle("open", !open); var h = f.querySelector("[data-toggle]"); if (h) h.setAttribute("aria-expanded", String(!open)); });
      this.textContent = open ? "Expand all" : "Collapse all";
    });

    // loan form
    $("#loanForm").addEventListener("change", function (e) {
      var req = state.request[state.type];
      if (e.target.id === "lf_product") { req.productId = e.target.value; renderLoanForm(); }
      if (e.target.id === "lf_term") req.termMonths = +e.target.value;
      if (e.target.dataset.num) {
        var msg = checkNumber(e.target, true);
        setErr(e.target, msg);
        if (msg) return; // keep the last valid figures until the input is fixed
      }
      if (e.target.id === "lf_amount") req.amount = parseFloat(e.target.value);
      if (e.target.id === "lf_base") state.settings.baseRate = parseFloat(e.target.value);
      renderRisk(); renderOffers();
      scheduleSave();
    });
    $("#sortBy").addEventListener("change", function () { state.sort = this.value; renderOffers(); scheduleSave(); });

    // rate stack tooltips
    $("#riskOut").addEventListener("mousemove", function (e) { var s = e.target.closest("[data-tip]"); if (s) showTip(e, esc(s.dataset.tip)); });
    $("#riskOut").addEventListener("mouseout", function (e) { if (e.target.closest("[data-tip]")) hideTip(); });

    // CSV
    var drop = $("#drop");
    $("#csvInput").addEventListener("change", function () { readFile(this.files[0]); this.value = ""; });
    ["dragenter", "dragover"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("drag"); }); });
    ["dragleave", "drop"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("drag"); }); });
    drop.addEventListener("drop", function (e) { readFile(e.dataTransfer.files[0]); });
    $("#sampleCsv").addEventListener("click", function (e) {
      e.preventDefault();
      var blob = new Blob([T.sampleCSV()], { type: "text/csv" });
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "sample-statement.csv"; a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });
    $("#useSampleCsv").addEventListener("click", function (e) { e.preventDefault(); applyCSV(T.sampleCSV(), "sample-statement.csv"); });

    // Display preferences change independently of the financial form.
    // Reuse the existing debounced, per-user Firestore profile save.
    window.addEventListener("kaml:display", scheduleSave);

    // theme
    $("#themeBtn").addEventListener("click", function () {
      var root = document.documentElement;
      var dark = root.dataset.theme ? root.dataset.theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
      root.dataset.theme = dark ? "light" : "dark";
      try { localStorage.setItem("kaml-theme", root.dataset.theme); } catch (err) {}
      scheduleSave();
    });
    try { var th = localStorage.getItem("kaml-theme"); if (th) document.documentElement.dataset.theme = th; } catch (err) {}
  }

  function readFile(f) {
    if (!f) return;
    var r = new FileReader();
    r.onload = function () { applyCSV(String(r.result), f.name); };
    r.readAsText(f);
  }

  renderPersonas();
  renderForm();
  bind();
  // Public hooks (used by voice.js and tests)
  window.KamLApp = {
    authReady: false,
    state: state, evaluate: evaluate, go: go, setType: setType,
    allFields: function () { return allFields(state.type); },
    checkNumber: checkNumber, setErr: setErr, limitFor: limitFor,
    productsFor: productsFor, termOptions: termOptions, fmtTerm: fmtTerm
  };
  bindAuthentication();
})();
