// Rule-based investment advice. Every number here comes from finance.js, so it
// can be checked by hand. An LLM (optional) only explains these results in prose.
import {
  ASSET_CLASSES, PENALTY_FREE_AGE, TIER_KEYS, fireTarget, fmtMoney, investableAssets,
  monteCarlo, monthsToTarget, pct, planTier, summary, vestedAfterDrawdown,
} from './finance.js';

export const SUCCESS_GOAL = 0.85;

export const TIER_STRATEGIES = {
  low: {
    who: 'Close to your FIRE date, or you would sell in a crash.',
    points: [
      'Core: low-cost total-market index funds, US and international (expense ratio under 0.10%).',
      'Bucket strategy: 2–3 years of spending in cash or short Treasuries, 5–7 years in intermediate bonds and TIPS, the rest in stocks.',
      'Build a TIPS or Treasury ladder that covers the years until Social Security starts.',
      'Rebalance once a year or when any asset class drifts more than 5 points.',
      'No individual stocks or sector bets.',
    ],
  },
  medium: {
    who: '5–15 years to FIRE and you can hold through a 35% drop.',
    points: [
      'Core: total US market plus about 30% of stocks in international index funds.',
      'Bond tent: raise bonds toward about 40% in the 5 years around your FIRE date, then let stocks drift back up. This is the main defence against a crash right after you retire.',
      'Satellite sleeve of up to 5% for individual stocks, with written rules for buying and selling.',
      'Asset location: bonds in pre-tax accounts, stocks in Roth and taxable. Harvest tax losses in taxable.',
      'Rebalance with 5-point bands. Send new contributions to whatever is underweight.',
    ],
  },
  high: {
    who: '15+ years to FIRE, steady income, and a proven record of not selling in crashes.',
    points: [
      'Equity-heavy index core with tilts toward small-cap value and international/emerging markets.',
      'Satellite sleeve of up to 10% for individual stocks and sector ETFs. Cap each position at 2% of the portfolio and write down your sell rules in advance.',
      'Keep 12 months of spending in cash outside the portfolio, so a crash never forces a sale.',
      'Expect a 50% drop at some point. Decide in writing now what you will do when it happens.',
      'No leverage, margin or options on the core. If FIRE is under 5 years away, add a bond tent anyway.',
    ],
  },
};

// Simulates each tier and recommends the lowest-risk one that meets the success goal.
export function evaluateTiers(s) {
  const results = {};
  for (const key of TIER_KEYS) {
    const tier = s.tiers[key];
    const months = monthsToTarget(investableAssets(s), fireTarget(s).total, tier.realReturn, summary(s).monthly);
    results[key] = {
      key, tier, ...TIER_STRATEGIES[key],
      mc: monteCarlo(s, tier),
      fireAge: months === null ? null : s.profile.age + months / 12,
    };
  }
  const passing = TIER_KEYS.filter((k) => results[k].mc.successRate >= SUCCESS_GOAL);
  const recommended = passing[0]
    ?? TIER_KEYS.reduce((best, k) => (results[k].mc.successRate > results[best].mc.successRate ? k : best));
  return { results, recommended, anyPassing: passing.length > 0 };
}

// Personal flags. Levels: high, warn, info, ok.
export function personalFlags(s, tiers) {
  const out = [];
  const m = summary(s);
  const inv = m.investable;
  const add = (level, title, detail) => out.push({ level, title, detail });

  const company = vestedAfterDrawdown(s);
  const share = inv > 0 ? company / inv : 0;
  if (share > 0.10) {
    const halved = monthsToTarget(inv - company / 2, m.target.total, m.tier.realReturn, m.monthly);
    const delay = halved !== null && m.yearsToFire !== null ? halved / 12 - m.yearsToFire : null;
    add(share > 0.20 ? 'high' : 'warn',
      `${s.executive.ticker || 'Company stock'} is ${pct(share)} of investable assets`,
      `A 50% drop would cost ${fmtMoney(company / 2)}${delay !== null ? ` and push FIRE back about ${delay.toFixed(1)} years` : ''}. `
      + 'Consider a staged sell plan, such as equal tranches over 4–8 quarters inside your trading windows or a 10b5-1 plan, '
      + 'selling high-cost-basis lots first. Your income already depends on this company.');
  }

  const cashMonths = s.cashflow.monthlyExpenses > 0 ? s.accounts.cash / s.cashflow.monthlyExpenses : 0;
  if (cashMonths < 6) {
    add('warn', `Cash covers ${cashMonths.toFixed(1)} months of expenses`,
      'Build 6 months of expenses in cash before taking more market risk.');
  } else if (cashMonths > 24) {
    const excess = s.accounts.cash - 24 * s.cashflow.monthlyExpenses;
    add('info', `Cash covers ${cashMonths.toFixed(0)} months of expenses`,
      `About ${fmtMoney(excess)} above a 24-month reserve. At your plan's return assumption it gives up roughly `
      + `${fmtMoney(excess * m.tier.realReturn)} a year in real growth. Keep it if it is earmarked for something.`);
  } else {
    add('ok', `Cash covers ${cashMonths.toFixed(0)} months of expenses`, 'Within the 6–24 month range.');
  }

  const target = planTier(s).mix;
  const drift = ASSET_CLASSES
    .map((c) => ({ ...c, cur: s.allocation[c.key] ?? 0, tgt: target[c.key] ?? 0 }))
    .filter((c) => Math.abs(c.cur - c.tgt) > 5);
  if (drift.length) {
    add('warn', `Allocation is off target in ${drift.length} ${drift.length === 1 ? 'class' : 'classes'}`,
      drift.map((c) => `${c.label} ${c.cur}% vs ${c.tgt}% target`).join('; ')
      + '. Fix it with new contributions first, then rebalance inside tax-advantaged accounts to avoid capital gains.');
  } else {
    add('ok', 'Allocation is within 5 points of target', `Matches the ${m.tier.label.toLowerCase()} mix.`);
  }

  const allocSum = Object.values(s.allocation).reduce((a, b) => a + (Number(b) || 0), 0);
  if (Math.abs(allocSum - 100) > 0.5) {
    add('warn', `Current allocation adds up to ${allocSum}%`, 'Fix the percentages so they total 100%.');
  }

  const yearsLeft = s.profile.targetAge - s.profile.age;
  if (s.plan.tier === 'high' && yearsLeft <= 5) {
    add('high', 'High risk with FIRE 5 years or less away',
      'Sequence risk is highest in the years just before and after you stop working. Consider a bond tent or moving to medium risk.');
  }

  if (s.profile.targetAge < PENALTY_FREE_AGE) {
    const bridgeYears = PENALTY_FREE_AGE - s.profile.targetAge;
    const accessible = s.accounts.taxable + s.accounts.cash + vestedAfterDrawdown(s);
    const needed = m.target.grossSpend * bridgeYears;
    if (accessible < needed) {
      add('warn', `Not enough penalty-free money to reach 59½`,
        `${fmtMoney(accessible)} in taxable and cash against roughly ${fmtMoney(needed)} of spending over `
        + `${bridgeYears.toFixed(1)} years. Options: a Roth conversion ladder (start 5 years ahead), `
        + 'the Rule of 55 if you leave your employer in or after the year you turn 55, or 72(t) SEPP payments. '
        + 'Roth contributions (not earnings) can also be withdrawn any time.');
    } else {
      add('ok', 'Taxable and cash accounts can carry you to 59½',
        `${fmtMoney(accessible)} available against about ${fmtMoney(needed)} needed.`);
    }
  }

  const sr = m.savingsRate;
  if (sr < 0.20) add('warn', `Savings rate is ${pct(sr)}`, 'Below 20%, expenses matter more than investment choice.');
  else if (sr >= 0.50) add('ok', `Savings rate is ${pct(sr)}`, 'Above 50%. This does more for your FIRE date than any allocation change.');

  if (s.executive.deferredComp > 0 && inv > 0 && s.executive.deferredComp / inv > 0.15) {
    add('warn', `Deferred comp is ${pct(s.executive.deferredComp / inv)} of investable assets`,
      'It is an unsecured promise from your employer. Prefer shorter distribution elections and avoid deferring more.');
  }

  if (s.executive.unvestedEquity > 0 && !s.executive.includeUnvested) {
    add('info', `${fmtMoney(s.executive.unvestedEquity)} unvested equity is left out`,
      'Treat it as upside. It enters the plan when it vests.');
  }

  if (s.property.otherDebts > 0 && s.property.otherDebtRate > 6) {
    add('high', `Debt at ${s.property.otherDebtRate}% interest`,
      `Paying off ${fmtMoney(s.property.otherDebts)} is a guaranteed ${s.property.otherDebtRate}% return, better than any tier's expected return.`);
  }

  const plan = tiers.results[s.plan.tier];
  if (plan && plan.mc.successRate < SUCCESS_GOAL) {
    add('high', `Plan success is ${pct(plan.mc.successRate)} on ${plan.tier.label.toLowerCase()}`,
      `Below the ${pct(SUCCESS_GOAL)} goal. The levers that matter most: retire later, spend less in retirement, or save more now.`);
  }

  const order = { high: 0, warn: 1, info: 2, ok: 3 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

// Rounded facts for the optional LLM explanation. No names or account details.
export function adviceBrief(s, tiers, flags) {
  const m = summary(s);
  const lines = [
    `Age ${s.profile.age}, target FIRE age ${s.profile.targetAge}, plan to age ${s.profile.planToAge}.`,
    `Investable ${fmtMoney(m.investable)}, FIRE target ${fmtMoney(m.target.total)}, progress ${pct(m.progress)}.`,
    `Saving ${fmtMoney(m.monthly)} a month (${pct(m.savingsRate)} savings rate). Retirement spend ${fmtMoney(s.cashflow.retirementSpend)} a year.`,
    `Current plan: ${m.tier.label}.`,
    ...TIER_KEYS.map((k) => {
      const r = tiers.results[k];
      return `${r.tier.label}: ${pct(r.tier.realReturn, 1)} real return, ${pct(r.tier.volatility)} volatility, `
        + `success ${pct(r.mc.successRate)}, median FIRE age ${r.mc.fireAgeP50}.`;
    }),
    `Recommended tier by rule: ${tiers.results[tiers.recommended].tier.label}.`,
    'Flags:',
    ...flags.map((f) => `- [${f.level}] ${f.title}. ${f.detail}`),
  ];
  return lines.join('\n');
}
