// Pure calculations for the dashboard. No DOM access, so node can test it.
// All money is in today's dollars and all returns are real (after inflation).

export const MEDICARE_AGE = 65;
export const PENALTY_FREE_AGE = 59.5;

export const ASSET_CLASSES = [
  { key: 'usStocks', label: 'US stocks' },
  { key: 'intlStocks', label: 'International stocks' },
  { key: 'bonds', label: 'Bonds / TIPS' },
  { key: 'realEstate', label: 'Real estate (REITs)' },
  { key: 'cash', label: 'Cash' },
  { key: 'satellite', label: 'Individual stocks / satellite' },
];

// realReturn is the median compound real return, not the arithmetic mean.
// These are planning assumptions the user can edit, not forecasts.
export const DEFAULT_TIERS = {
  low: {
    label: 'Low risk', realReturn: 0.03, volatility: 0.07, worstDrawdown: -0.20,
    mix: { usStocks: 25, intlStocks: 13, bonds: 50, realEstate: 2, cash: 10, satellite: 0 },
  },
  medium: {
    label: 'Medium risk', realReturn: 0.045, volatility: 0.11, worstDrawdown: -0.35,
    mix: { usStocks: 45, intlStocks: 20, bonds: 25, realEstate: 5, cash: 3, satellite: 2 },
  },
  high: {
    label: 'High risk', realReturn: 0.055, volatility: 0.16, worstDrawdown: -0.50,
    mix: { usStocks: 55, intlStocks: 25, bonds: 5, realEstate: 5, cash: 0, satellite: 10 },
  },
};

export const TIER_KEYS = ['low', 'medium', 'high'];

export function sampleState() {
  return {
    version: 1,
    isSample: true,
    profile: { age: 42, targetAge: 50, planToAge: 95 },
    cashflow: {
      monthlyTakeHome: 19500, monthlyExpenses: 8200, retirementSpend: 98400,
      annualBonus: 40000, includeBonus: false,
    },
    accounts: { taxable: 692000, preTax: 548000, roth: 0, cash: 120000 },
    property: {
      homeValue: 540000, mortgage: 120000,
      otherAssets: 0, otherAssetsCountForFire: false,
      otherDebts: 0, otherDebtRate: 0,
    },
    executive: {
      ticker: 'Company stock', vestedEquity: 180000, unvestedEquity: 150000, includeUnvested: false,
      deferredComp: 0, includeDeferredComp: true, drawdownPct: 0,
    },
    retirement: {
      swr: 0.035, ssAnnual: 30000, ssStartAge: 67, healthcareAnnual: 18000,
      ordinaryTaxRate: 0.22, ltcgRate: 0.15, taxableGainFraction: 0.5,
      sabbaticalAge: 47,
    },
    plan: { tier: 'medium' },
    tiers: structuredClone(DEFAULT_TIERS),
    allocation: { usStocks: 50, intlStocks: 12, bonds: 15, realEstate: 0, cash: 9, satellite: 14 },
    household: { combineMembers: false },
    holdings: { use: false, rows: [] },
    log: [],
  };
}

// The shared dashboard starts with no balances of its own: joint accounts, the house and
// shared expenses go here, and each member's saved numbers are added on top.
export function householdState() {
  const s = sampleState();
  for (const [section, keys] of Object.entries(SUMMED_FIELDS)) for (const k of keys) s[section][k] = 0;
  s.executive.ticker = '';
  s.household.combineMembers = true;
  s.isSample = false;
  return s;
}

// Balances and flows that add up across people. Ages, spend, assumptions and the
// allocation stay the household's own.
export const SUMMED_FIELDS = {
  accounts: ['taxable', 'preTax', 'roth', 'cash'],
  property: ['homeValue', 'mortgage', 'otherAssets', 'otherDebts'],
  executive: ['vestedEquity', 'unvestedEquity', 'deferredComp'],
  cashflow: ['monthlyTakeHome', 'monthlyExpenses', 'annualBonus'],
  retirement: ['ssAnnual'],
};

export function combineHousehold(household, members) {
  const out = structuredClone(household);
  if (!household.household?.combineMembers) return out;
  for (const m of members) {
    for (const [section, keys] of Object.entries(SUMMED_FIELDS)) {
      for (const k of keys) out[section][k] += Number(m[section]?.[k]) || 0;
    }
  }
  return out;
}

// Fills anything missing from an older or imported file with defaults.
export function withDefaults(saved) {
  const merge = (base, over) => {
    if (over === undefined || over === null) return base;
    if (Array.isArray(base) || typeof base !== 'object' || base === null) return over;
    const out = { ...base };
    for (const k of Object.keys(over)) out[k] = merge(base[k], over[k]);
    return out;
  };
  return merge(sampleState(), saved);
}

export const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// ---- Holdings ----------------------------------------------------------------
// Optional rows (one per lot) that, when switched on, replace the typed account
// totals, the company stock line and the allocation percentages.

export const HOLDING_ACCOUNTS = [
  { key: 'taxable', label: 'Taxable' },
  { key: 'preTax', label: 'Pre-tax (401k, IRA)' },
  { key: 'roth', label: 'Roth' },
  { key: 'cash', label: 'Cash' },
  { key: 'company', label: 'Company stock (vested)' },
];

// Common broad funds, so most rows get their asset class without asking.
const KNOWN_TICKERS = {
  usStocks: ['VTI', 'VOO', 'SPY', 'IVV', 'ITOT', 'SCHB', 'SCHX', 'QQQ', 'VUG', 'VTV', 'VB', 'AVUV', 'RSP',
    'VTSAX', 'VFIAX', 'FSKAX', 'FXAIX', 'FZROX', 'SWTSX', 'SWPPX'],
  intlStocks: ['VXUS', 'VEA', 'VWO', 'IXUS', 'IEFA', 'IEMG', 'SCHF', 'AVDV', 'VTIAX', 'FTIHX', 'FZILX', 'SWISX'],
  bonds: ['BND', 'AGG', 'BNDX', 'SCHZ', 'VGIT', 'VGSH', 'VTIP', 'SCHP', 'TIP', 'GOVT', 'VBTLX', 'FXNAX', 'SWAGX'],
  realEstate: ['VNQ', 'VNQI', 'SCHH', 'IYR', 'VGSLX'],
  cash: ['SGOV', 'BIL', 'VMFXX', 'SPAXX', 'FDRXX', 'SWVXX'],
};
const TICKER_CLASS = Object.fromEntries(
  Object.entries(KNOWN_TICKERS).flatMap(([cls, tickers]) => tickers.map((t) => [t, cls])));

export function guessClass(ticker) {
  return TICKER_CLASS[String(ticker ?? '').trim().toUpperCase()] ?? null;
}

export function newHolding(account = 'taxable') {
  return { account, name: '', assetClass: account === 'cash' ? 'cash' : 'usStocks', shares: 0, price: 0, value: 0, basis: 0 };
}

// Shares x price when both are given, otherwise the value typed in.
export function holdingValue(h) {
  const shares = Number(h.shares) || 0;
  const price = Number(h.price) || 0;
  return shares > 0 && price > 0 ? shares * price : Number(h.value) || 0;
}

export function holdingsActive(s) {
  return Boolean(s.holdings?.use && s.holdings.rows?.length);
}

export function holdingTotals(rows) {
  const byAccount = Object.fromEntries(HOLDING_ACCOUNTS.map((a) => [a.key, 0]));
  const byClass = Object.fromEntries(ASSET_CLASSES.map((c) => [c.key, 0]));
  for (const h of rows) {
    const v = holdingValue(h);
    byAccount[h.account] = (byAccount[h.account] ?? 0) + v;
    const cls = h.account === 'company' ? 'satellite' : h.assetClass;
    byClass[cls in byClass ? cls : 'satellite'] += v;
  }
  return { byAccount, byClass, total: sum(Object.values(byAccount)) };
}

// Returns the state the math should use. `_derived` lists the input paths now
// coming from holdings, so the form can show them as calculated.
export function applyHoldings(s) {
  if (!holdingsActive(s)) return s;
  const out = structuredClone(s);
  const rows = s.holdings.rows;
  const { byAccount, byClass, total } = holdingTotals(rows);
  out.accounts = { taxable: byAccount.taxable, preTax: byAccount.preTax, roth: byAccount.roth, cash: byAccount.cash };
  out.executive.vestedEquity = byAccount.company;
  out.executive.drawdownPct = s.executive.drawdownPct;
  if (total > 0) {
    out.allocation = Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, Math.round((v / total) * 1000) / 10]));
  }
  out._derived = ['accounts.taxable', 'accounts.preTax', 'accounts.roth', 'accounts.cash', 'executive.vestedEquity', 'allocation'];

  // With a cost basis on every taxable lot, the gain share of a sale is known, not assumed.
  const taxableRows = rows.filter((h) => (h.account === 'taxable' || h.account === 'company') && holdingValue(h) > 0);
  if (taxableRows.length && taxableRows.every((h) => Number(h.basis) > 0)) {
    const value = sum(taxableRows.map(holdingValue));
    const basis = sum(taxableRows.map((h) => Number(h.basis)));
    out.retirement.taxableGainFraction = Math.min(1, Math.max(0, (value - basis) / value));
    out._derived.push('retirement.taxableGainFraction');
  }
  return out;
}

export function vestedAfterDrawdown(s) {
  return s.executive.vestedEquity * (1 - s.executive.drawdownPct / 100);
}

// Assets that can fund retirement. Home equity never counts; unvested equity only on request.
export function investableAssets(s) {
  const { accounts: a, executive: e, property: p } = s;
  return a.taxable + a.preTax + a.roth + a.cash + vestedAfterDrawdown(s)
    + (e.includeDeferredComp ? e.deferredComp : 0)
    + (e.includeUnvested ? e.unvestedEquity : 0)
    + (p.otherAssetsCountForFire ? p.otherAssets : 0)
    - p.otherDebts;
}

export function netWorth(s) {
  const { accounts: a, executive: e, property: p } = s;
  return a.taxable + a.preTax + a.roth + a.cash + vestedAfterDrawdown(s) + e.deferredComp
    + p.homeValue + p.otherAssets - p.mortgage - p.otherDebts;
}

// Blended tax on retirement withdrawals, weighted by where the money sits.
export function effectiveTaxRate(s) {
  const { accounts: a, executive: e, retirement: r } = s;
  const deferred = e.includeDeferredComp ? e.deferredComp : 0;
  const ordinary = a.preTax + deferred;
  const capitalGains = a.taxable + vestedAfterDrawdown(s);
  const total = ordinary + capitalGains + a.roth + a.cash;
  if (total <= 0) return 0;
  const rate = (ordinary * r.ordinaryTaxRate + capitalGains * r.ltcgRate * r.taxableGainFraction) / total;
  return Math.min(Math.max(rate, 0), 0.9);
}

export function monthlySavings(s) {
  const c = s.cashflow;
  return c.monthlyTakeHome - c.monthlyExpenses + (c.includeBonus ? c.annualBonus / 12 : 0);
}

export function savingsRate(s) {
  const c = s.cashflow;
  const income = c.monthlyTakeHome + (c.includeBonus ? c.annualBonus / 12 : 0);
  return income > 0 ? monthlySavings(s) / income : 0;
}

// FIRE target = (spend not covered by Social Security, grossed up for tax) / withdrawal rate
//   + a reserve for the Social Security amount until it starts
//   + a reserve for healthcare premiums until Medicare.
export function fireTarget(s, o = {}) {
  const r = s.retirement;
  const spend = o.retirementSpend ?? s.cashflow.retirementSpend;
  const swr = o.swr ?? r.swr;
  const fireAge = o.fireAge ?? s.profile.targetAge;
  const taxRate = effectiveTaxRate(s);
  const gross = (x) => x / (1 - taxRate);
  const ss = Math.min(r.ssAnnual, spend);
  const ssBridgeYears = ss > 0 ? Math.max(0, r.ssStartAge - fireAge) : 0;
  const healthcareBridgeYears = Math.max(0, MEDICARE_AGE - fireAge);
  const core = gross(spend - ss) / swr;
  const ssBridge = gross(ss) * ssBridgeYears;
  const healthcareBridge = gross(r.healthcareAnnual) * healthcareBridgeYears;
  return {
    core, ssBridge, healthcareBridge, total: core + ssBridge + healthcareBridge,
    taxRate, ssBridgeYears, healthcareBridgeYears, grossSpend: gross(spend),
  };
}

// The classic ladder from the article: multiples of annual spend, no tax or bridges.
export function milestones(s) {
  const spend = s.cashflow.retirementSpend;
  return { lean: spend * 20, standard: spend * 25, fat: spend * 32 };
}

// Months until `start` grows to `target`. `savings` is a monthly amount or a
// function of the month index (0-based). Returns null if never reached.
export function monthsToTarget(start, target, annualReturn, savings, maxMonths = 720) {
  if (start >= target) return 0;
  const rm = Math.pow(1 + annualReturn, 1 / 12) - 1;
  const at = typeof savings === 'function' ? savings : () => savings;
  let p = start;
  for (let m = 1; m <= maxMonths; m++) {
    p = p * (1 + rm) + at(m - 1);
    if (p >= target) return m;
  }
  return null;
}

// Year-end balances from now (year 0) for `years` years.
export function projectBalances(start, annualReturn, monthly, years) {
  const rm = Math.pow(1 + annualReturn, 1 / 12) - 1;
  const out = [start];
  let p = start;
  for (let y = 1; y <= years; y++) {
    for (let m = 0; m < 12; m++) p = p * (1 + rm) + monthly;
    out.push(p);
  }
  return out;
}

// Amount needed today to reach the target by targetAge with no more saving.
export function coastNumber(target, annualReturn, years) {
  return target / Math.pow(1 + annualReturn, Math.max(0, years));
}

export function planTier(s) {
  return s.tiers[s.plan.tier] ?? s.tiers.medium;
}

export function summary(s) {
  const tier = planTier(s);
  const investable = investableAssets(s);
  const target = fireTarget(s);
  const monthly = monthlySavings(s);
  const months = monthsToTarget(investable, target.total, tier.realReturn, monthly);
  const yearsToTargetAge = s.profile.targetAge - s.profile.age;
  const coast = coastNumber(target.total, tier.realReturn, yearsToTargetAge);
  return {
    tier, investable, netWorth: netWorth(s), target, monthly,
    savingsRate: savingsRate(s),
    progress: target.total > 0 ? investable / target.total : 0,
    gap: Math.max(0, target.total - investable),
    yearsToFire: months === null ? null : months / 12,
    fireAge: months === null ? null : s.profile.age + months / 12,
    coast, coastReached: investable >= coast,
    milestones: milestones(s),
  };
}

// ---- Monte Carlo -------------------------------------------------------------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function percentile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

// Simulates yearly lognormal returns. Each path answers two questions:
//  1. At what age does the portfolio first reach the FIRE target?
//  2. If you retire at targetAge regardless, does the money last to planToAge?
// shockFirstYear replaces the first retirement year's return (e.g. -0.30).
export function monteCarlo(s, tier, { sims = 2000, seed = 7, shockFirstYear = null } = {}) {
  const { age, targetAge, planToAge } = s.profile;
  const r = s.retirement;
  const start = investableAssets(s);
  const save = monthlySavings(s) * 12;
  const target = fireTarget(s);
  const gross = (x) => x / (1 - target.taxRate);
  const spend = s.cashflow.retirementSpend;
  const ss = Math.min(r.ssAnnual, spend);
  const mu = Math.log(1 + tier.realReturn);
  const rand = mulberry32(seed);
  const horizon = Math.max(1, planToAge - age);

  const fireAges = [];
  let reachedByTarget = 0;
  let survived = 0;
  for (let i = 0; i < sims; i++) {
    let p = start;
    let reachedAt = start >= target.total ? age : null;
    let q = start;
    for (let y = 0; y < horizon; y++) {
      const g = Math.exp(mu + tier.volatility * gaussian(rand)) - 1;
      const curAge = age + y;
      if (reachedAt === null) {
        p = p * (1 + g) + save;
        if (p >= target.total) reachedAt = curAge + 1;
      }
      if (curAge < targetAge) {
        q = q * (1 + g) + save;
      } else if (q > 0) {
        const ret = curAge === targetAge && shockFirstYear !== null ? shockFirstYear : g;
        const need = gross(spend - (curAge >= r.ssStartAge ? ss : 0))
          + (curAge < MEDICARE_AGE ? gross(r.healthcareAnnual) : 0);
        q = (q - need) * (1 + ret);
      }
    }
    fireAges.push(reachedAt ?? Infinity);
    if (reachedAt !== null && reachedAt <= targetAge) reachedByTarget++;
    if (q > 0) survived++;
  }
  fireAges.sort((a, b) => a - b);
  return {
    successRate: survived / sims,
    reachByTargetRate: reachedByTarget / sims,
    fireAgeP10: percentile(fireAges, 0.1),
    fireAgeP50: percentile(fireAges, 0.5),
    fireAgeP90: percentile(fireAges, 0.9),
  };
}

// ---- What-if and stress tests ------------------------------------------------

export function whatIf(s, { monthly, retirementSpend, realReturn, swr }) {
  const target = fireTarget(s, { retirementSpend, swr }).total;
  const months = monthsToTarget(investableAssets(s), target, realReturn, monthly);
  return {
    target,
    yearsToFire: months === null ? null : months / 12,
    fireAge: months === null ? null : s.profile.age + months / 12,
  };
}

export function stressTests(s) {
  const tier = planTier(s);
  const base = summary(s);
  const start = base.investable;
  const target = base.target.total;
  const monthly = base.monthly;
  const fireAgeFor = (months) => (months === null ? null : s.profile.age + months / 12);
  const row = (key, label, months, note) => {
    const fireAge = fireAgeFor(months);
    return {
      key, label, fireAge, note,
      delta: fireAge === null || base.fireAge === null ? null : fireAge - base.fireAge,
    };
  };

  const rows = [];

  const company = vestedAfterDrawdown(s);
  rows.push(row('company', `${s.executive.ticker || 'Company stock'} falls 50%`,
    monthsToTarget(start - company * 0.5, target, tier.realReturn, monthly),
    company > 0 ? `Loses ${fmtMoney(company * 0.5)} of vested equity.` : 'No vested equity entered.'));

  const bonusMonthly = s.cashflow.includeBonus ? s.cashflow.annualBonus / 12 : 0;
  rows.push(row('bonus', 'Bonus disappears for two years',
    monthsToTarget(start, target, tier.realReturn, (m) => (m < 24 ? monthly - bonusMonthly : monthly)),
    bonusMonthly > 0 ? 'Bonus removed from savings for 24 months.'
      : 'Bonus is not counted in your savings, so the plan does not depend on it.'));

  const sabStart = Math.round((s.retirement.sabbaticalAge - s.profile.age) * 12);
  const sabMonths = monthsToTarget(start, target, tier.realReturn,
    (m) => (m >= sabStart && m < sabStart + 12 ? -s.cashflow.monthlyExpenses : monthly));
  rows.push(row('sabbatical', `12-month sabbatical at ${s.retirement.sabbaticalAge}`, sabMonths,
    sabStart < 0 ? 'Sabbatical age is in the past.'
      : 'No saving for 12 months, expenses paid from the portfolio.'));

  const lowerSwr = Math.max(0.025, s.retirement.swr - 0.005);
  const swrTarget = fireTarget(s, { swr: lowerSwr }).total;
  rows.push(row('swr', `Withdrawal rate ${pct(lowerSwr, 1)} instead of ${pct(s.retirement.swr, 1)}`,
    monthsToTarget(start, swrTarget, tier.realReturn, monthly),
    `Target rises to ${fmtMoney(swrTarget)}.`));

  const normal = monteCarlo(s, tier);
  const shocked = monteCarlo(s, tier, { shockFirstYear: -0.30 });
  rows.push({
    key: 'crash', label: 'Market falls 30% in your first retirement year',
    fireAge: base.fireAge, delta: null,
    note: `Chance the money lasts to ${s.profile.planToAge}: ${pct(normal.successRate)} normally, `
      + `${pct(shocked.successRate)} with the crash.`,
    successRate: shocked.successRate, baselineSuccessRate: normal.successRate,
  });
  return rows;
}

// ---- Formatting --------------------------------------------------------------

export function fmtMoney(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  const sign = x < 0 ? '-' : '';
  const v = Math.abs(x);
  if (v >= 1e6) return `${sign}$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${sign}$${Math.round(v / 1e3).toLocaleString('en-US')}K`;
  return `${sign}$${Math.round(v).toLocaleString('en-US')}`;
}

export function pct(x, digits = 0) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

export function fmtAge(x) {
  return x === null || !Number.isFinite(x) ? 'not reached' : x.toFixed(1);
}
