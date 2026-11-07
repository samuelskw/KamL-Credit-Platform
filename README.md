# KamL-Credit-Platform
make credit accessible

A transparent credit platform for **individuals and businesses**. It scores creditworthiness from financial data and spending habits, explains every point of the score, shows how a bank would price the risk, and compares loan offers from several lenders.

## Run it

No build step and no dependencies. Open `index.html` in any modern browser. All processing happens in the browser, so no data leaves the device.

Use the **example profiles** (graduate with a thin file, established professional, overstretched borrower, café, software firm) for a quick demo, or upload a bank-statement CSV.

## The four steps

1. **Your data.** Fill in a form, or upload a CSV statement (`date, description, amount[, balance]`) that is auto-categorised into spending habits, income regularity and overdraft use.
2. **Credit score (300–850).** You get a band, the factors helping and hurting the score, a per-factor breakdown with points earned, tips to improve, and the "achievable score" if you follow them.
3. **Risk and interest rate.** The score is converted to a probability of default and a risk tier (A–E), then to a risk-based rate:
   `rate = base rate + funding spread + expected loss (PD × LGD) + capital charge + operating cost + margin`.
   This step also includes an interactive rate-vs-score curve and a table of bank risk tiers.
4. **Loan offers.** Ten fictional lenders, each with its own risk appetite (minimum score, pricing adjustment, fees, limits, rate caps), plus affordability checks. You can sort by APR, monthly payment, total cost or approval chance, see why some lenders can't lend, and choose an offer.

## Data used

### Individuals
| Factor | Weight | Data |
|---|---|---|
| Payment history | 27% | Late payments (12m / older), defaults & CCJs, bankruptcy/IVA, **on-time rent & utilities (alternative data)** |
| Credit utilisation | 18% | Card/overdraft limits, current balances |
| Debt-to-income | 13% | Monthly income, monthly debt repayments |
| Length & mix of credit | 13% | Oldest account age, number of accounts, credit types |
| Spending habits | 12% | Spending by category, essential vs discretionary, gambling, overdraft days, bank transactions |
| Savings buffer | 7% | Cash savings, investments, monthly outgoings |
| Income & stability | 7% | Employment status, tenure, income regularity, years at address, income level |
| Recent applications | 3% | Hard credit searches in last 12 months |

### Businesses
| Factor | Weight | Data |
|---|---|---|
| Repayment & trade history | 24% | Late payments, defaults/CCJs, supplier days beyond terms |
| Debt service coverage | 20% | Revenue, operating expenses, annual debt repayments (DSCR) |
| Profitability | 12% | Operating margin |
| Revenue scale & growth | 12% | Current and prior-year revenue |
| Leverage | 10% | Total debt ÷ revenue |
| Liquidity & cash flow | 8% | Cash reserves vs operating costs, overdraft days |
| Maturity, sector & owner | 8% | Years trading, industry risk, owner's personal score |
| Spending discipline | 6% | Non-essential expense share, cost-to-revenue |

### Never used
Race/ethnicity, religion, gender, sexual orientation, marital status, nationality, disability, pregnancy, postcode, or social media. Age is collected only to check the applicant is 18 or over.

## Code layout
| File | Purpose |
|---|---|
| `js/scoring.js` | Scoring engine: factor models, explanations, tips, bands |
| `js/risk.js` | PD calibration, risk tiers, LGD by product, rate build-up, payment and APR maths |
| `js/lenders.js` | Fictional lender catalogue, eligibility, affordability, offer pricing |
| `js/transactions.js` | CSV parsing, transaction categorisation, sample statement, demo personas |
| `js/app.js` | UI: form, results, charts, offers |

> Demo only. All lenders are fictional, and the scores and quotes are illustrative, not regulated credit decisions.
