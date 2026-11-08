/*
 * Lender marketplace. All lenders are fictional.
 *
 * Every lender starts from the risk-based rate produced by risk.js and applies
 * its own appetite: a pricing adjustment, eligibility rules, fees and limits.
 */
(function () {
  "use strict";
  var KamL = (window.KamL = window.KamL || {});
  var R = KamL.risk;
  var S = KamL.scoring;

  var LENDERS = [
    {
      id: "northbridge", name: "Northbridge Bank", kind: "High-street bank",
      serves: ["individual", "business"], products: ["personal", "car", "consolidation", "home", "mortgage", "working", "expansion", "property"],
      minScore: 680, adj: -0.4, fee: 0, minAmount: 1000, maxAmount: 50000, maxAmountSecured: 750000, floor: 5.9, cap: 19.9,
      perks: ["No arrangement fee", "Existing-customer rate discounts"]
    },
    {
      id: "harbourvale", name: "Harbour & Vale Building Society", kind: "Building society",
      serves: ["individual"], products: ["mortgage", "home"],
      minScore: 640, adj: -0.6, productAdj: { mortgage: -1.5 }, fee: 999, feeType: "flat", minAmount: 5000, maxAmount: 600000, floor: 4.6, cap: 14.9,
      perks: ["Member-owned — profits returned as better rates", "Free valuation"]
    },
    {
      id: "kestrel", name: "Kestrel Digital", kind: "Digital bank",
      serves: ["individual", "business"], products: ["personal", "car", "consolidation", "home", "working", "equipment"],
      minScore: 610, adj: 0.2, fee: 0, minAmount: 500, maxAmount: 25000, floor: 6.4, cap: 29.9,
      perks: ["Decision in minutes", "Overpay any time with no fees"]
    },
    {
      id: "meridian", name: "Meridian Community Credit Union", kind: "Credit union",
      serves: ["individual"], products: ["personal", "consolidation", "home", "car"],
      minScore: 520, adj: -1.5, fee: 0, minAmount: 200, maxAmount: 15000, floor: 6.9, cap: 42.6,
      perks: ["Not-for-profit", "Free financial coaching", "Membership required (free)"]
    },
    {
      id: "brightpath", name: "Brightpath Lending", kind: "Specialist lender",
      serves: ["individual"], products: ["personal", "consolidation", "car"],
      minScore: 540, adj: 2.5, fee: 0.03, feeType: "pct", minAmount: 1000, maxAmount: 20000, floor: 9.9, cap: 49.9,
      perks: ["Considers applicants with past missed payments"]
    },
    {
      id: "secondstep", name: "Second Step Finance", kind: "Credit-builder lender",
      serves: ["individual"], products: ["personal"],
      minScore: 420, adj: 5, fee: 0, minAmount: 100, maxAmount: 3000, floor: 19.9, cap: 59.9, ignoreDecline: true,
      perks: ["Built for thin or damaged credit files", "Reports every on-time payment to help you rebuild"]
    },
    {
      id: "oakline", name: "Oakline Private Bank", kind: "Private bank",
      serves: ["individual", "business"], products: ["personal", "mortgage", "property", "expansion"],
      minScore: 760, adj: -0.9, fee: 0.005, feeType: "pct", minAmount: 25000, maxAmount: 250000, maxAmountSecured: 2000000, floor: 4.4, cap: 12.9,
      perks: ["Dedicated relationship manager", "Tailored repayment schedules"]
    },
    {
      id: "atlas", name: "Atlas Commercial Bank", kind: "Business bank",
      serves: ["business"], products: ["working", "equipment", "expansion", "property"],
      minScore: 650, adj: -0.3, fee: 0.01, feeType: "pct", minAmount: 10000, maxAmount: 500000, maxAmountSecured: 3000000, floor: 5.5, cap: 18.9,
      minYears: 2, perks: ["Sector specialist teams", "Capital repayment holidays available"]
    },
    {
      id: "fernway", name: "Fernway Growth Finance", kind: "Alternative business lender",
      serves: ["business"], products: ["working", "equipment", "expansion"],
      minScore: 560, adj: 3, fee: 0.025, feeType: "pct", minAmount: 5000, maxAmount: 150000, floor: 9.5, cap: 34.9,
      perks: ["Accepts businesses trading 6+ months", "Funds in 48 hours"]
    },
    {
      id: "tillerman", name: "Tillerman Asset Finance", kind: "Asset finance specialist",
      serves: ["business"], products: ["equipment"],
      minScore: 590, adj: -0.5, fee: 250, feeType: "flat", minAmount: 3000, maxAmount: 400000, floor: 6.5, cap: 24.9,
      perks: ["Equipment is the security — no property needed", "Seasonal repayment profiles"]
    }
  ];

  var SECURED = { mortgage: true, property: true };

  function likelihood(margin, affordable) {
    if (!affordable) return { label: "Unlikely", value: 0.15, status: "critical" };
    if (margin >= 60) return { label: "Very likely", value: 0.9, status: "good" };
    if (margin >= 25) return { label: "Likely", value: 0.75, status: "good" };
    if (margin >= 0) return { label: "Possible", value: 0.5, status: "warning" };
    return { label: "Unlikely", value: 0.15, status: "critical" };
  }

  /*
   * request = { productId, amount, termMonths }
   * profile = { type, monthlyIncome, monthlyDebtPayments, yearsInOperation, annualRevenue, annualOperatingExpenses, annualDebtService }
   */
  function offers(result, risk, request, profile) {
    var out = [], ineligible = [];
    LENDERS.forEach(function (L) {
      var reasons = [];
      if (L.serves.indexOf(result.type) < 0) return;
      if (L.products.indexOf(request.productId) < 0) return;
      if (result.score < L.minScore) reasons.push("Minimum score " + L.minScore + " (yours: " + result.score + ")");
      if (risk.declined && !L.ignoreDecline) reasons.push("Default risk above lender's appetite");
      var maxAmt = SECURED[request.productId] && L.maxAmountSecured ? L.maxAmountSecured : L.maxAmount;
      if (request.amount < L.minAmount) reasons.push("Minimum loan " + S.money(L.minAmount));
      if (request.amount > maxAmt) reasons.push("Maximum loan " + S.money(maxAmt));
      if (L.minYears && S.num(profile.yearsInOperation) < L.minYears) reasons.push("Requires " + L.minYears + "+ years trading");

      var rate = risk.rate + L.adj + ((L.productAdj && L.productAdj[request.productId]) || 0);
      rate = Math.round(S.clamp(rate, L.floor, L.cap) * 100) / 100;
      if (risk.rate + L.adj > L.cap + 3) reasons.push("Your risk-based rate exceeds this lender's cap of " + L.cap + "%");

      var fee = L.feeType === "pct" ? request.amount * L.fee : L.fee || 0;
      var monthly = R.payment(request.amount, rate, request.termMonths);
      var total = monthly * request.termMonths + fee;
      var aprVal = R.apr(request.amount, fee, monthly, request.termMonths);

      // Affordability: new + existing repayments vs income
      var affordable = true, dsr = null;
      if (result.type === "individual") {
        var income = S.num(profile.monthlyIncome);
        var existing = S.num(profile.monthlyDebtPayments);
        // A consolidation loan replaces the debts it pays off, so it isn't added on top.
        var outgoing = request.productId === "consolidation" ? Math.max(existing, monthly) : existing + monthly;
        var limit = request.productId === "mortgage" ? 45 : 40;
        if (income > 0) {
          dsr = (outgoing / income) * 100;
          affordable = dsr <= limit;
          if (dsr > 60) reasons.push("Repayments would take " + S.pct(dsr) + " of income");
        } else {
          dsr = null; // no income: a percentage would be meaningless
          affordable = false;
          reasons.push("No income to make repayments from");
        }
      } else {
        var noi = S.num(profile.annualRevenue) - S.num(profile.annualOperatingExpenses);
        var service = S.num(profile.annualDebtService) + monthly * 12;
        dsr = service > 0 ? noi / service : 99; // DSCR after new loan
        affordable = dsr >= 1.2;
        if (dsr < 0.9) reasons.push("Post-loan DSCR " + dsr.toFixed(2) + "× is below 0.9×");
      }

      var offer = {
        lender: L, rate: rate, apr: aprVal, fee: fee, monthly: monthly, total: total,
        interest: total - request.amount, dsr: dsr, affordable: affordable,
        likelihood: likelihood(result.score - L.minScore, affordable)
      };
      if (reasons.length) { offer.reasons = reasons; ineligible.push(offer); }
      else out.push(offer);
    });
    return { eligible: out, ineligible: ineligible };
  }

  KamL.lenders = { LENDERS: LENDERS, offers: offers };
})();
