/*
 * Bank statement analysis. Parses a CSV of transactions in the browser
 * (nothing is uploaded) and derives spending habits:
 *   - average monthly spend per category
 *   - average monthly income and how much it varies
 *   - overdraft days (if a balance column exists)
 *   - gambling / discretionary share
 *
 * Expected columns (header names are matched loosely):
 *   date, description, amount [, category] [, balance]
 * Negative amounts are money out; positive amounts are money in.
 */
(function () {
  "use strict";
  var KamL = (window.KamL = window.KamL || {});

  var RULES = [
    ["gambling", /bet|casino|poker|lottery|bingo|paddy|ladbroke|wager|slots/i],
    ["housing", /rent|mortgage|landlord|letting/i],
    ["utilities", /energy|electric|gas|water|council tax|broadband|internet|phone|mobile|octopus|utility/i],
    ["groceries", /tesco|sainsbury|aldi|lidl|asda|morrisons|waitrose|co-op|grocery|supermarket/i],
    ["transport", /tfl|uber|train|rail|bus|fuel|petrol|shell|bp |parking|transport/i],
    ["insurance", /insurance|pharmacy|dentist|gp |health|gym/i],
    ["dining", /restaurant|cafe|coffee|pret|deliveroo|just eat|mcdonald|nando|pizza|bar |pub|takeaway/i],
    ["entertainment", /netflix|spotify|disney|cinema|steam|playstation|xbox|subscription|concert|ticket/i],
    ["travel", /airline|ryanair|easyjet|hotel|airbnb|booking\.com|holiday/i],
    ["shopping", /amazon|asos|zara|h&m|primark|argos|ebay|shop|store|retail/i]
  ];
  var CATS = ["housing", "utilities", "groceries", "transport", "insurance", "dining", "shopping", "entertainment", "travel", "gambling", "other"];

  function splitLine(line, delim) {
    var out = [], cur = "", q = false;
    for (var i = 0; i < line.length; i++) {
      var c = line.charAt(i);
      if (c === '"') { if (q && line.charAt(i + 1) === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === delim && !q) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map(function (s) { return s.trim(); });
  }

  // Pick the separator used by the header row (UK banks: comma; many EU exports: semicolon; some: tab).
  function detectDelimiter(header) {
    var best = ",", bestCount = 0;
    [",", ";", "\t"].forEach(function (d) {
      var n = splitLine(header, d).length - 1;
      if (n > bestCount) { best = d; bestCount = n; }
    });
    return best;
  }

  // "£1,234.56" -> 1234.56, "(12.00)" -> -12, "-£50" -> -50, "12.00 DR" -> -12, "" / "abc" -> NaN
  function parseMoney(s) {
    if (s === undefined || s === null) return NaN;
    var t = String(s).trim();
    if (!t) return NaN;
    var neg = false;
    if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
    if (/\s*DR$/i.test(t)) { neg = true; t = t.replace(/\s*DR$/i, ""); }
    t = t.replace(/\s*CR$/i, "").replace(/[£$€\s,]/g, "");
    if (/^-/.test(t) || /-$/.test(t)) { neg = !neg; t = t.replace(/^-|-$/g, ""); }
    if (!/^\d*\.?\d+$/.test(t)) return NaN;
    var n = parseFloat(t);
    return neg ? -n : n;
  }

  function parseDate(s) {
    if (!s) return null;
    var m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(s); // dd/mm/yyyy
    if (m) {
      var y = +(m[3].length === 2 ? "20" + m[3] : m[3]), mo = +m[2] - 1, day = +m[1];
      var dt = new Date(y, mo, day);
      // reject impossible dates such as 31/02 instead of rolling them into the next month
      return dt.getFullYear() === y && dt.getMonth() === mo && dt.getDate() === day ? dt : null;
    }
    var iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s); // yyyy-mm-dd: build in local time (new Date() would use UTC)
    if (iso) return parseDate(iso[3] + "/" + iso[2] + "/" + iso[1]);
    var d = new Date(s);
    return isNaN(d) ? null : d;
  }

  function categorise(desc, given) {
    if (given) {
      var g = given.toLowerCase();
      for (var i = 0; i < CATS.length; i++) if (g.indexOf(CATS[i]) >= 0) return CATS[i];
    }
    for (var j = 0; j < RULES.length; j++) if (RULES[j][1].test(desc)) return RULES[j][0];
    return "other";
  }

  var DAYS_PER_MONTH = 30.44;
  var MIN_DAYS = 25; // shorter statements can't give a meaningful monthly average

  function analyse(text) {
    var lines = String(text).replace(/^﻿/, "").split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (lines.length < 2) throw new Error("The file has no transactions.");
    var delim = detectDelimiter(lines[0]);
    var head = splitLine(lines[0], delim).map(function (h) { return h.toLowerCase().replace(/^"|"$/g, ""); });
    function col(re, not) { for (var i = 0; i < head.length; i++) if (re.test(head[i]) && !(not && not.test(head[i]))) return i; return -1; }
    // Prefer a plain "amount" column; only fall back to "value" when it isn't a date ("Value Date").
    var iAmt = col(/amount/);
    if (iAmt < 0) iAmt = col(/value/, /date/);
    var iDate = col(/^(transaction |posting |posted )?date$/);
    if (iDate < 0) iDate = col(/date/);
    var iDesc = col(/desc|narrative|details|merchant|payee|reference/),
      iCat = col(/categ/), iBal = col(/balance/),
      iIn = col(/^(paid |money )?in$|credit/, /card/), iOut = col(/^(paid |money )?out$|debit/, /card/);
    if (iDate < 0 || (iAmt < 0 && (iIn < 0 || iOut < 0))) throw new Error("Couldn't find date and amount columns. Expected headers: date, description, amount (or paid in / paid out).");

    var months = {}, spend = {}, income = {}, overdraftDays = {}, count = 0, skipped = 0, first = null, last = null;
    CATS.forEach(function (c) { spend[c] = 0; });
    for (var r = 1; r < lines.length; r++) {
      var f = splitLine(lines[r], delim);
      var d = parseDate(f[iDate]);
      if (!d) { skipped++; continue; }
      var amt;
      if (iAmt >= 0) amt = parseMoney(f[iAmt]);
      else {
        var pin = parseMoney(f[iIn]), pout = parseMoney(f[iOut]);
        // Paid-out values may be written positive or negative; treat both as money out.
        amt = isNaN(pin) && isNaN(pout) ? NaN : (isNaN(pin) ? 0 : Math.abs(pin)) - (isNaN(pout) ? 0 : Math.abs(pout));
      }
      if (!isFinite(amt)) { skipped++; continue; } // truncated / totals / malformed rows
      var key = d.getFullYear() + "-" + (d.getMonth() + 1);
      months[key] = true;
      count++;
      if (!first || d < first) first = d;
      if (!last || d > last) last = d;
      if (amt > 0) income[key] = (income[key] || 0) + amt;
      else spend[categorise(f[iDesc] || "", iCat >= 0 ? f[iCat] : "")] += -amt;
      if (iBal >= 0 && parseMoney(f[iBal]) < 0) overdraftDays[d.toDateString()] = true;
    }
    if (!count) throw new Error("No readable transactions found" + (skipped ? " (" + skipped + " rows had an unreadable date or amount)" : "") + ". Check the dates are dd/mm/yyyy and amounts are numbers.");

    // Average over the days actually covered, so partial first/last months don't skew "per month" figures.
    var spanDays = Math.round((last - first) / 86400000) + 1;
    if (spanDays < MIN_DAYS) throw new Error("This statement only covers " + spanDays + " day" + (spanDays === 1 ? "" : "s") + ". Upload at least a full month so monthly averages are meaningful.");
    var n = spanDays / DAYS_PER_MONTH;
    // Statements usually cover whole months but the last few days may have no transactions
    // (e.g. 1 Jul – 28 Sep): snap to the whole month count when within ~4 days of it.
    if (Math.abs(n - Math.round(n)) < 0.15) n = Math.round(n);

    var monthly = {};
    CATS.forEach(function (c) { monthly[c] = Math.round(spend[c] / n); });
    var totalIncome = Object.keys(income).reduce(function (s, k) { return s + income[k]; }, 0);
    var avgIncome = totalIncome / n;

    // Income regularity: compare whole calendar months only (drop the partial first/last month
    // when there are enough), and only when at least two months are left to compare.
    var keys = Object.keys(months).sort(function (a, b) {
      var pa = a.split("-"), pb = b.split("-");
      return pa[0] - pb[0] || pa[1] - pb[1];
    });
    if (keys.length >= 4) keys = keys.slice(1, -1);
    var variability = null;
    if (keys.length >= 2 && totalIncome > 0) {
      var vals = keys.map(function (k) { return income[k] || 0; });
      var mean = vals.reduce(function (s, v) { return s + v; }, 0) / vals.length;
      var sd = Math.sqrt(vals.reduce(function (s, v) { return s + Math.pow(v - mean, 2); }, 0) / vals.length);
      var cv = mean > 0 ? sd / mean : 0;
      variability = cv < 0.1 ? "stable" : cv < 0.3 ? "some" : "high";
    }

    return {
      transactions: count,
      skipped: skipped,
      months: Math.round(n * 10) / 10,
      spending: monthly,
      monthlyIncome: Math.round(avgIncome),
      incomeVariability: variability,                       // null = can't tell from this file
      overdraftDaysPerMonth: iBal >= 0 ? Math.min(31, Math.round(Object.keys(overdraftDays).length / n)) : null // null = no balance column
    };
  }

  // Generates a 3-month sample statement so users can see the format.
  function sampleCSV() {
    var rows = [["Date", "Description", "Amount", "Balance"]];
    var bal = 1200;
    var items = [
      [1, "ACME LTD SALARY", 2650], [1, "RENT - CITY LETTINGS", -950], [3, "OCTOPUS ENERGY", -85], [4, "COUNCIL TAX", -120],
      [5, "TESCO STORES", -64.2], [6, "TFL TRAVEL", -42], [8, "NETFLIX.COM", -10.99], [9, "SPOTIFY", -11.99],
      [10, "DELIVEROO", -27.5], [12, "SAINSBURYS", -58.1], [14, "AMAZON MARKETPLACE", -46.99], [15, "PRET A MANGER", -8.4],
      [17, "VIRGIN MEDIA BROADBAND", -38], [19, "ALDI", -41.75], [20, "NANDOS", -32], [22, "ASOS.COM", -79],
      [24, "TFL TRAVEL", -36], [25, "SKY BET", -15], [26, "TESCO STORES", -52.3], [28, "CINEMA TICKETS", -24]
    ];
    for (var m = 0; m < 3; m++) {
      items.forEach(function (it) {
        var amt = it[2] * (it[2] > 0 ? 1 : 0.9 + ((it[0] * 7 + m * 3) % 5) / 20);
        amt = Math.round(amt * 100) / 100;
        bal = Math.round((bal + amt) * 100) / 100;
        var dd = ("0" + it[0]).slice(-2), mm = ("0" + (m + 7)).slice(-2);
        rows.push([dd + "/" + mm + "/2026", it[1], amt.toFixed(2), bal.toFixed(2)]);
      });
    }
    return rows.map(function (r) { return r.join(","); }).join("\n");
  }

  KamL.transactions = { analyse: analyse, sampleCSV: sampleCSV, parseMoney: parseMoney, CATEGORIES: CATS };

  // ---------------- demo personas ----------------
  KamL.PERSONAS = {
    graduate: {
      type: "individual", label: "Recent graduate (thin file)",
      data: {
        age: 23, employmentStatus: "full-time", yearsEmployed: 0.5, monthlyIncome: 2100, incomeVariability: "stable",
        housing: "rent", yearsAtAddress: 0.5, monthlyDebtPayments: 0, totalCreditLimit: 500, totalCreditBalance: 120,
        oldestAccountYears: 0.5, numAccounts: 1, creditMix: ["card"], latePayments12m: 0, latePaymentsOlder: 0, defaults: 0,
        bankruptcy: false, hardInquiries12m: 1, rentOnTimeMonths: 12, savings: 1500, investments: 0, overdraftDaysPerMonth: 0,
        spending: { housing: 750, utilities: 120, groceries: 220, transport: 90, insurance: 20, dining: 160, shopping: 120, entertainment: 50, travel: 40, gambling: 0, other: 60 }
      },
      request: { productId: "car", amount: 8000, termMonths: 48 }
    },
    professional: {
      type: "individual", label: "Established professional",
      data: {
        age: 38, employmentStatus: "full-time", yearsEmployed: 7, monthlyIncome: 4800, incomeVariability: "stable",
        housing: "mortgage", yearsAtAddress: 6, monthlyDebtPayments: 1350, totalCreditLimit: 12000, totalCreditBalance: 900,
        oldestAccountYears: 16, numAccounts: 6, creditMix: ["card", "installment", "mortgage"], latePayments12m: 0, latePaymentsOlder: 0,
        defaults: 0, bankruptcy: false, hardInquiries12m: 0, rentOnTimeMonths: 0, savings: 18000, investments: 25000, overdraftDaysPerMonth: 0,
        spending: { housing: 0, utilities: 260, groceries: 480, transport: 220, insurance: 120, dining: 300, shopping: 250, entertainment: 90, travel: 200, gambling: 0, other: 150 }
      },
      request: { productId: "home", amount: 25000, termMonths: 60 }
    },
    stretched: {
      type: "individual", label: "Overstretched borrower",
      data: {
        age: 31, employmentStatus: "part-time", yearsEmployed: 1, monthlyIncome: 1900, incomeVariability: "some",
        housing: "rent", yearsAtAddress: 2, monthlyDebtPayments: 620, totalCreditLimit: 6000, totalCreditBalance: 5400,
        oldestAccountYears: 8, numAccounts: 7, creditMix: ["card", "installment"], latePayments12m: 2, latePaymentsOlder: 1,
        defaults: 0, bankruptcy: false, hardInquiries12m: 5, rentOnTimeMonths: 10, savings: 150, investments: 0, overdraftDaysPerMonth: 12,
        spending: { housing: 700, utilities: 140, groceries: 230, transport: 80, insurance: 15, dining: 140, shopping: 160, entertainment: 60, travel: 0, gambling: 70, other: 50 }
      },
      request: { productId: "consolidation", amount: 6000, termMonths: 48 }
    },
    cafe: {
      type: "business", label: "Neighbourhood café (3 yrs)",
      data: {
        businessName: "Bean There Café", industry: "hospitality", yearsInOperation: 3, employees: 6,
        annualRevenue: 420000, prevAnnualRevenue: 365000, annualOperatingExpenses: 368000, annualDebtService: 18000,
        totalBusinessDebt: 60000, cashReserves: 38000, latePayments12m: 0, defaults: 0, supplierDaysBeyondTerms: 4,
        ownerCreditScore: 710, overdraftDaysPerMonth: 1, discretionaryExpenseShare: 6
      },
      request: { productId: "equipment", amount: 35000, termMonths: 48 }
    },
    saas: {
      type: "business", label: "Growing software firm",
      data: {
        businessName: "Loomwork Software Ltd", industry: "technology", yearsInOperation: 6, employees: 24,
        annualRevenue: 2600000, prevAnnualRevenue: 1900000, annualOperatingExpenses: 2050000, annualDebtService: 90000,
        totalBusinessDebt: 400000, cashReserves: 650000, latePayments12m: 0, defaults: 0, supplierDaysBeyondTerms: 0,
        ownerCreditScore: 780, overdraftDaysPerMonth: 0, discretionaryExpenseShare: 9
      },
      request: { productId: "expansion", amount: 250000, termMonths: 60 }
    }
  };
})();
