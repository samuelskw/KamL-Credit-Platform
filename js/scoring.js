/*
 * KamL credit scoring engine.
 *
 * Produces a 300–850 score from a set of weighted factors. Each factor scores
 * 0–100 and carries its own explanation, so every point of the final score can
 * be traced back to the data that produced it.
 *
 *   score = 300 + 550 × Σ(weight_i × factorScore_i / 100)
 */
(function () {
  "use strict";
  var KamL = (window.KamL = window.KamL || {});

  var MIN_SCORE = 300;
  var SPAN = 550;
  var TARGET_FACTOR_SCORE = 85; // used to estimate "points available" per factor

  // ---------- helpers ----------
  function num(v, d) {
    var n = parseFloat(v);
    return isFinite(n) ? n : d === undefined ? 0 : d;
  }
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }
  // piecewise-linear interpolation through [x, y] points (x ascending)
  function curve(x, pts) {
    if (x <= pts[0][0]) return pts[0][1];
    for (var i = 1; i < pts.length; i++) {
      if (x <= pts[i][0]) {
        var a = pts[i - 1], b = pts[i];
        return a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
      }
    }
    return pts[pts.length - 1][1];
  }
  function pct(v) {
    return (Math.round(v * 10) / 10).toFixed(1) + "%";
  }
  function money(v) {
    return "£" + Math.round(v).toLocaleString("en-GB");
  }
  function rating(s) {
    if (s >= 85) return "Excellent";
    if (s >= 70) return "Good";
    if (s >= 50) return "Fair";
    if (s >= 30) return "Weak";
    return "Poor";
  }

  // ---------- score bands ----------
  var BANDS = [
    { min: 800, label: "Exceptional", status: "good" },
    { min: 740, label: "Very good", status: "good" },
    { min: 670, label: "Good", status: "good" },
    { min: 580, label: "Fair", status: "warning" },
    { min: 500, label: "Poor", status: "serious" },
    { min: 0, label: "Very poor", status: "critical" }
  ];
  function band(score) {
    for (var i = 0; i < BANDS.length; i++) if (score >= BANDS[i].min) return BANDS[i];
    return BANDS[BANDS.length - 1];
  }

  // =====================================================================
  //  INDIVIDUAL
  // =====================================================================
  function individualFactors(d) {
    var income = num(d.monthlyIncome);
    var spend = KamL.spendTotal(d.spending);
    var essentials = KamL.spendEssential(d.spending);
    var gambling = num(d.spending && d.spending.gambling);
    var debtPay = num(d.monthlyDebtPayments);
    var limit = num(d.totalCreditLimit);
    var balance = num(d.totalCreditBalance);
    var late12 = num(d.latePayments12m);
    var lateOld = num(d.latePaymentsOlder);
    var defaults = num(d.defaults);
    var bankrupt = !!d.bankruptcy;
    var rentOnTime = num(d.rentOnTimeMonths);
    var oldest = num(d.oldestAccountYears);
    var accounts = num(d.numAccounts);
    var mix = (d.creditMix || []).length;
    var savings = num(d.savings);
    var investments = num(d.investments);
    var overdraftDays = num(d.overdraftDaysPerMonth);
    var inquiries = num(d.hardInquiries12m);
    var yearsEmp = num(d.yearsEmployed);
    var yearsAddr = num(d.yearsAtAddress);
    var thinFile = accounts < 2 || oldest < 1;

    var F = [];

    // 1. Payment history ------------------------------------------------
    (function () {
      var s = 100 - late12 * 14 - lateOld * 5 - defaults * 30 - (bankrupt ? 45 : 0);
      var pos = [], neg = [];
      if (late12 === 0 && lateOld === 0 && defaults === 0 && !bankrupt) pos.push("No missed or late payments on record.");
      if (late12 > 0) neg.push(late12 + " late payment" + (late12 > 1 ? "s" : "") + " in the last 12 months (each costs heavily while recent).");
      if (lateOld > 0) neg.push(lateOld + " older late payment" + (lateOld > 1 ? "s" : "") + " (impact fades with time).");
      if (defaults > 0) neg.push(defaults + " default" + (defaults > 1 ? "s" : "") + " / CCJ" + (defaults > 1 ? "s" : "") + " registered.");
      if (bankrupt) neg.push("Bankruptcy or IVA on file within the last 6 years.");
      // Alternative data: rent & utility payments help people with thin files.
      // A thin file caps this factor (little evidence either way); rent history lifts the cap.
      var rentCredit = rentOnTime >= 6 ? Math.min(rentOnTime, 24) : 0;
      if (thinFile) {
        s = Math.min(s, 62 + rentCredit * 0.75);
        neg.push("Very little credit repayment history to judge from — a thin file limits this factor.");
        if (rentCredit) pos.push(rentOnTime + " months of on-time rent/utility payments counted as alternative data, lifting the thin-file limit.");
      } else if (rentCredit) {
        s += rentCredit * 0.5;
        pos.push(rentOnTime + " months of on-time rent/utility payments counted as alternative data.");
      }
      F.push({
        id: "payment", name: "Payment history", weight: 0.27, score: clamp(s, 0, 100),
        data: ["Late payments (12m / older)", "Defaults & CCJs", "Bankruptcy/IVA", "On-time rent & utilities"],
        positives: pos, negatives: neg,
        tip: late12 + defaults > 0
          ? "Set up direct debits for at least the minimum payment on every account — each clean month dilutes recent missed payments."
          : rentOnTime < 12
          ? "Keep paying on time, and share 12 months of rent/utility history to strengthen this factor."
          : "Keep it up — payment history is the single biggest driver of your score."
      });
    })();

    // 2. Credit utilisation --------------------------------------------
    (function () {
      var pos = [], neg = [], s, util = null;
      if (limit <= 0) {
        s = 55;
        neg.push("No revolving credit limit to measure utilisation against.");
      } else {
        util = (balance / limit) * 100;
        s = curve(util, [[0, 92], [9, 100], [30, 82], [50, 58], [75, 32], [100, 10], [130, 0]]);
        var msg = "You're using " + pct(util) + " of your " + money(limit) + " available credit.";
        (util <= 30 ? pos : neg).push(msg);
        if (util > 90) neg.push("Being near or over your limit signals financial stress to lenders.");
      }
      F.push({
        id: "utilisation", name: "Credit utilisation", weight: 0.18, score: clamp(s, 0, 100), metric: util,
        data: ["Total credit card / overdraft limits", "Current balances"],
        positives: pos, negatives: neg,
        tip: util === null
          ? "A low-limit credit card used lightly and cleared monthly builds this factor."
          : util > 30
          ? "Pay balances down to under 30% of limits (" + money(limit * 0.3) + "); under 10% scores best."
          : "Keep balances low and clear cards in full each month."
      });
    })();

    // 3. Debt-to-income ---------------------------------------------------
    (function () {
      var pos = [], neg = [], s, dti = null;
      if (income <= 0) {
        s = debtPay > 0 ? 0 : 30;
        neg.push("No verifiable income was provided.");
      } else {
        dti = (debtPay / income) * 100;
        s = curve(dti, [[0, 100], [15, 95], [28, 80], [36, 65], [43, 45], [50, 28], [65, 8], [80, 0]]);
        var msg = "Debt repayments take " + pct(dti) + " of your monthly income (" + money(debtPay) + " of " + money(income) + ").";
        (dti <= 36 ? pos : neg).push(msg);
      }
      F.push({
        id: "dti", name: "Debt-to-income", weight: 0.13, score: clamp(s, 0, 100), metric: dti,
        data: ["Monthly income (after tax)", "Monthly debt repayments"],
        positives: pos, negatives: neg,
        tip: dti !== null && dti > 36
          ? "Lenders prefer under 36%. Reducing repayments by " + money(debtPay - income * 0.36) + "/month (or consolidating) would get you there."
          : "Your repayments are manageable — avoid taking on new debt you don't need."
      });
    })();

    // 4. Spending habits --------------------------------------------------
    (function () {
      var pos = [], neg = [], s = 70;
      if (income > 0 && spend > 0) {
        var saveRate = ((income - spend - debtPay) / income) * 100;
        var discretionary = ((spend - essentials) / spend) * 100;
        var gamblingShare = (gambling / income) * 100;
        s = curve(saveRate, [[-30, 0], [-10, 20], [0, 45], [5, 65], [10, 80], [20, 95], [30, 100]]);
        if (saveRate >= 10) pos.push("You keep " + pct(saveRate) + " of income after spending and debt repayments.");
        else if (saveRate >= 0) neg.push("Only " + pct(saveRate) + " of income is left after spending and repayments.");
        else neg.push("You spend " + money(-(income - spend - debtPay)) + " more than you earn each month.");
        if (discretionary > 45) { s -= 10; neg.push(pct(discretionary) + " of spending is discretionary (dining, shopping, entertainment)."); }
        else pos.push("Most spending (" + pct(100 - discretionary) + ") goes on essentials.");
        if (gamblingShare > 0) {
          var hit = curve(gamblingShare, [[0, 0], [1, 5], [5, 20], [10, 35]]);
          s -= hit;
          neg.push("Gambling transactions equal " + pct(gamblingShare) + " of income.");
        }
      } else {
        neg.push("No spending data supplied — scored as neutral.");
      }
      if (overdraftDays > 0) {
        s -= curve(overdraftDays, [[0, 0], [5, 10], [15, 25], [30, 35]]);
        neg.push("Overdrawn about " + overdraftDays + " day" + (overdraftDays > 1 ? "s" : "") + " a month.");
      } else if (spend > 0) pos.push("No regular overdraft usage.");
      F.push({
        id: "spending", name: "Spending habits", weight: 0.12, score: clamp(s, 0, 100),
        data: ["Monthly spending by category", "Gambling transactions", "Overdraft days", "Bank transactions (if uploaded)"],
        positives: pos, negatives: neg,
        tip: "Aim to keep at least 10% of income unspent each month; trimming discretionary categories is the fastest lever."
      });
    })();

    // 5. Credit history depth ------------------------------------------------
    (function () {
      var pos = [], neg = [];
      var s = curve(oldest, [[0, 10], [1, 30], [3, 55], [7, 80], [12, 95], [20, 100]]) * 0.6 +
        curve(accounts, [[0, 0], [1, 35], [3, 75], [5, 100], [12, 100], [20, 80]]) * 0.25 +
        curve(mix, [[0, 0], [1, 50], [2, 85], [3, 100]]) * 0.15;
      if (oldest >= 7) pos.push("Your oldest account is " + oldest + " years old.");
      else neg.push("Oldest account is only " + oldest + " year" + (oldest === 1 ? "" : "s") + " old.");
      if (mix >= 2) pos.push("Healthy mix of " + mix + " credit types.");
      else neg.push("Limited mix of credit types (" + mix + ").");
      F.push({
        id: "history", name: "Length & mix of credit", weight: 0.13, score: clamp(s, 0, 100),
        data: ["Age of oldest account", "Number of accounts", "Types of credit held"],
        positives: pos, negatives: neg,
        tip: "Keep your oldest accounts open, even if rarely used — history length only grows with time."
      });
    })();

    // 6. Savings buffer -----------------------------------------------------
    (function () {
      var pos = [], neg = [];
      var monthlyOut = Math.max(spend + debtPay, income * 0.6, 1);
      var months = (savings + investments * 0.7) / monthlyOut;
      var s = curve(months, [[0, 5], [1, 35], [3, 70], [6, 92], [12, 100]]);
      var msg = "Savings cover about " + months.toFixed(1) + " months of outgoings (" + money(savings + investments) + " in savings & investments).";
      (months >= 3 ? pos : neg).push(msg);
      F.push({
        id: "savings", name: "Savings buffer", weight: 0.07, score: clamp(s, 0, 100),
        data: ["Cash savings", "Investments (70% weighted)", "Monthly outgoings"],
        positives: pos, negatives: neg,
        tip: months < 3 ? "Build an emergency fund of 3 months' outgoings (" + money(monthlyOut * 3) + ")." : "Your buffer protects you against shocks — lenders value that."
      });
    })();

    // 7. Income & stability -------------------------------------------------
    (function () {
      var pos = [], neg = [];
      var statusScore = { "full-time": 100, "self-employed": 75, "part-time": 70, retired: 80, student: 45, unemployed: 10 }[d.employmentStatus] || 50;
      var variability = { stable: 100, some: 70, high: 35 }[d.incomeVariability] || 70;
      var s = statusScore * 0.35 + curve(yearsEmp, [[0, 20], [1, 55], [3, 85], [5, 100]]) * 0.25 +
        variability * 0.2 + curve(yearsAddr, [[0, 30], [1, 55], [3, 85], [5, 100]]) * 0.1 +
        curve(income, [[0, 0], [1000, 40], [2000, 70], [3500, 90], [6000, 100]]) * 0.1;
      if (statusScore >= 75) pos.push("Employment status: " + d.employmentStatus + ".");
      else neg.push("Employment status (" + (d.employmentStatus || "unknown") + ") is considered less secure.");
      if (yearsEmp >= 2) pos.push(yearsEmp + " years in current job/business.");
      else neg.push("Less than 2 years in current role.");
      if (variability < 70) neg.push("Income varies a lot month to month.");
      if (yearsAddr < 1) neg.push("Recently moved address.");
      F.push({
        id: "stability", name: "Income & stability", weight: 0.07, score: clamp(s, 0, 100),
        data: ["Employment status", "Years employed", "Income regularity", "Years at address", "Income level"],
        positives: pos, negatives: neg,
        tip: "Stability builds over time; avoid unnecessary job or address changes before a big application."
      });
    })();

    // 8. Recent credit searches ------------------------------------------------
    (function () {
      var s = curve(inquiries, [[0, 100], [1, 90], [2, 75], [4, 45], [6, 20], [10, 0]]);
      F.push({
        id: "inquiries", name: "Recent applications", weight: 0.03, score: s,
        data: ["Hard credit searches in last 12 months"],
        positives: inquiries <= 1 ? ["Few recent credit applications (" + inquiries + ")."] : [],
        negatives: inquiries > 1 ? [inquiries + " hard searches in 12 months — several applications in a short time look like credit hunger."] : [],
        tip: "Use soft-search eligibility checkers (like this one) before applying, so failed applications don't leave hard searches."
      });
    })();

    return F;
  }

  // =====================================================================
  //  BUSINESS
  // =====================================================================
  var INDUSTRY_RISK = {
    healthcare: { label: "Healthcare", score: 90 },
    professional: { label: "Professional services", score: 85 },
    technology: { label: "Technology / software", score: 70 },
    manufacturing: { label: "Manufacturing", score: 70 },
    wholesale: { label: "Wholesale / distribution", score: 65 },
    retail: { label: "Retail / e-commerce", score: 55 },
    transport: { label: "Transport & logistics", score: 50 },
    construction: { label: "Construction", score: 40 },
    hospitality: { label: "Hospitality / food service", score: 35 }
  };

  function businessFactors(d) {
    var revenue = num(d.annualRevenue);
    var prevRevenue = num(d.prevAnnualRevenue);
    var opex = num(d.annualOperatingExpenses);
    var debtService = num(d.annualDebtService);
    var totalDebt = num(d.totalBusinessDebt);
    var cash = num(d.cashReserves);
    var years = num(d.yearsInOperation);
    var late = num(d.latePayments12m);
    var defaults = num(d.defaults);
    var supplierDays = num(d.supplierDaysBeyondTerms);
    var ownerScore = num(d.ownerCreditScore, 0);
    var overdraftDays = num(d.overdraftDaysPerMonth);
    var discretionaryShare = num(d.discretionaryExpenseShare);
    var noi = revenue - opex;
    var F = [];

    (function () {
      var s = 100 - late * 12 - defaults * 35 - curve(supplierDays, [[0, 0], [7, 8], [15, 20], [30, 40], [60, 60]]);
      var pos = [], neg = [];
      if (late === 0 && defaults === 0) pos.push("No late payments or defaults on business credit.");
      if (late > 0) neg.push(late + " late payment(s) on business credit in 12 months.");
      if (defaults > 0) neg.push(defaults + " default(s)/CCJ(s) against the business.");
      if (supplierDays > 7) neg.push("Suppliers are paid on average " + supplierDays + " days beyond terms.");
      else pos.push("Suppliers are paid on time (avg. " + supplierDays + " days beyond terms).");
      F.push({
        id: "payment", name: "Repayment & trade history", weight: 0.24, score: clamp(s, 0, 100),
        data: ["Late payments on business credit", "Defaults/CCJs", "Supplier payment days beyond terms"],
        positives: pos, negatives: neg,
        tip: "Pay suppliers within terms — trade payment data is reported to business credit agencies."
      });
    })();

    (function () {
      var pos = [], neg = [], s, dscr = null;
      if (debtService <= 0) { s = noi > 0 ? 95 : 40; (noi > 0 ? pos : neg).push(noi > 0 ? "No existing debt service obligations." : "No operating profit to service debt."); }
      else {
        dscr = noi / debtService;
        s = curve(dscr, [[0, 0], [0.8, 10], [1, 35], [1.25, 65], [1.5, 82], [2, 95], [3, 100]]);
        (dscr >= 1.25 ? pos : neg).push("Debt service coverage ratio (DSCR) is " + dscr.toFixed(2) + "× — operating income " + money(noi) + " vs. " + money(debtService) + " annual repayments.");
      }
      F.push({
        id: "dscr", name: "Debt service coverage", weight: 0.2, score: clamp(s, 0, 100), metric: dscr,
        data: ["Annual revenue", "Operating expenses", "Annual debt repayments"],
        positives: pos, negatives: neg,
        tip: "Most banks want DSCR ≥ 1.25×. Extending loan terms or lifting margins raises it."
      });
    })();

    (function () {
      var pos = [], neg = [];
      var margin = revenue > 0 ? (noi / revenue) * 100 : -100;
      var s = curve(margin, [[-20, 0], [0, 25], [5, 55], [10, 75], [20, 95], [30, 100]]);
      (margin >= 5 ? pos : neg).push("Operating margin is " + pct(margin) + ".");
      F.push({
        id: "profit", name: "Profitability", weight: 0.12, score: clamp(s, 0, 100),
        data: ["Annual revenue", "Operating expenses"],
        positives: pos, negatives: neg,
        tip: "Review pricing and your largest cost lines; even a few points of margin markedly improves risk grade."
      });
    })();

    (function () {
      var pos = [], neg = [];
      var growth = prevRevenue > 0 ? ((revenue - prevRevenue) / prevRevenue) * 100 : 0;
      var s = curve(growth, [[-30, 5], [-10, 35], [0, 60], [10, 85], [25, 100]]) * 0.6 +
        curve(revenue, [[0, 0], [50000, 30], [250000, 60], [1000000, 85], [5000000, 100]]) * 0.4;
      (growth >= 0 ? pos : neg).push("Revenue " + (growth >= 0 ? "grew " : "fell ") + pct(Math.abs(growth)) + " year on year to " + money(revenue) + ".");
      F.push({
        id: "growth", name: "Revenue scale & growth", weight: 0.12, score: clamp(s, 0, 100),
        data: ["This year's revenue", "Last year's revenue"],
        positives: pos, negatives: neg,
        tip: "Steady, documented revenue (management accounts, bank feeds) gives lenders confidence."
      });
    })();

    (function () {
      var pos = [], neg = [];
      var lev = revenue > 0 ? totalDebt / revenue : 5;
      var s = curve(lev, [[0, 100], [0.2, 90], [0.5, 70], [1, 40], [2, 10], [3, 0]]);
      (lev <= 0.5 ? pos : neg).push("Total debt is " + lev.toFixed(2) + "× annual revenue (" + money(totalDebt) + ").");
      F.push({
        id: "leverage", name: "Leverage", weight: 0.1, score: clamp(s, 0, 100),
        data: ["Total business debt", "Annual revenue"],
        positives: pos, negatives: neg,
        tip: "Keep total debt below half of annual revenue where possible."
      });
    })();

    (function () {
      var pos = [], neg = [];
      var months = opex > 0 ? cash / (opex / 12) : 0;
      var s = curve(months, [[0, 0], [1, 35], [3, 75], [6, 95], [12, 100]]);
      if (overdraftDays > 0) { s -= curve(overdraftDays, [[0, 0], [10, 15], [30, 30]]); neg.push("Business account overdrawn ~" + overdraftDays + " days/month."); }
      (months >= 3 ? pos : neg).push("Cash reserves cover " + months.toFixed(1) + " months of operating costs.");
      F.push({
        id: "liquidity", name: "Liquidity & cash flow", weight: 0.08, score: clamp(s, 0, 100),
        data: ["Cash reserves", "Operating expenses", "Overdraft days"],
        positives: pos, negatives: neg,
        tip: "Hold at least 3 months of operating costs in reserve."
      });
    })();

    (function () {
      var pos = [], neg = [];
      var ind = INDUSTRY_RISK[d.industry] || { label: "Other", score: 60 };
      var owner = ownerScore > 0 ? curve(ownerScore, [[300, 0], [580, 40], [670, 70], [740, 90], [800, 100]]) : 55;
      var s = curve(years, [[0, 10], [1, 30], [2, 55], [5, 85], [10, 100]]) * 0.45 + ind.score * 0.3 + owner * 0.25;
      (years >= 2 ? pos : neg).push("Trading for " + years + " year" + (years === 1 ? "" : "s") + ".");
      (ind.score >= 60 ? pos : neg).push("Industry (" + ind.label + ") carries " + (ind.score >= 70 ? "low" : ind.score >= 50 ? "moderate" : "elevated") + " sector risk.");
      if (ownerScore > 0) (ownerScore >= 670 ? pos : neg).push("Owner/director personal score: " + ownerScore + ".");
      F.push({
        id: "maturity", name: "Maturity, sector & owner", weight: 0.08, score: clamp(s, 0, 100),
        data: ["Years trading", "Industry", "Owner's personal credit score"],
        positives: pos, negatives: neg,
        tip: years < 2 ? "Businesses under 2 years old are higher risk; a personal guarantee or security can offset this." : "Your trading history works in your favour."
      });
    })();

    (function () {
      var pos = [], neg = [];
      var opexRatio = revenue > 0 ? opex / revenue : 1.2;
      var s = curve(discretionaryShare, [[0, 100], [10, 85], [20, 60], [35, 30], [50, 10]]);
      if (discretionaryShare > 15) neg.push(pct(discretionaryShare) + " of expenses are non-essential (entertainment, travel, subscriptions).");
      else pos.push("Spending is focused on core operations (" + pct(discretionaryShare) + " non-essential).");
      if (prevRevenue > 0 && opexRatio > 0.95) { s -= 15; neg.push("Costs consume " + pct(opexRatio * 100) + " of revenue."); }
      F.push({
        id: "spending", name: "Spending discipline", weight: 0.06, score: clamp(s, 0, 100),
        data: ["Expense categories", "Business bank transactions (if uploaded)"],
        positives: pos, negatives: neg,
        tip: "Trim non-essential spend (travel, entertainment, unused subscriptions) to below 10% of costs."
      });
    })();

    return F;
  }

  // =====================================================================
  function evaluate(type, data) {
    var factors = type === "business" ? businessFactors(data) : individualFactors(data);
    var weighted = 0;
    factors.forEach(function (f) {
      f.score = Math.round(f.score);
      f.rating = rating(f.score);
      f.points = Math.round((f.weight * f.score * SPAN) / 100);
      f.maxPoints = Math.round(f.weight * SPAN);
      f.upside = Math.max(0, Math.round((f.weight * (TARGET_FACTOR_SCORE - f.score) * SPAN) / 100));
      weighted += f.weight * f.score;
    });
    var score = Math.round(MIN_SCORE + (SPAN * weighted) / 100);
    var b = band(score);
    var hurting = factors.filter(function (f) { return f.score < 70; })
      .sort(function (a, z) { return z.upside - a.upside; });
    var helping = factors.filter(function (f) { return f.score >= 80; })
      .sort(function (a, z) { return z.points - a.points; });
    return {
      type: type,
      score: score,
      band: b,
      factors: factors,
      hurting: hurting,
      helping: helping,
      potential: Math.min(850, score + hurting.reduce(function (s, f) { return s + f.upside; }, 0))
    };
  }

  // Spending helpers (shared with UI)
  KamL.SPEND_CATEGORIES = [
    { id: "housing", label: "Rent / mortgage", essential: true },
    { id: "utilities", label: "Utilities & bills", essential: true },
    { id: "groceries", label: "Groceries", essential: true },
    { id: "transport", label: "Transport", essential: true },
    { id: "insurance", label: "Insurance & health", essential: true },
    { id: "dining", label: "Dining & takeaway", essential: false },
    { id: "shopping", label: "Shopping", essential: false },
    { id: "entertainment", label: "Entertainment & subscriptions", essential: false },
    { id: "travel", label: "Travel", essential: false },
    { id: "gambling", label: "Gambling", essential: false },
    { id: "other", label: "Other", essential: false }
  ];
  KamL.spendTotal = function (sp) {
    if (!sp) return 0;
    return Object.keys(sp).reduce(function (s, k) { return s + num(sp[k]); }, 0);
  };
  KamL.spendEssential = function (sp) {
    if (!sp) return 0;
    return KamL.SPEND_CATEGORIES.filter(function (c) { return c.essential; })
      .reduce(function (s, c) { return s + num(sp[c.id]); }, 0);
  };

  KamL.scoring = { evaluate: evaluate, band: band, BANDS: BANDS, INDUSTRY_RISK: INDUSTRY_RISK, num: num, clamp: clamp, curve: curve, money: money, pct: pct };
})();
