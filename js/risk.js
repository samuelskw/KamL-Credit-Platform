/*
 * Bank-side risk assessment.
 *
 * Converts a credit score into a probability of default (PD), combines it with
 * loss-given-default (LGD) for the product, and builds a risk-based interest
 * rate the way a lender's pricing desk would:
 *
 *   rate = base rate + funding spread + expected loss + capital charge
 *          + operating cost + profit margin
 */
(function () {
  "use strict";
  var KamL = (window.KamL = window.KamL || {});
  var S = KamL.scoring;

  var SETTINGS = {
    baseRate: 4.0,        // central bank policy rate, % (editable in UI)
    fundingSpread: 1.25,  // bank's cost of funds above base, %
    capitalRatio: 0.105,  // capital held against risk-weighted assets
    costOfEquity: 0.12,   // shareholders' required return
    operatingCost: 1.0,   // servicing/admin, % of balance per year
    margin: 1.5,          // target profit margin, %
    maxPD: 0.35           // above this the application is declined
  };

  // Loan products: LGD = share of balance lost if borrower defaults.
  var PRODUCTS = {
    personal:      { label: "Personal loan (unsecured)", lgd: 0.75, rw: 0.75, who: "individual", minTerm: 12, maxTerm: 84 },
    car:           { label: "Car finance (secured on vehicle)", lgd: 0.45, rw: 0.75, who: "individual", minTerm: 12, maxTerm: 60 },
    consolidation: { label: "Debt consolidation", lgd: 0.8, rw: 0.75, who: "individual", minTerm: 12, maxTerm: 84 },
    home:          { label: "Home improvement", lgd: 0.7, rw: 0.75, who: "individual", minTerm: 12, maxTerm: 120 },
    mortgage:      { label: "Mortgage (secured on property)", lgd: 0.2, rw: 0.35, who: "individual", minTerm: 60, maxTerm: 420 },
    working:       { label: "Working capital loan", lgd: 0.7, rw: 1.0, who: "business", minTerm: 6, maxTerm: 60 },
    equipment:     { label: "Equipment / asset finance", lgd: 0.45, rw: 1.0, who: "business", minTerm: 12, maxTerm: 84 },
    expansion:     { label: "Growth / expansion loan", lgd: 0.65, rw: 1.0, who: "business", minTerm: 12, maxTerm: 120 },
    property:      { label: "Commercial mortgage", lgd: 0.3, rw: 0.5, who: "business", minTerm: 60, maxTerm: 300 }
  };

  var TIERS = [
    { id: "A", maxPD: 0.01, label: "Prime", status: "good", desc: "Minimal risk — best rates and highest limits." },
    { id: "B", maxPD: 0.03, label: "Near-prime", status: "good", desc: "Low risk — mainstream approval at competitive rates." },
    { id: "C", maxPD: 0.08, label: "Standard", status: "warning", desc: "Moderate risk — approval likely with a risk premium." },
    { id: "D", maxPD: 0.2, label: "Sub-prime", status: "serious", desc: "Elevated risk — specialist lenders, lower limits, higher rates." },
    { id: "E", maxPD: 1.01, label: "High risk", status: "critical", desc: "Mainstream lenders will usually decline; credit-builder products only." }
  ];

  // 12-month probability of default from score (logistic calibration).
  function probabilityOfDefault(score, type) {
    var mid = type === "business" ? 500 : 480; // businesses default more at the same score
    return 1 / (1 + Math.exp((score - mid) / 55));
  }

  function tierFor(pd) {
    for (var i = 0; i < TIERS.length; i++) if (pd < TIERS[i].maxPD) return TIERS[i];
    return TIERS[TIERS.length - 1];
  }

  function assess(result, productId, settings) {
    var cfg = Object.assign({}, SETTINGS, settings || {});
    var product = PRODUCTS[productId];
    var pd = probabilityOfDefault(result.score, result.type);
    var tier = tierFor(pd);
    var lgd = product.lgd;
    var el = pd * lgd;                                   // expected loss, fraction per year
    var riskWeight = product.rw * (0.6 + Math.min(pd, 0.3) * 4); // riskier borrowers attract more capital
    var capitalCharge = cfg.capitalRatio * riskWeight * cfg.costOfEquity * 100;

    var components = [
      { id: "base", label: "Base rate", value: cfg.baseRate, note: "Central bank policy rate — the floor for all lending." },
      { id: "funding", label: "Funding spread", value: cfg.fundingSpread, note: "Bank's extra cost of raising deposits and wholesale funding." },
      { id: "el", label: "Expected loss", value: el * 100, note: "PD " + S.pct(pd * 100) + " × LGD " + S.pct(lgd * 100) + " — average losses priced in." },
      { id: "capital", label: "Capital charge", value: capitalCharge, note: "Cost of the equity regulators require the bank to hold against this loan." },
      { id: "ops", label: "Operating cost", value: cfg.operatingCost, note: "Underwriting, servicing and collections." },
      { id: "margin", label: "Profit margin", value: cfg.margin, note: "Lender's target return." }
    ];
    var rate = components.reduce(function (s, c) { return s + c.value; }, 0);
    var riskPremium = components.filter(function (c) { return c.id === "el" || c.id === "capital"; })
      .reduce(function (s, c) { return s + c.value; }, 0);

    return {
      pd: pd,
      lgd: lgd,
      el: el,
      tier: tier,
      product: product,
      productId: productId,
      components: components,
      rate: Math.round(rate * 100) / 100,
      riskPremium: riskPremium,
      declined: pd > cfg.maxPD,
      settings: cfg
    };
  }

  // Monthly payment for an amortising loan.
  function payment(principal, annualRatePct, months) {
    var r = annualRatePct / 100 / 12;
    if (r === 0) return principal / months;
    return (principal * r) / (1 - Math.pow(1 + r, -months));
  }

  // UK-style APR: annualised effective rate that equates net advance with payments.
  function apr(principal, fee, monthlyPayment, months) {
    var net = principal - fee;
    if (net <= 0) return NaN;
    var lo = 0, hi = 1; // monthly rate bounds
    for (var i = 0; i < 80; i++) {
      var mid = (lo + hi) / 2;
      var pv = mid === 0 ? monthlyPayment * months : (monthlyPayment * (1 - Math.pow(1 + mid, -months))) / mid;
      if (pv > net) lo = mid; else hi = mid;
    }
    return (Math.pow(1 + (lo + hi) / 2, 12) - 1) * 100;
  }

  KamL.risk = {
    SETTINGS: SETTINGS,
    PRODUCTS: PRODUCTS,
    TIERS: TIERS,
    assess: assess,
    probabilityOfDefault: probabilityOfDefault,
    payment: payment,
    apr: apr
  };
})();
