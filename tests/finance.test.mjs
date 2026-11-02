// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as f from '../static/finance.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);

// A plain state with every adjustment switched off, so results match the classic rule.
function classic() {
  const s = f.sampleState();
  s.accounts = { taxable: 872000, preTax: 548000, roth: 0, cash: 120000 };
  s.property = { homeValue: 0, mortgage: 0, otherAssets: 420000, otherAssetsCountForFire: true,
    otherDebts: 120000, otherDebtRate: 0 };
  s.executive = { ticker: '', vestedEquity: 0, unvestedEquity: 0, includeUnvested: false,
    deferredComp: 0, includeDeferredComp: true, drawdownPct: 0 };
  s.retirement = { ...s.retirement, swr: 0.04, ssAnnual: 0, healthcareAnnual: 0,
    ordinaryTaxRate: 0, ltcgRate: 0 };
  return s;
}

test('article sample: FIRE number is annual spend x 25 at 4%', () => {
  const s = classic();
  assert.equal(f.fireTarget(s).total, 98400 * 25);
});

test('article sample: net worth adds to 1.84M, not the 1.82M printed', () => {
  const s = classic();
  assert.equal(f.netWorth(s), 872000 + 548000 + 120000 + 420000 - 120000);
  assert.equal(f.netWorth(s), 1840000);
});

test('article sample: savings rate 58%', () => {
  close(f.savingsRate(classic()), 11300 / 19500, 1e-12);
});

test('article sample: years to FIRE at 5% is about 3, not 7.8', () => {
  // 1.82M growing at 5% real with 11,300/month reaches 2.46M in under 3 years.
  const months = f.monthsToTarget(1820000, 2460000, 0.05, 11300);
  assert.ok(months > 30 && months < 36, `months=${months}`);
  // Even with zero growth it is 640K / 11.3K = 56.6 months, i.e. 4.7 years.
  assert.equal(f.monthsToTarget(1820000, 2460000, 0, 11300), Math.ceil(640000 / 11300));
});

test('monthsToTarget matches the closed-form future value', () => {
  const r = 0.05, rm = Math.pow(1 + r, 1 / 12) - 1, P = 500000, C = 4000;
  const m = f.monthsToTarget(P, 1e6, r, C);
  const fv = (n) => P * Math.pow(1 + rm, n) + C * (Math.pow(1 + rm, n) - 1) / rm;
  assert.ok(fv(m) >= 1e6 && fv(m - 1) < 1e6);
});

test('monthsToTarget returns 0 when already there and null when unreachable', () => {
  assert.equal(f.monthsToTarget(2e6, 1e6, 0.05, 0), 0);
  assert.equal(f.monthsToTarget(100, 1e6, 0, 0), null);
});

test('home equity counts in net worth but never in investable assets', () => {
  const s = classic();
  s.property.otherAssetsCountForFire = false;
  s.property.homeValue = 900000;
  s.property.mortgage = 300000;
  assert.equal(f.investableAssets(s), 872000 + 548000 + 120000 - 120000);
  assert.equal(f.netWorth(s), 1840000 + 600000);
});

test('unvested equity is excluded unless switched on', () => {
  const s = classic();
  const before = f.investableAssets(s);
  s.executive.unvestedEquity = 200000;
  assert.equal(f.investableAssets(s), before);
  s.executive.includeUnvested = true;
  assert.equal(f.investableAssets(s), before + 200000);
});

test('drawdown slider cuts vested equity', () => {
  const s = classic();
  s.executive.vestedEquity = 100000;
  const before = f.investableAssets(s);
  s.executive.drawdownPct = 50;
  assert.equal(f.investableAssets(s), before - 50000);
});

test('tax gross-up: all pre-tax at 22% means spend / 0.78', () => {
  const s = classic();
  s.accounts = { taxable: 0, preTax: 1e6, roth: 0, cash: 0 };
  s.retirement.ordinaryTaxRate = 0.22;
  close(f.effectiveTaxRate(s), 0.22, 1e-12);
  close(f.fireTarget(s).total, 98400 / 0.78 / 0.04, 1e-6);
});

test('tax rate is blended by account mix', () => {
  const s = classic();
  s.accounts = { taxable: 500000, preTax: 500000, roth: 0, cash: 0 };
  s.retirement.ordinaryTaxRate = 0.22;
  s.retirement.ltcgRate = 0.15;
  s.retirement.taxableGainFraction = 0.5;
  close(f.effectiveTaxRate(s), (0.22 + 0.075) / 2, 1e-12);
});

test('Social Security and healthcare bridges', () => {
  const s = classic();
  s.profile.targetAge = 50;
  s.retirement.ssAnnual = 30000;
  s.retirement.ssStartAge = 67;
  s.retirement.healthcareAnnual = 18000;
  const t = f.fireTarget(s);
  close(t.core, (98400 - 30000) / 0.04, 1e-6);
  assert.equal(t.ssBridge, 30000 * 17);
  assert.equal(t.healthcareBridge, 18000 * 15);
  close(t.total, t.core + t.ssBridge + t.healthcareBridge, 1e-6);
});

test('coast number discounts the target', () => {
  close(f.coastNumber(1000000, 0.05, 10), 1000000 / Math.pow(1.05, 10), 1e-6);
});

test('milestone ladder is 20x / 25x / 32x', () => {
  assert.deepEqual(f.milestones(classic()), { lean: 98400 * 20, standard: 98400 * 25, fat: 98400 * 32 });
});

test('Monte Carlo is reproducible and sensible', () => {
  const s = f.sampleState();
  const a = f.monteCarlo(s, s.tiers.medium);
  const b = f.monteCarlo(s, s.tiers.medium);
  assert.deepEqual(a, b);
  assert.ok(a.successRate >= 0 && a.successRate <= 1);
  assert.ok(a.fireAgeP10 <= a.fireAgeP50 && a.fireAgeP50 <= a.fireAgeP90);
  const shocked = f.monteCarlo(s, s.tiers.medium, { shockFirstYear: -0.30 });
  assert.ok(shocked.successRate <= a.successRate);
});

test('Monte Carlo with zero volatility matches the deterministic year count', () => {
  const s = classic();
  const tier = { realReturn: 0.05, volatility: 0 };
  const mc = f.monteCarlo(s, tier, { sims: 10 });
  const months = f.monthsToTarget(f.investableAssets(s), f.fireTarget(s).total, 0.05, f.monthlySavings(s));
  // Yearly vs monthly compounding can differ by at most one year.
  assert.ok(Math.abs(mc.fireAgeP50 - (s.profile.age + months / 12)) <= 1);
});

test('stress tests never make the FIRE age earlier', () => {
  const s = f.sampleState();
  s.cashflow.includeBonus = true;
  for (const row of f.stressTests(s)) {
    if (row.delta !== null) assert.ok(row.delta >= 0, `${row.key} delta ${row.delta}`);
  }
});

test('withDefaults keeps saved values and fills missing ones', () => {
  const merged = f.withDefaults({ profile: { age: 50 }, log: [{ month: '2026-10' }] });
  assert.equal(merged.profile.age, 50);
  assert.equal(merged.profile.targetAge, 50);
  assert.equal(merged.log.length, 1);
  assert.ok(merged.tiers.high);
});

test('tier mixes add up to 100', () => {
  for (const k of f.TIER_KEYS) assert.equal(f.sum(Object.values(f.DEFAULT_TIERS[k].mix)), 100);
});

test('household adds members balances and flows, keeps its own assumptions', () => {
  const h = f.householdState();
  h.accounts.taxable = 100000;
  h.property.homeValue = 500000;
  h.cashflow.monthlyExpenses = 3000;
  h.cashflow.retirementSpend = 120000;
  const a = f.sampleState(); const b = f.sampleState();
  b.accounts.taxable = 50000; b.cashflow.retirementSpend = 1;
  const c = f.combineHousehold(h, [a, b]);
  assert.equal(c.accounts.taxable, 100000 + a.accounts.taxable + 50000);
  assert.equal(c.property.homeValue, 500000 + 2 * a.property.homeValue);
  assert.equal(c.cashflow.monthlyExpenses, 3000 + 2 * a.cashflow.monthlyExpenses);
  assert.equal(c.cashflow.retirementSpend, 120000);
  assert.equal(h.accounts.taxable, 100000, 'input is not mutated');
  h.household.combineMembers = false;
  assert.equal(f.combineHousehold(h, [a, b]).accounts.taxable, 100000);
});

test('holdings replace typed totals, allocation and company stock when switched on', () => {
  const s = f.sampleState();
  s.holdings.rows = [
    { account: 'taxable', name: 'VTI', assetClass: 'usStocks', shares: 100, price: 300, value: 0, basis: 20000 },
    { account: 'preTax', name: '401k target fund', assetClass: 'bonds', shares: 0, price: 0, value: 50000, basis: 0 },
    { account: 'company', name: 'IBM', assetClass: 'usStocks', shares: 10, price: 1000, value: 0, basis: 5000 },
  ];
  assert.equal(f.applyHoldings(s), s, 'off by default: typed totals win');
  s.holdings.use = true;
  const a = f.applyHoldings(s);
  assert.deepEqual(a.accounts, { taxable: 30000, preTax: 50000, roth: 0, cash: 0 });
  assert.equal(a.executive.vestedEquity, 10000);
  assert.equal(a.allocation.usStocks, 33.3);
  assert.equal(a.allocation.bonds, 55.6);
  assert.equal(a.allocation.satellite, 11.1, 'company stock counts as concentrated, not index');
  close(a.retirement.taxableGainFraction, (40000 - 25000) / 40000, 1e-12);
  assert.equal(s.accounts.taxable, 692000, 'input is not mutated');
});

test('gain share stays assumed unless every taxable lot has a basis', () => {
  const s = f.sampleState();
  s.holdings.use = true;
  s.holdings.rows = [
    { account: 'taxable', name: 'VTI', shares: 1, price: 100, basis: 50 },
    { account: 'taxable', name: 'VXUS', shares: 1, price: 100, basis: 0 },
  ];
  assert.equal(f.applyHoldings(s).retirement.taxableGainFraction, s.retirement.taxableGainFraction);
});

test('ticker guesses and value rules', () => {
  assert.equal(f.guessClass(' vxus '), 'intlStocks');
  assert.equal(f.guessClass('BND'), 'bonds');
  assert.equal(f.guessClass('NVDA'), null);
  assert.equal(f.holdingValue({ shares: 2, price: 10, value: 999 }), 20);
  assert.equal(f.holdingValue({ shares: 0, price: 10, value: 999 }), 999);
});
