// Reads a brokerage positions CSV into holdings rows. Pure functions, no DOM, so node can
// test them. The file is parsed in the browser; only the resulting holdings are saved.
import { guessClass, newHolding } from './finance.js';

// RFC 4180-style parsing: quoted fields, doubled quotes, commas and newlines inside quotes.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.map((r) => r.map((f) => f.trim()));
}

// "$1,234.56" -> 1234.56, "(12.30)" -> -12.3, "--" / "n/a" / "" -> null
export function toNumber(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s || /^(-+|n\/?a|none|—)$/i.test(s)) return null;
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s);
  s = s.replace(/[()$,%\s+-]/g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// Column roles and the header names brokerages use for them (lowercased, punctuation removed).
const ROLE_NAMES = {
  symbol: ['symbol', 'ticker', 'symbolcusip', 'security symbol'],
  name: ['description', 'investment name', 'security description', 'name', 'security', 'security name'],
  shares: ['quantity', 'shares', 'qty', 'share quantity', 'units'],
  price: ['last price', 'price', 'share price', 'current price', 'last price usd', 'market price', 'closing price'],
  value: ['current value', 'market value', 'value', 'total value', 'marketvalue', 'mkt val market value', 'value usd'],
  basis: ['cost basis total', 'cost basis', 'total cost', 'cost basis usd', 'total cost basis'],
  unitCost: ['price paid', 'average cost basis', 'average cost', 'cost per share', 'avg cost', 'price paid usd', 'unit cost'],
  account: ['account name', 'account type', 'account', 'account description', 'account name number'],
};
export const ROLES = Object.keys(ROLE_NAMES);

const norm = (h) => String(h).toLowerCase().replace(/[$%*#()/:.]/g, ' ').replace(/\s+/g, ' ').trim();

export function guessMapping(header) {
  const names = header.map(norm);
  const mapping = {};
  for (const role of ROLES) {
    const wanted = ROLE_NAMES[role];
    let idx = names.findIndex((n) => wanted.includes(n));
    if (idx < 0) idx = names.findIndex((n) => wanted.some((w) => n.startsWith(w + ' ')));
    // "Account Number" is not a type; only use an account column that names the account.
    if (role === 'account' && idx >= 0 && /number|no$/.test(names[idx])) idx = -1;
    mapping[role] = idx;
  }
  // A "price" match must not be the change column ("price change").
  return mapping;
}

// The header is the first row with a symbol or name column and a shares or value column.
export function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const m = guessMapping(rows[i]);
    if ((m.symbol >= 0 || m.name >= 0) && (m.shares >= 0 || m.value >= 0)) return { index: i, mapping: m };
  }
  return null;
}

const SKIP_ROW = /^(account )?total\b|^grand total|^pending activity|^totals?$|^subtotal/i;
const CASH_ROW = /^(cash|cash & cash investments|cash and cash equivalents|money market|core position)\b/i;

// Account type from a free-text account name, or null to use the default.
export function accountFromName(text) {
  const s = String(text || '').toUpperCase();
  if (!s) return null;
  if (/ROTH/.test(s)) return 'roth';
  if (/\b(IRA|401\s?\(?K\)?|403\s?\(?B\)?|457|SEP|SIMPLE|ROLLOVER|TRADITIONAL|PENSION|TSP)\b/.test(s)) return 'preTax';
  if (/\b(BROKERAGE|INDIVIDUAL|JOINT|TAXABLE|TRUST|TOD)\b/.test(s)) return 'taxable';
  return null;
}

// rows: parsed CSV; header: index of the header row; mapping: role -> column index (-1 = none).
// Returns { holdings, skipped } where skipped lists rows left out and why.
export function toHoldings(rows, header, mapping, { account = 'taxable', companyTicker = '' } = {}) {
  const holdings = [];
  const skipped = [];
  const company = String(companyTicker || '').trim().toUpperCase();
  const cell = (r, role) => (mapping[role] >= 0 ? (r[mapping[role]] ?? '') : '');
  for (let i = header + 1; i < rows.length; i++) {
    const r = rows[i];
    // A blank line ends the positions block (some files add a second section after it).
    if (r.every((f) => f === '')) { if (holdings.length) break; else continue; }
    const symbol = cell(r, 'symbol').replace(/\*+$/, '').trim();
    const label = cell(r, 'name');
    const title = symbol || label;
    if (!title) continue;
    if (SKIP_ROW.test(title) || SKIP_ROW.test(label)) { skipped.push({ row: i + 1, text: title, why: 'total row' }); continue; }

    const shares = toNumber(cell(r, 'shares'));
    const price = toNumber(cell(r, 'price'));
    let value = toNumber(cell(r, 'value'));
    if (value === null && shares !== null && price !== null) value = shares * price;
    if (value === null || value === 0) { skipped.push({ row: i + 1, text: title, why: 'no value' }); continue; }
    let basis = toNumber(cell(r, 'basis'));
    const unitCost = toNumber(cell(r, 'unitCost'));
    if ((basis === null || basis === 0) && unitCost !== null && shares !== null) basis = unitCost * shares;

    const isCash = CASH_ROW.test(title) || CASH_ROW.test(label) || guessClass(symbol) === 'cash' || /^cash$/i.test(symbol);
    const rowAccount = company && symbol.toUpperCase() === company ? 'company'
      : accountFromName(cell(r, 'account')) ?? account;
    const h = newHolding(rowAccount);
    h.name = symbol && label && label.toUpperCase() !== symbol.toUpperCase() ? `${symbol} · ${label}` : title;
    h.assetClass = isCash ? 'cash' : (guessClass(symbol) ?? (rowAccount === 'cash' ? 'cash' : 'usStocks'));
    // Keep shares x price when both are present and agree with the value; otherwise keep the value.
    if (shares !== null && price !== null && shares > 0 && price > 0 && Math.abs(shares * price - value) <= Math.max(1, value * 0.02)) {
      h.shares = shares;
      h.price = price;
    } else {
      h.value = Math.round(value * 100) / 100;
    }
    h.basis = basis !== null && basis > 0 ? Math.round(basis * 100) / 100 : 0;
    h.unknownClass = !isCash && !guessClass(symbol);
    holdings.push(h);
  }
  return { holdings, skipped };
}

// One call for the UI: parse, find the header, map columns, convert.
export function importPositions(text, options = {}) {
  const rows = parseCsv(text);
  const found = findHeader(rows);
  if (!found) {
    throw new Error('No positions table found. Expected a header row with a Symbol or Description column '
      + 'and a Quantity or Value column.');
  }
  const mapping = { ...found.mapping, ...(options.mapping || {}) };
  return { rows, header: found.index, mapping, ...toHoldings(rows, found.index, mapping, options) };
}

// The ticker a holdings row can be priced by: the first word of its name, if it looks like one.
// "VTI · VANGUARD TOTAL..." or "vti" -> "VTI"; "401(k) S&P 500 index" or "Company stock" -> null
export function tickerOf(row) {
  const token = String(row.name || '').split(/[\s·]+/)[0].toUpperCase();
  return /^[A-Z][A-Z0-9]{0,5}([.-][A-Z])?$/.test(token) ? token : null;
}
