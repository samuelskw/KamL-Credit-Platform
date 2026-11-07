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

  function splitLine(line) {
    var out = [], cur = "", q = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === "," && !q) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map(function (s) { return s.trim(); });
  }

  function parseDate(s) {
    var m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(s); // dd/mm/yyyy
    if (m) return new Date(+(m[3].length === 2 ? "20" + m[3] : m[3]), +m[2] - 1, +m[1]);
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

  function analyse(text) {
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (lines.length < 2) throw new Error("The file has no transactions.");
    var head = splitLine(lines[0]).map(function (h) { return h.toLowerCase(); });
    function col(re) { for (var i = 0; i < head.length; i++) if (re.test(head[i])) return i; return -1; }
    var iDate = col(/date/), iDesc = col(/desc|narrative|details|merchant|payee/), iAmt = col(/amount|value/),
      iCat = col(/categ/), iBal = col(/balance/), iIn = col(/^(paid )?in$|credit/), iOut = col(/^(paid )?out$|debit/);
    if (iDate < 0 || (iAmt < 0 && (iIn < 0 || iOut < 0))) throw new Error("Couldn't find date and amount columns. Expected headers: date, description, amount.");

    var months = {}, spend = {}, income = {}, overdraftDays = {}, count = 0;
    CATS.forEach(function (c) { spend[c] = 0; });
    for (var r = 1; r < lines.length; r++) {
      var f = splitLine(lines[r]);
      var d = parseDate(f[iDate]);
      if (!d) continue;
      var amt = iAmt >= 0 ? parseFloat(f[iAmt].replace(/[£$,]/g, "")) : (parseFloat(f[iIn] || 0) || 0) - (parseFloat(f[iOut] || 0) || 0);
      if (!isFinite(amt)) continue;
      var key = d.getFullYear() + "-" + (d.getMonth() + 1);
      months[key] = true;
      count++;
      if (amt > 0) income[key] = (income[key] || 0) + amt;
      else spend[categorise(f[iDesc] || "", iCat >= 0 ? f[iCat] : "")] += -amt;
      if (iBal >= 0 && parseFloat(f[iBal]) < 0) overdraftDays[d.toDateString()] = true;
    }
    var n = Object.keys(months).length || 1;
    var monthly = {};
    CATS.forEach(function (c) { monthly[c] = Math.round(spend[c] / n); });
    var incomes = Object.keys(income).map(function (k) { return income[k]; });
    var avgIncome = incomes.reduce(function (s, v) { return s + v; }, 0) / n;
    var sd = Math.sqrt(incomes.reduce(function (s, v) { return s + Math.pow(v - avgIncome, 2); }, 0) / (incomes.length || 1));
    var cv = avgIncome > 0 ? sd / avgIncome : 0;
    return {
      transactions: count,
      months: n,
      spending: monthly,
      monthlyIncome: Math.round(avgIncome),
      incomeVariability: cv < 0.1 ? "stable" : cv < 0.3 ? "some" : "high",
      overdraftDaysPerMonth: Math.round(Object.keys(overdraftDays).length / n)
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

  KamL.transactions = { analyse: analyse, sampleCSV: sampleCSV, CATEGORIES: CATS };

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
