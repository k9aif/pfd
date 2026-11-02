// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as imp from '../static/importer.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const byName = (holdings, start) => holdings.find((h) => h.name.startsWith(start));

test('parseCsv handles quotes, doubled quotes, commas and CRLF', () => {
  const rows = imp.parseCsv('a,"b,c","say ""hi"""\r\n1,2,3\n');
  assert.deepEqual(rows, [['a', 'b,c', 'say "hi"'], ['1', '2', '3']]);
});

test('toNumber cleans brokerage formats', () => {
  assert.equal(imp.toNumber('$1,234.56'), 1234.56);
  assert.equal(imp.toNumber('($600.00)'), -600);
  assert.equal(imp.toNumber('+$4,895.00'), 4895);
  assert.equal(imp.toNumber('--'), null);
  assert.equal(imp.toNumber('N/A'), null);
  assert.equal(imp.toNumber(''), null);
});

test('E*TRADE style: preamble skipped, price paid becomes cost basis, cash kept, total skipped', () => {
  const r = imp.importPositions(fixture('etrade-style.csv'), { account: 'taxable', companyTicker: 'IBM' });
  assert.equal(r.holdings.length, 4);
  const vti = byName(r.holdings, 'VTI');
  assert.equal(vti.shares, 100);
  assert.equal(vti.price, 290);
  assert.equal(vti.basis, 24000);
  assert.equal(vti.assetClass, 'usStocks');
  assert.equal(byName(r.holdings, 'IBM').account, 'company');
  const cash = byName(r.holdings, 'CASH');
  assert.equal(cash.assetClass, 'cash');
  assert.equal(cash.value, 3825);
  assert.ok(r.skipped.some((s) => s.text === 'TOTAL'));
});

test('Fidelity style: account type per row, money market as cash, footer ignored', () => {
  const r = imp.importPositions(fixture('fidelity-style.csv'), { account: 'taxable' });
  assert.equal(r.holdings.length, 4);
  assert.equal(byName(r.holdings, 'SPAXX').assetClass, 'cash');
  assert.equal(byName(r.holdings, 'SPAXX').account, 'taxable');
  assert.equal(byName(r.holdings, 'FXAIX').basis, 18000);
  assert.equal(byName(r.holdings, 'VXUS').account, 'roth');
  assert.equal(byName(r.holdings, 'VXUS').assetClass, 'intlStocks');
  assert.equal(byName(r.holdings, 'BND').account, 'preTax');
  assert.equal(byName(r.holdings, 'BND').assetClass, 'bonds');
});

test('Schwab style: quoted file, cash line kept, account total skipped, unknown class flagged', () => {
  const r = imp.importPositions(fixture('schwab-style.csv'), { account: 'taxable' });
  assert.equal(r.holdings.length, 3);
  assert.equal(byName(r.holdings, 'SCHB').basis, 8000);
  assert.equal(byName(r.holdings, 'Cash').value, 7000);
  assert.equal(byName(r.holdings, 'Cash').assetClass, 'cash');
  assert.equal(byName(r.holdings, 'NVDA').unknownClass, true);
  assert.ok(r.skipped.some((s) => /Account Total/.test(s.text)));
});

test('Vanguard style: stops at the blank line before the transactions section', () => {
  const r = imp.importPositions(fixture('vanguard-style.csv'), { account: 'preTax' });
  assert.equal(r.holdings.length, 2);
  assert.equal(byName(r.holdings, 'VTSAX').shares, 500.123);
  assert.equal(byName(r.holdings, 'VMFXX').assetClass, 'cash');
});

test('a file without a positions table explains what it expected', () => {
  assert.throws(() => imp.importPositions('Date,Amount\n2026-10-01,5\n'), /Symbol or Description/);
});

test('accountFromName', () => {
  assert.equal(imp.accountFromName('ROTH IRA'), 'roth');
  assert.equal(imp.accountFromName('Rollover IRA'), 'preTax');
  assert.equal(imp.accountFromName('401(k) Plan'), 'preTax');
  assert.equal(imp.accountFromName('Joint WROS'), 'taxable');
  assert.equal(imp.accountFromName('My account'), null);
  assert.equal(imp.accountFromName('Individual'), 'taxable');
});

test('tickerOf finds the ticker a row can be priced by', () => {
  assert.equal(imp.tickerOf({ name: 'VTI · VANGUARD TOTAL STOCK MARKET ETF' }), 'VTI');
  assert.equal(imp.tickerOf({ name: 'vxus' }), 'VXUS');
  assert.equal(imp.tickerOf({ name: 'BRK.B' }), 'BRK.B');
  assert.equal(imp.tickerOf({ name: 'FXAIX · FIDELITY 500 INDEX FUND' }), 'FXAIX');
  assert.equal(imp.tickerOf({ name: '401(k) S&P 500 index' }), null);
  assert.equal(imp.tickerOf({ name: 'Company stock' }), null);
  assert.equal(imp.tickerOf({ name: 'High-yield savings' }), null);
  assert.equal(imp.tickerOf({ name: '' }), null);
});
