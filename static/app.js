import {
  ASSET_CLASSES, HOLDING_ACCOUNTS, TIER_KEYS, applyHoldings, combineHousehold, fmtAge, fmtMoney, guessClass,
  holdingTotals, holdingValue, holdingsActive, householdState, monthlySavings, netWorth, newHolding, pct, sanitizeAges,
  planTier, projectBalances, sampleState, stressTests, summary, vestedAfterDrawdown, whatIf, withDefaults,
} from './finance.js';
import { SUCCESS_GOAL, adviceBrief, evaluateTiers, personalFlags } from './advice.js';
import { donut, lineChart, progressRing } from './charts.js';

const $ = (id) => document.getElementById(id);

const CLASS_COLORS = {
  usStocks: 'var(--sage)', intlStocks: 'var(--slate)', bonds: 'var(--gold)',
  realEstate: '#8a6d4b', cash: '#9a978c', satellite: '#b5603a',
};
const TIER_COLORS = { low: 'var(--tier-low)', medium: 'var(--tier-medium)', high: 'var(--tier-high)' };

// `state` is the dashboard being edited. `view` is what the numbers are computed from:
// the same thing, except on the household dashboard where members' saved numbers are added.
let state = sampleState();
let view = state;
let me = { user: '', users: [], dashboards: [], household: 'household', llm: false, model: '' };
let docs = {};
let current = '';
let period = 'monthly';
let sliders = null;

// ---- Field definitions ------------------------------------------------------
// kind: money | moneyPeriodic | age | fraction (stored 0–1, shown as %) | percent | text | check | select

const CASHFLOW_FIELDS = [
  { path: 'cashflow.monthlyTakeHome', label: 'Take-home pay', kind: 'moneyPeriodic' },
  { path: 'cashflow.monthlyExpenses', label: 'Living expenses', kind: 'moneyPeriodic' },
  { path: 'cashflow.retirementSpend', label: 'Retirement spend per year', kind: 'money',
    hint: 'Your chosen "enough" in today\'s dollars, after tax' },
  { path: 'cashflow.annualBonus', label: 'Annual bonus (after tax)', kind: 'money' },
  { path: 'cashflow.includeBonus', label: 'Count bonus in savings', kind: 'check',
    hint: 'Off by default: model FIRE on base pay' },
];

const INPUT_GROUPS = [
  {
    title: 'You & investments',
    fields: [
      { path: 'profile.age', label: 'Current age', kind: 'age' },
      { path: 'profile.targetAge', label: 'Target retirement age', kind: 'age', hint: "When you'd like to stop working; 65 if unsure" },
      { path: 'profile.planToAge', label: 'Plan to age', kind: 'age', hint: 'How long the money must last' },
      { path: 'accounts.taxable', label: 'Taxable brokerage', kind: 'money' },
      { path: 'accounts.preTax', label: 'Pre-tax retirement (401k, IRA)', kind: 'money' },
      { path: 'accounts.roth', label: 'Roth accounts', kind: 'money' },
      { path: 'accounts.cash', label: 'Cash', kind: 'money' },
    ],
  },
  {
    title: 'Property, debts & equity comp',
    fields: [
      { path: 'property.homeValue', label: 'Home value', kind: 'money', hint: 'Net worth only, never FIRE' },
      { path: 'property.mortgage', label: 'Mortgage balance', kind: 'money' },
      { path: 'property.otherAssets', label: 'Other assets', kind: 'money', hint: 'Rental property, business, etc.' },
      { path: 'property.otherAssetsCountForFire', label: 'Other assets fund retirement', kind: 'check' },
      { path: 'property.otherDebts', label: 'Other debts', kind: 'money' },
      { path: 'property.otherDebtRate', label: 'Other debt interest rate (%)', kind: 'percent' },
      { path: 'executive.ticker', label: 'Company stock name', kind: 'text' },
      { path: 'executive.vestedEquity', label: 'Vested company stock', kind: 'money' },
      { path: 'executive.unvestedEquity', label: 'Unvested equity', kind: 'money' },
      { path: 'executive.includeUnvested', label: 'Count unvested toward FIRE', kind: 'check' },
      { path: 'executive.deferredComp', label: 'Deferred compensation', kind: 'money' },
      { path: 'executive.includeDeferredComp', label: 'Count deferred comp toward FIRE', kind: 'check' },
      { path: 'executive.drawdownPct', label: 'Company stock drawdown', kind: 'range', min: 0, max: 70, step: 5 },
    ],
  },
  {
    title: 'Retirement assumptions',
    fields: [
      { path: 'plan.tier', label: 'Plan risk tier', kind: 'select',
        options: TIER_KEYS.map((k) => [k, k[0].toUpperCase() + k.slice(1)]) },
      { path: 'retirement.swr', label: 'Safe withdrawal rate', kind: 'fraction', step: 0.1,
        hint: '3.5% suits 40+ year retirements' },
      { path: 'retirement.ssAnnual', label: 'Social Security per year', kind: 'money', hint: 'Today\'s dollars, from ssa.gov' },
      { path: 'retirement.ssStartAge', label: 'Social Security start age', kind: 'age' },
      { path: 'retirement.healthcareAnnual', label: 'Healthcare before 65, per year', kind: 'money',
        hint: 'Premiums on top of retirement spend' },
      { path: 'retirement.ordinaryTaxRate', label: 'Tax rate on pre-tax withdrawals', kind: 'fraction', step: 1 },
      { path: 'retirement.ltcgRate', label: 'Capital gains tax rate', kind: 'fraction', step: 1 },
      { path: 'retirement.taxableGainFraction', label: 'Gain share of taxable sales', kind: 'fraction', step: 5 },
      { path: 'retirement.sabbaticalAge', label: 'Sabbatical stress-test age', kind: 'age' },
    ],
  },
];

const AGE_PATHS = new Set(['profile.age', 'profile.targetAge', 'profile.planToAge', 'retirement.ssStartAge']);
// Notes for ages just corrected, shown once on the next render of the form.
let ageNotice = {};
const get = (path, from = state) => path.split('.').reduce((o, k) => o?.[k], from);
// The dashboard as the math sees it before household totals: typed numbers, or holdings when switched on.
let applied = state;
function set(path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], state)[last] = value;
}

function fieldHtml(f) {
  const fromHoldings = applied._derived?.includes(f.path);
  const v = get(f.path, fromHoldings ? applied : state);
  const hint = f.hint ? `<span class="hint">${f.hint}</span>` : '';
  const id = `f-${f.path.replace('.', '-')}`;
  const label = `<label for="${id}">${f.label}${hint}</label>`;
  switch (f.kind) {
    case 'check':
      return `<div class="field check">${label}<input id="${id}" type="checkbox" data-path="${f.path}" data-kind="check" ${v ? 'checked' : ''}></div>`;
    case 'text':
      return `<div class="field">${label}<input id="${id}" type="text" data-path="${f.path}" data-kind="text" value="${escapeAttr(v)}"></div>`;
    case 'select':
      return `<div class="field">${label}<select id="${id}" data-path="${f.path}" data-kind="select">${
        f.options.map(([val, text]) => `<option value="${val}" ${val === v ? 'selected' : ''}>${text}</option>`).join('')}</select></div>`;
    case 'range':
      return `<div class="slider"><label for="${id}"><span>${f.label}</span><b id="${id}-out">${v}%</b></label>
        <input id="${id}" type="range" min="${f.min}" max="${f.max}" step="${f.step}" value="${v}" data-path="${f.path}" data-kind="range"></div>`;
    default: {
      const shown = f.kind === 'fraction' ? +(v * 100).toFixed(2)
        : f.kind === 'moneyPeriodic' && period === 'annual' ? v * 12 : v;
      const step = f.kind === 'fraction' ? f.step ?? 0.5 : f.kind === 'age' || f.kind === 'percent' ? 1 : 1000;
      const suffix = f.kind === 'moneyPeriodic' ? ` <span class="hint">${period === 'annual' ? 'per year' : 'per month'}</span>` : '';
      const fix = ageNotice[f.path] || applied._ageNotes?.[f.path];
      const note = fromHoldings ? '<span class="hint">From holdings</span>'
        : fix ? `<span class="hint fix-note">${escapeHtml(fix)}</span>` : '';
      const display = fromHoldings && f.kind === 'money' ? Math.round(shown) : shown;
      return `<div class="field"><label for="${id}">${f.label}${suffix}${hint}${note}</label>
        <input id="${id}" type="number" inputmode="decimal" step="${step}" min="0" value="${display}" data-path="${f.path}" data-kind="${f.kind}"${fromHoldings ? ' disabled' : ''}></div>`;
    }
  }
}

function escapeAttr(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function escapeHtml(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInputs() {
  applied = applyHoldings(sanitizeAges(state));
  $('cashflow-form').innerHTML = `<fieldset>${CASHFLOW_FIELDS.map(fieldHtml).join('')}</fieldset>
    <div class="metric" style="margin-top:12px"><span>Saved ${period === 'annual' ? 'per year' : 'per month'}</span><b id="saved-line"></b></div>`;
  $('inputs').innerHTML = INPUT_GROUPS.map((g) =>
    `<div class="card"><fieldset><legend>${g.title}</legend>${g.fields.map(fieldHtml).join('')}</fieldset></div>`).join('');
  document.querySelectorAll('#period-toggle button').forEach((b) => b.classList.toggle('on', b.dataset.period === period));
}

function onFieldInput(e) {
  const input = e.target.closest('[data-path]');
  if (!input) return;
  const { path, kind } = input.dataset;
  let value;
  if (kind === 'check') value = input.checked;
  else if (kind === 'text' || kind === 'select') value = input.value;
  else {
    const n = Number(input.value);
    if (!Number.isFinite(n)) return;
    value = kind === 'fraction' ? n / 100 : kind === 'moneyPeriodic' && period === 'annual' ? n / 12 : n;
    if (kind === 'range') $(`${input.id}-out`).textContent = `${n}%`;
  }
  set(path, value);
  state.isSample = false;
  if (path === 'plan.tier') sliders = null;
  // Ages are corrected when you leave the field, not while typing ("6" on the way to "67").
  if (e.type === 'change' && AGE_PATHS.has(path)) {
    const fixed = sanitizeAges(state);
    ageNotice = fixed._ageNotes || {};
    if (fixed !== state) {
      Object.assign(state.profile, { age: fixed.profile.age, targetAge: fixed.profile.targetAge, planToAge: fixed.profile.planToAge });
      state.retirement.ssStartAge = fixed.retirement.ssStartAge;
    }
    const focusedId = document.activeElement?.id;
    renderInputs();
    if (focusedId) $(focusedId)?.focus();
    ageNotice = {};
  }
  renderOutputs();
  scheduleSave();
}

// ---- Outputs ----------------------------------------------------------------

function members() {
  return me.users.map((u) => docs[u]).filter((d) => d && !d.isSample);
}

function renderOutputs() {
  applied = applyHoldings(sanitizeAges(state));
  view = current === me.household ? combineHousehold(applied, members().map((m) => applyHoldings(sanitizeAges(m)))) : applied;
  const m = summary(view);
  $('sample-banner').hidden = !state.isSample && !me.publicDemo;
  renderHouseholdNote();
  $('saved-line').textContent = fmtMoney(m.monthly * (period === 'annual' ? 12 : 1));
  renderKpis(m);
  renderLadder(m);
  renderMetrics(m);
  renderAllocation();
  renderProjection(m);
  renderWhatIf(m);
  renderStress();
  renderLog();
  renderAssumptions(m);
}

function renderKpis(m) {
  const sorted = [...view.log].sort((a, b) => a.month.localeCompare(b.month));
  const last = sorted.at(-1);
  let nwSub = 'Log a month to track change';
  if (last && last.netWorth) {
    const ch = (m.netWorth - last.netWorth) / Math.abs(last.netWorth);
    nwSub = `<span class="${ch >= 0 ? 'up' : 'down'}">${ch >= 0 ? '▲' : '▼'} ${pct(Math.abs(ch), 1)}</span> vs ${last.month}`;
  }
  const kpi = (label, value, sub) => `<div class="card kpi"><div class="label">${label}</div><div class="value num">${value}</div><div class="sub">${sub}</div></div>`;
  $('kpis').innerHTML = [
    kpi('Net worth', fmtMoney(m.netWorth), nwSub),
    kpi('FIRE target', fmtMoney(m.target.total), `Classic 25×: ${fmtMoney(m.milestones.standard)}`),
    `<div class="card kpi"><div class="label">Progress to FIRE</div><div class="progress" style="display:flex;gap:12px;align-items:center;margin-top:4px"><span id="ring"></span><div><div class="value num">${pct(m.progress)}</div><div class="sub">${fmtMoney(m.gap)} to go</div></div></div></div>`,
    kpi('Years to FIRE', m.yearsToFire === null ? '—' : m.yearsToFire.toFixed(1),
      m.fireAge === null ? 'Not reached by age ' + (view.profile.age + 60)
        // Reaching independence before the chosen age means the work after it is optional.
        : m.fireAge < view.profile.targetAge - 0.05
          ? `Free to stop at ${fmtAge(m.fireAge)} · working to ${view.profile.targetAge} by choice`
          : `At age ${fmtAge(m.fireAge)} (target ${view.profile.targetAge})`),
    kpi('Savings rate', pct(m.savingsRate), `${fmtMoney(m.monthly)} a month`),
  ].join('');
  $('ring').append(progressRing(m.progress));
}

function renderLadder(m) {
  const marks = [
    { v: m.milestones.lean, label: 'Lean 20×' },
    { v: m.milestones.standard, label: 'Standard 25×' },
    { v: m.milestones.fat, label: 'Fat 32×' },
  ];
  const max = Math.max(m.milestones.fat, m.target.total, m.investable) * 1.04;
  const at = (v) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  // Labels near either end are anchored inward so they stay inside the card.
  const edge = (v) => ((v / max) > 0.8 ? ' end' : (v / max) < 0.15 ? ' start' : '');
  const ticks = [0.1, 0.25, 0.5, 0.75, 0.9].map((p) =>
    `<div class="tick" style="left:${at(m.target.total * p)}"><span>${p * 100}%</span></div>`);
  const named = marks.map((k) =>
    `<div class="tick named${edge(k.v)}" style="left:${at(k.v)}" title="${fmtMoney(k.v)}"><span>${k.label}</span></div>`);
  $('ladder').style.marginBottom = '86px';
  $('ladder').innerHTML = `<div class="fill" style="width:${at(m.investable)}"></div>${ticks.join('')}${named.join('')}
    <div class="tick${edge(m.target.total)}" style="left:${at(m.target.total)};background:var(--gold);width:4px"><span style="top:58px;color:var(--gold);font-weight:700">Your target ${fmtMoney(m.target.total)}</span></div>
    <div class="you${edge(m.investable)}" style="left:${at(m.investable)}"><span>You are here · ${fmtMoney(m.investable)}</span></div>`;
  $('ladder-note').textContent = 'Lean, Standard and Fat are the classic multiples of retirement spend. Your target adds taxes, '
    + 'the Social Security bridge and healthcare before 65, so it is the number progress is measured against. '
    + 'Percent ticks are fractions of your target.';
}

function renderMetrics(m) {
  const row = (label, value, sub = '') => `<div class="metric"><span>${label}${sub ? `<span class="hint muted small"> · ${sub}</span>` : ''}</span><b>${value}</b></div>`;
  const there = (v) => pct(Math.min(1, m.investable / v));
  $('metrics').innerHTML = [
    row('Investable assets', fmtMoney(m.investable), 'excludes home equity'),
    row('Gap remaining', fmtMoney(m.gap)),
    row('Coast FIRE number', fmtMoney(m.coast), m.coastReached ? 'reached: you could stop saving' : `${fmtMoney(m.coast - m.investable)} away`),
    row('Lean FIRE (20×)', fmtMoney(m.milestones.lean), `${there(m.milestones.lean)} there`),
    row('Standard FIRE (25×)', fmtMoney(m.milestones.standard), `${there(m.milestones.standard)} there`),
    row('Fat FIRE (32×)', fmtMoney(m.milestones.fat), `${there(m.milestones.fat)} there`),
    row('Target: spend ÷ withdrawal rate', fmtMoney(m.target.core), `tax ${pct(m.target.taxRate, 1)} grossed up`),
    row('Target: Social Security bridge', fmtMoney(m.target.ssBridge), `${m.target.ssBridgeYears} years`),
    row('Target: healthcare bridge', fmtMoney(m.target.healthcareBridge), `${m.target.healthcareBridgeYears} years to 65`),
    row('Plan return (real)', pct(m.tier.realReturn, 1), m.tier.label),
  ].join('');
}

function renderAllocation() {
  const target = planTier(view).mix;
  const slices = (src) => ASSET_CLASSES.map((c) => ({ value: Number(src[c.key]) || 0, color: CLASS_COLORS[c.key], label: c.label }));
  $('donut').replaceChildren(donut([
    { radius: 80, width: 18, slices: slices(view.allocation) },
    { radius: 56, width: 14, slices: slices(target) },
  ]));
  const total = ASSET_CLASSES.reduce((a, c) => a + (Number(view.allocation[c.key]) || 0), 0);
  const rows = ASSET_CLASSES.map((c) => `<div class="alloc-row">
      <i class="legend box" style="background:${CLASS_COLORS[c.key]};width:12px;height:12px;border-radius:3px"></i>
      <label for="a-${c.key}">${c.label}</label>
      <input id="a-${c.key}" type="number" min="0" max="100" step="1" value="${view.allocation[c.key] ?? 0}" data-alloc="${c.key}"${holdingsActive(state) ? ' disabled' : ''}>
      <span class="tgt">${target[c.key]}%</span></div>`).join('');
  const existing = document.activeElement?.dataset?.alloc;
  if (existing) {
    $('alloc-total').textContent = `${total}%`;
    $('alloc-total').className = Math.abs(total - 100) > 0.5 ? 'down' : '';
    return;
  }
  $('alloc-table').innerHTML = `<div class="alloc-row muted small"><span></span><span>Class</span><span style="text-align:right">Current %</span><span style="text-align:right">Target</span></div>
    ${rows}<div class="alloc-row small"><span></span><span>Total</span><b id="alloc-total" class="${Math.abs(total - 100) > 0.5 ? 'down' : ''}" style="text-align:right">${total}%</b><span></span></div>`;
}

function onAllocInput(e) {
  const key = e.target.dataset.alloc;
  if (!key) return;
  const n = Number(e.target.value);
  if (!Number.isFinite(n)) return;
  state.allocation[key] = n;
  state.isSample = false;
  renderOutputs();
  scheduleSave();
}

function renderProjection(m) {
  const endAge = Math.max(60, view.profile.targetAge + 5);
  const years = endAge - view.profile.age;
  const series = TIER_KEYS.map((k) => ({
    label: `${view.tiers[k].label} (${pct(view.tiers[k].realReturn, 1)} real)`,
    color: TIER_COLORS[k],
    values: projectBalances(m.investable, view.tiers[k].realReturn, m.monthly, years),
    dash: k === view.plan.tier ? '' : '5 4',
  }));
  $('projection').replaceChildren(lineChart({ series, xStart: view.profile.age, target: m.target.total, formatY: fmtMoney }));
  $('projection-legend').innerHTML = series.map((s, i) =>
    `<span><i style="background:${s.color}"></i>${s.label}${TIER_KEYS[i] === view.plan.tier ? ' · your plan' : ''}</span>`).join('')
    + '<span class="muted">Keeps saving at today\'s rate; x-axis is age.</span>';
}

function renderWhatIf(m) {
  if (!sliders) {
    sliders = { monthly: Math.round(m.monthly / 100) * 100, retirementSpend: view.cashflow.retirementSpend,
      realReturn: m.tier.realReturn, swr: view.retirement.swr };
  }
  const defs = [
    { key: 'monthly', label: 'Monthly savings', min: 0, max: Math.max(20000, Math.ceil(m.monthly * 2 / 1000) * 1000), step: 100, fmt: fmtMoney },
    { key: 'retirementSpend', label: 'Retirement spend per year', min: 20000, max: Math.max(300000, view.cashflow.retirementSpend * 2), step: 1000, fmt: fmtMoney },
    { key: 'realReturn', label: 'Real return', min: 0, max: 0.10, step: 0.0025, fmt: (v) => pct(v, 2) },
    { key: 'swr', label: 'Safe withdrawal rate', min: 0.025, max: 0.05, step: 0.001, fmt: (v) => pct(v, 1) },
  ];
  const w = whatIf(view, sliders);
  const delta = w.fireAge !== null && m.fireAge !== null ? w.fireAge - m.fireAge : null;
  const focused = document.activeElement?.dataset?.whatif;
  if (!focused) {
    $('whatif').innerHTML = defs.map((d) => `<div class="slider" style="margin-bottom:10px">
        <label for="w-${d.key}"><span>${d.label}</span><b id="w-${d.key}-out">${d.fmt(sliders[d.key])}</b></label>
        <input id="w-${d.key}" type="range" min="${d.min}" max="${d.max}" step="${d.step}" value="${sliders[d.key]}" data-whatif="${d.key}"></div>`).join('')
      + '<div class="compare" id="whatif-compare"></div><div style="text-align:right;margin-top:8px"><button type="button" class="link" id="whatif-reset">Reset to my numbers</button></div>';
  } else {
    for (const d of defs) $(`w-${d.key}-out`).textContent = d.fmt(sliders[d.key]);
  }
  $('whatif-compare').innerHTML = `
    <div><span class="muted small">Today's plan</span><b>${fmtAge(m.fireAge)}</b><span class="muted small">FIRE age</span></div>
    <div><span class="muted small">What-if</span><b>${fmtAge(w.fireAge)}</b><span class="muted small">target ${fmtMoney(w.target)}</span></div>
    <div><span class="muted small">Change</span><b class="${delta !== null && delta > 0 ? 'down' : 'up'}">${delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)} yrs`}</b><span class="muted small">${w.yearsToFire === null ? '' : `${w.yearsToFire.toFixed(1)} years from now`}</span></div>`;
}

function onWhatIfInput(e) {
  const key = e.target.dataset.whatif;
  if (!key) return;
  sliders[key] = Number(e.target.value);
  renderWhatIf(summary(view));
}

function renderStress() {
  const rows = stressTests(view);
  $('stress').innerHTML = '<thead><tr><th>Scenario</th><th>FIRE age</th><th>Change</th></tr></thead><tbody>'
    + rows.map((r) => `<tr><td>${escapeHtml(r.label)}<div class="note muted small" style="white-space:normal">${escapeHtml(r.note)}</div></td>
        <td class="num">${r.key === 'crash' ? pct(r.successRate) : fmtAge(r.fireAge)}${r.key === 'crash' ? '<div class="muted small">lasts to ' + view.profile.planToAge + '</div>' : ''}</td>
        <td class="num ${r.delta > 0.05 || (r.key === 'crash' && r.successRate < SUCCESS_GOAL) ? 'down' : ''}">${
          r.key === 'crash' ? `${((r.successRate - r.baselineSuccessRate) * 100).toFixed(0)} pts`
            : r.delta === null ? '—' : r.delta < 0.05 ? 'none' : `+${r.delta.toFixed(1)} yrs`}</td></tr>`).join('')
    + '</tbody>';
}

// ---- Net worth log ----------------------------------------------------------

function snapshot(month) {
  const { accounts: a, property: p, executive: e } = view;
  return {
    month,
    taxable: a.taxable + vestedAfterDrawdown(view),
    retirement: a.preTax + a.roth + e.deferredComp,
    cash: a.cash,
    other: p.homeValue + p.otherAssets,
    liabilities: p.mortgage + p.otherDebts,
    netWorth: netWorth(view),
    contribution: monthlySavings(view),
  };
}

function renderLog() {
  const rows = [...view.log].sort((a, b) => a.month.localeCompare(b.month));
  if (!rows.length) {
    $('log').innerHTML = '<tbody><tr><td class="note">No months recorded yet. Pick a month and press Update month once a month.</td></tr></tbody>';
    return;
  }
  const body = rows.map((r, i) => {
    const prev = rows[i - 1];
    const growth = prev ? r.netWorth - prev.netWorth - r.contribution : null;
    return `<tr><td>${r.month}</td>${['taxable', 'retirement', 'cash', 'other', 'liabilities', 'netWorth', 'contribution']
      .map((k) => `<td class="num">${fmtMoney(r[k])}</td>`).join('')}
      <td class="num ${growth === null ? '' : growth >= 0 ? 'up' : 'down'}">${growth === null ? '—' : fmtMoney(growth)}</td>
      <td><button type="button" class="link" data-del="${r.month}" aria-label="Delete ${r.month}">✕</button></td></tr>`;
  }).reverse().join('');
  $('log').innerHTML = `<thead><tr><th>Month</th><th>Taxable</th><th>Retirement</th><th>Cash</th><th>Other assets</th>
    <th>Liabilities</th><th>Net worth</th><th>Saved</th><th>Market growth</th><th></th></tr></thead><tbody>${body}</tbody>`;
}

function updateMonth() {
  const month = $('log-month').value;
  if (!/^\d{4}-\d{2}$/.test(month)) return;
  state.log = state.log.filter((r) => r.month !== month).concat(snapshot(month));
  state.isSample = false;
  renderOutputs();
  scheduleSave();
}

// ---- Assumptions ------------------------------------------------------------

function renderAssumptions(m) {
  const r = view.retirement;
  $('assumptions').innerHTML = `<h2>Assumptions and formulas</h2>
    <p><b>Everything is in today's dollars.</b> Returns are real (after inflation), so no separate inflation rate is needed.</p>
    <p><b>Investable assets</b> = taxable + pre-tax + Roth + cash + vested company stock (after the drawdown slider) + deferred comp (if counted) + unvested (if counted) + other assets (if counted) − other debts. Home equity is in net worth but never in FIRE math because it does not pay for groceries.</p>
    <p><b>Blended tax rate</b> = pre-tax and deferred comp at ${pct(r.ordinaryTaxRate)} + taxable and company stock at ${pct(r.ltcgRate)} × ${pct(r.taxableGainFraction)} gain share + Roth and cash at 0%, weighted by balance. Today: <code>${pct(m.target.taxRate, 1)}</code>. A withdrawal of <code>spend ÷ (1 − tax)</code> leaves you the spend.</p>
    <p><b>FIRE target</b> = gross(spend − Social Security) ÷ ${pct(r.swr, 1)} + gross(Social Security) × years from FIRE age to ${r.ssStartAge} + gross(healthcare) × years from FIRE age to 65 = <code>${fmtMoney(m.target.core)} + ${fmtMoney(m.target.ssBridge)} + ${fmtMoney(m.target.healthcareBridge)} = ${fmtMoney(m.target.total)}</code>. The bridges are set aside without growth, which is conservative.</p>
    <p><b>Years to FIRE</b>: month by month, balance × (1 + return)<sup>1/12</sup> + monthly savings, until it reaches the target. Monthly savings = take-home − expenses${view.cashflow.includeBonus ? ' + bonus ÷ 12' : ''} = <code>${fmtMoney(m.monthly)}</code>.</p>
    <p><b>Coast FIRE</b> = target ÷ (1 + return)<sup>years to target age</sup>: if you have this today you could stop saving and still arrive on time.</p>
    <p><b>Lean / Standard / Fat</b> = retirement spend × 20 / 25 / 32, the classic ladder with no tax or bridges.</p>
    <p><b>Monte Carlo</b> (Advise panel and crash stress test): 2,000 paths of yearly returns drawn from a lognormal distribution with each tier's median real return and volatility. A path succeeds if money remains at age ${view.profile.planToAge} after retiring at ${view.profile.targetAge} and withdrawing the grossed-up spend (less Social Security from ${r.ssStartAge}, plus healthcare until 65). The seed is fixed, so results only change when your inputs do.</p>
    <p><b>Tier returns</b> (low ${pct(view.tiers.low.realReturn, 1)}, medium ${pct(view.tiers.medium.realReturn, 1)}, high ${pct(view.tiers.high.realReturn, 1)} real) are planning assumptions, not forecasts. Worst drawdowns are rough peak-to-trough losses of similar mixes in 2008–09.</p>
    <p class="disclaimer">Illustrative and educational, not financial, tax or legal advice. Bring these numbers to a licensed financial advisor and CPA before acting.</p>`;
}

// ---- Advice drawer ----------------------------------------------------------

function openAdvice() {
  $('advice').innerHTML = '<p class="muted">Running 6,000 simulations…</p>';
  $('overlay').classList.add('open');
  $('drawer').classList.add('open');
  $('drawer').setAttribute('aria-hidden', 'false');
  $('drawer-close').focus();
  setTimeout(renderAdvice, 20);
}

function closeAdvice() {
  $('overlay').classList.remove('open');
  $('drawer').classList.remove('open');
  $('drawer').setAttribute('aria-hidden', 'true');
  $('advise-btn').focus();
}

function renderAdvice() {
  const tiers = evaluateTiers(view);
  const flags = personalFlags(view, tiers);
  const rec = tiers.results[tiers.recommended];
  const headline = tiers.anyPassing
    ? `<b>${rec.tier.label}</b> is the lowest-risk tier that gives at least an ${pct(SUCCESS_GOAL)} chance of the money lasting to ${view.profile.planToAge} if you retire at ${view.profile.targetAge}.`
    : `<b>No tier reaches a ${pct(SUCCESS_GOAL)} chance</b> of lasting to ${view.profile.planToAge} with a FIRE age of ${view.profile.targetAge}. ${rec.tier.label} does best at ${pct(rec.mc.successRate)}. Retiring later, spending less or saving more will matter more than the investment mix.`;

  const card = (k) => {
    const r = tiers.results[k];
    const mix = ASSET_CLASSES.filter((c) => r.tier.mix[c.key] > 0)
      .map((c) => `<span style="width:${r.tier.mix[c.key]}%;background:${CLASS_COLORS[c.key]}" title="${c.label} ${r.tier.mix[c.key]}%"></span>`).join('');
    const mixText = ASSET_CLASSES.filter((c) => r.tier.mix[c.key] > 0).map((c) => `${c.label} ${r.tier.mix[c.key]}%`).join(' · ');
    return `<div class="card tier ${k}">
      <h3>${r.tier.label}</h3>
      <div class="badges">${k === tiers.recommended ? '<span class="badge rec">Recommended</span>' : ''}${k === view.plan.tier ? '<span class="badge cur">Your plan</span>' : ''}</div>
      <div class="muted small">${r.who}</div>
      <div class="mixbar">${mix}</div>
      <div class="muted small">${mixText}</div>
      <div class="stats">
        <div><span class="muted">Money lasts to ${view.profile.planToAge}</span><b>${pct(r.mc.successRate)}</b></div>
        <div><span class="muted">Median FIRE age</span><b>${r.mc.fireAgeP50 === Infinity ? '—' : r.mc.fireAgeP50}</b></div>
        <div><span class="muted">FIRE age range (10–90%)</span><b>${fmtRange(r.mc.fireAgeP10, r.mc.fireAgeP90)}</b></div>
        <div><span class="muted">Return / volatility</span><b>${pct(r.tier.realReturn, 1)} / ${pct(r.tier.volatility)}</b></div>
        <div><span class="muted">Worst drawdown</span><b>${pct(r.tier.worstDrawdown)}</b></div>
        <div><span class="muted">On ${view.profile.targetAge} target</span><b>${pct(r.mc.reachByTargetRate)}</b></div>
      </div>
      <ul>${r.points.map((p) => `<li>${p}</li>`).join('')}</ul>
      ${k === view.plan.tier ? '' : `<button type="button" data-use-tier="${k}">Use as my plan</button>`}
    </div>`;
  };

  const llm = me.llm
    ? `<div><button type="button" id="llm-btn">Explain with ${escapeHtml(me.model)}</button>
       <span class="muted small"> Sends only the rounded summary below to your local model.</span>
       <div id="llm-out" class="llm-out" hidden></div></div>`
    : '<p class="muted small">Optional: set OLLAMA_URL and OLLAMA_MODEL in .env to have your local model write a plain-English explanation of these results.</p>';

  $('advice').innerHTML = `
    <div class="card"><p style="margin:0">${headline}</p></div>
    <div class="grid-3">${TIER_KEYS.map(card).join('')}</div>
    <div><h2>Your situation</h2><div class="flags">${flags.map((f) =>
      `<div class="flag ${f.level}"><b>${escapeHtml(f.title)}</b>${escapeHtml(f.detail)}</div>`).join('')}</div></div>
    ${llm}
    <p class="disclaimer">Strategy-level guidance from fixed rules and your numbers. It does not pick funds or stocks and is not financial advice.
    Success rates come from simulations with assumed returns; real markets can do worse. Review with a licensed advisor before acting.</p>`;

  $('advice').querySelectorAll('[data-use-tier]').forEach((b) => b.addEventListener('click', () => {
    state.plan.tier = b.dataset.useTier;
    state.isSample = false;
    sliders = null;
    renderInputs();
    renderOutputs();
    scheduleSave();
    renderAdvice();
  }));
  $('llm-btn')?.addEventListener('click', () => explainWithLlm(adviceBrief(view, tiers, flags)));
}

function fmtRange(a, b) {
  const f = (x) => (x === Infinity ? `${view.profile.planToAge}+` : x);
  return `${f(a)}–${f(b)}`;
}

async function explainWithLlm(brief) {
  const out = $('llm-out');
  const btn = $('llm-btn');
  out.hidden = false;
  out.className = 'llm-out';
  out.textContent = 'Asking your local model…';
  btn.disabled = true;
  try {
    const res = await fetch('/api/advise', {
      method: 'POST', headers: WRITE_HEADERS, body: JSON.stringify({ brief }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    out.textContent = body.text;
  } catch (err) {
    out.className = 'llm-out error';
    out.textContent = `Explanation failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ---- Holdings ---------------------------------------------------------------

function renderHoldings() {
  const h = state.holdings;
  $('holdings-use').checked = h.use;
  const rows = h.rows;
  if (!rows.length) {
    $('holdings').innerHTML = '<tbody><tr><td class="note">No holdings yet. Add one row per fund, stock or cash balance; '
      + 'add another row for each new purchase lot if you want its cost basis tracked.</td></tr></tbody>';
  } else {
    const accountOpts = (sel) => HOLDING_ACCOUNTS.map((a) => `<option value="${a.key}" ${a.key === sel ? 'selected' : ''}>${a.label}</option>`).join('');
    const classOpts = (sel) => ASSET_CLASSES.map((c) => `<option value="${c.key}" ${c.key === sel ? 'selected' : ''}>${c.label}</option>`).join('');
    const num = (i, field, v, step = 'any') =>
      `<input type="number" inputmode="decimal" min="0" step="${step}" value="${v || ''}" data-row="${i}" data-field="${field}" aria-label="${field}">`;
    $('holdings').innerHTML = `<thead><tr><th>Account</th><th>Name / ticker</th><th>Asset class</th><th>Shares</th><th>Price</th>
      <th>Value</th><th>Cost basis</th><th>Gain</th><th></th></tr></thead><tbody>${rows.map((r, i) => {
        const computed = Number(r.shares) > 0 && Number(r.price) > 0;
        return `<tr>
          <td><select data-row="${i}" data-field="account" aria-label="Account">${accountOpts(r.account)}</select></td>
          <td><input type="text" value="${escapeAttr(r.name)}" data-row="${i}" data-field="name" aria-label="Name or ticker" placeholder="VTI"></td>
          <td><select data-row="${i}" data-field="assetClass" aria-label="Asset class" ${r.account === 'company' ? 'disabled' : ''}>${classOpts(r.account === 'company' ? 'satellite' : r.assetClass)}</select></td>
          <td>${num(i, 'shares', r.shares)}</td>
          <td>${num(i, 'price', r.price)}</td>
          <td>${computed ? `<span class="num" id="hv-${i}">${fmtMoney(holdingValue(r))}</span>` : num(i, 'value', r.value, 100)}</td>
          <td>${num(i, 'basis', r.basis, 100)}</td>
          <td class="num" id="hg-${i}">${gainText(r)}</td>
          <td><button type="button" class="link" data-del-row="${i}" aria-label="Remove row">✕</button></td></tr>`;
      }).join('')}</tbody>`;
  }
  renderHoldingTotals();
}

function gainText(r) {
  if (!(Number(r.basis) > 0)) return '—';
  const g = holdingValue(r) - Number(r.basis);
  return `<span class="${g >= 0 ? 'up' : 'down'}">${fmtMoney(g)}</span>`;
}

function renderHoldingTotals() {
  const { byAccount, total } = holdingTotals(state.holdings.rows);
  $('holdings-totals').innerHTML = state.holdings.rows.length
    ? `${HOLDING_ACCOUNTS.filter((a) => byAccount[a.key]).map((a) => `${a.label} <b>${fmtMoney(byAccount[a.key])}</b>`).join(' · ')}`
      + ` · Total <b>${fmtMoney(total)}</b>${state.holdings.use ? '' : ' <span class="muted">(not used: switch on to replace the typed totals)</span>'}`
    : '';
}

function holdingsChanged() {
  state.isSample = false;
  renderInputs();
  renderOutputs();
  scheduleSave();
}

function onHoldingInput(e) {
  const el = e.target;
  const i = Number(el.dataset.row);
  const field = el.dataset.field;
  if (!field || !state.holdings.rows[i]) return;
  const row = state.holdings.rows[i];
  if (el.tagName === 'SELECT' || field === 'name') {
    row[field] = el.value;
    if (field === 'name') {
      const guess = guessClass(el.value);
      if (guess && row.account !== 'company' && row.account !== 'cash') {
        row.assetClass = guess;
        const sel = el.closest('tr').querySelector('[data-field="assetClass"]');
        if (sel) sel.value = guess;
      }
    }
    if (field === 'account' && el.value === 'cash') row.assetClass = 'cash';
  } else {
    const n = Number(el.value);
    if (!Number.isFinite(n) || n < 0) return;
    row[field] = n;
  }
  // Switching between shares x price and a typed value changes the row's cells.
  const computedBefore = $(`hv-${i}`) !== null;
  const computedNow = Number(row.shares) > 0 && Number(row.price) > 0;
  if (el.tagName === 'SELECT' || computedBefore !== computedNow) {
    if (el.tagName === 'SELECT') renderHoldings();
    else if (e.type === 'change') renderHoldings();
  }
  if ($(`hv-${i}`)) $(`hv-${i}`).textContent = fmtMoney(holdingValue(row));
  if ($(`hg-${i}`)) $(`hg-${i}`).innerHTML = gainText(row);
  renderHoldingTotals();
  holdingsChanged();
}

// ---- Persistence ------------------------------------------------------------

const WRITE_HEADERS = { 'Content-Type': 'application/json', 'X-PFD': '1' };
let saveTimer = null;
function scheduleSave() {
  setStatus('Unsaved changes…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 600);
}

async function save({ reset = false } = {}) {
  try {
    const res = await fetch(`/api/dashboards/${current}`, {
      method: 'PUT', headers: reset ? { ...WRITE_HEADERS, 'X-PFD-Reset': '1' } : WRITE_HEADERS, body: JSON.stringify(state),
    });
    if (res.status === 401) { location.href = '/'; return; }
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    state._meta = body._meta;
    setStatus(`Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  } catch (err) {
    setStatus(`Save failed: ${err.message}`, true);
  }
}

function setStatus(text, error = false) {
  $('save-status').textContent = text;
  $('save-status').classList.toggle('error', error);
}

// First click arms the button, second click within 4 seconds resets this dashboard.
let resetArmed = null;
async function resetDashboard() {
  const button = $('reset-btn');
  if (!resetArmed) {
    button.textContent = 'Click again to reset';
    button.classList.add('armed');
    resetArmed = setTimeout(disarmReset, 4000);
    return;
  }
  disarmReset();
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const meta = state._meta;
  state = current === me.household ? householdState() : sampleState();
  state._meta = meta;
  docs[current] = state;
  sliders = null;
  renderInputs();
  renderHoldings();
  renderOutputs();
  if (me.publicDemo || meta) {
    await save({ reset: true });
    if (!me.publicDemo) setStatus(`Reset to ${current === me.household ? 'empty' : 'sample'}; previous numbers kept in backups`);
  }
}

function disarmReset() {
  clearTimeout(resetArmed);
  resetArmed = null;
  $('reset-btn').textContent = 'Reset to sample';
  $('reset-btn').classList.remove('armed');
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `financial-dashboard-${current}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data?.version !== 1) throw new Error('not a dashboard export (version 1)');
    // Keep this dashboard's save version so the import is not refused as a conflict.
    const meta = state._meta;
    state = withDefaults(data);
    state._meta = meta;
    state.isSample = false;
    docs[current] = state;
    sliders = null;
    renderInputs();
    renderHoldings();
    renderOutputs();
    await save();
  } catch (err) {
    setStatus(`Import failed: ${err.message}`, true);
  }
}

async function load() {
  try {
    const meRes = await fetch('/api/me');
    if (meRes.status === 401) { location.href = '/'; return; }
    if (!meRes.ok) throw new Error(`HTTP ${meRes.status}`);
    me = await meRes.json();
    const dashRes = await fetch('/api/dashboards');
    if (!dashRes.ok) throw new Error(`HTTP ${dashRes.status}`);
    docs = Object.fromEntries(Object.entries(await dashRes.json()).map(([id, d]) => [id, d && withDefaults(d)]));
  } catch (err) {
    setStatus(`Could not load: ${err.message}`, true);
    return;
  }
  $('who').textContent = displayName(me.user);
  if (me.version) $('version').textContent = `Personal Financial Dashboard version ${me.version} · build ${me.commit} · deployed ${me.built}`;
  if (me.demo) $('who').textContent = 'Demo mode';
  if (me.publicDemo) {
    const repo = me.repoUrl ? ` <a href="${escapeAttr(me.repoUrl.replace(/\.git$/, ''))}" rel="noopener">Run your own private copy</a>.` : '';
    $('sample-banner').innerHTML = '<b>Public demo.</b> Play with the sample numbers freely: your changes are private to this visit '
      + `and are thrown away when you sign out or after 2 idle hours. Please do not enter real numbers.${repo}`;
  }
  $('log-month').value = new Date().toISOString().slice(0, 7);
  let saved = '';
  try { saved = localStorage.getItem('pfd-dashboard') || ''; } catch { /* storage blocked */ }
  await openDashboard(me.dashboards.includes(saved) ? saved : me.user);
  if (location.hash === '#advise') openAdvice();
}

function displayName(id) {
  return id === me.household ? 'Household' : id.charAt(0).toUpperCase() + id.slice(1);
}

async function openDashboard(id) {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; await save(); }
  current = id;
  try { localStorage.setItem('pfd-dashboard', id); } catch { /* storage blocked */ }
  if (!docs[id]) docs[id] = id === me.household ? householdState() : sampleState();
  state = docs[id];
  sliders = null;
  $('tabs').innerHTML = me.dashboards.length > 1 ? me.dashboards.map((d) =>
    `<button type="button" data-tab="${d}" class="${d === id ? 'on' : ''}">${displayName(d)}</button>`).join('') : '';
  const meta = state._meta;
  setStatus(meta ? `Last saved by ${displayName(meta.updatedBy)}, ${meta.updatedAt}` : 'Not saved yet');
  renderInputs();
  renderHoldings();
  renderOutputs();
}

function renderHouseholdNote() {
  const note = $('household-note');
  if (current !== me.household) { note.hidden = true; return; }
  const included = me.users.filter((u) => docs[u] && !docs[u].isSample).map(displayName);
  const missing = me.users.filter((u) => !docs[u] || docs[u].isSample).map(displayName);
  note.hidden = false;
  note.innerHTML = `<label style="display:flex;gap:8px;align-items:center;font-weight:600">
      <input type="checkbox" id="combine" ${state.household.combineMembers ? 'checked' : ''}> Add each person's saved numbers</label>
    <div class="small">${state.household.combineMembers
      ? `${included.length ? `Totals include ${included.join(' and ')}.` : 'No one has saved a personal dashboard yet.'}`
        + `${missing.length ? ` ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not included until they save their own.` : ''}`
        + ' Enter only joint accounts, the house and shared expenses here. Ages, retirement spend and assumptions are the household\'s own.'
      : 'Showing only the numbers entered on this dashboard.'}</div>`;
}

async function signOut() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; await save(); }
  await fetch('/api/logout', { method: 'POST', headers: WRITE_HEADERS }).catch(() => {});
  location.href = '/';
}

// ---- Wiring -----------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  $('cashflow-form').addEventListener('input', onFieldInput);
  $('inputs').addEventListener('input', onFieldInput);
  $('inputs').addEventListener('change', onFieldInput);
  $('cashflow-form').addEventListener('change', onFieldInput);
  $('alloc-table').addEventListener('input', onAllocInput);
  $('alloc-table').addEventListener('focusout', () => setTimeout(renderAllocation, 0));
  $('whatif').addEventListener('input', onWhatIfInput);
  $('whatif').addEventListener('click', (e) => {
    if (e.target.id === 'whatif-reset') { sliders = null; document.activeElement?.blur(); renderWhatIf(summary(state)); }
  });
  $('whatif').addEventListener('focusout', () => setTimeout(() => renderWhatIf(summary(state)), 0));
  $('period-toggle').addEventListener('click', (e) => {
    const p = e.target.dataset.period;
    if (!p || p === period) return;
    period = p;
    renderInputs();
    renderOutputs();
  });
  $('log-update').addEventListener('click', updateMonth);
  $('log').addEventListener('click', (e) => {
    const month = e.target.dataset.del;
    if (!month) return;
    state.log = state.log.filter((r) => r.month !== month);
    renderOutputs();
    scheduleSave();
  });
  $('export-btn').addEventListener('click', exportJson);
  $('reset-btn').addEventListener('click', resetDashboard);
  $('import-btn').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', (e) => {
    if (e.target.files[0]) importJson(e.target.files[0]);
    e.target.value = '';
  });
  $('advise-btn').addEventListener('click', openAdvice);
  $('drawer-close').addEventListener('click', closeAdvice);
  $('tabs').addEventListener('click', (e) => {
    const id = e.target.dataset.tab;
    if (id && id !== current) openDashboard(id);
  });
  $('household-note').addEventListener('change', (e) => {
    if (e.target.id !== 'combine') return;
    state.household.combineMembers = e.target.checked;
    renderOutputs();
    scheduleSave();
  });
  $('signout-btn').addEventListener('click', signOut);
  $('holdings').addEventListener('input', onHoldingInput);
  $('holdings').addEventListener('change', onHoldingInput);
  $('holdings').addEventListener('click', (e) => {
    const i = e.target.dataset.delRow;
    if (i === undefined) return;
    state.holdings.rows.splice(Number(i), 1);
    renderHoldings();
    holdingsChanged();
  });
  $('holding-add').addEventListener('click', () => {
    state.holdings.rows.push(newHolding());
    if (state.holdings.rows.length === 1) state.holdings.use = true;
    renderHoldings();
    holdingsChanged();
    $('holdings').querySelector('tbody tr:last-child [data-field="name"]')?.focus();
  });
  $('holdings-use').addEventListener('change', (e) => {
    state.holdings.use = e.target.checked;
    renderHoldingTotals();
    holdingsChanged();
  });
  $('overlay').addEventListener('click', closeAdvice);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('drawer').classList.contains('open')) closeAdvice();
  });
  load();
});
