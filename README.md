# Personal Financial Dashboard

A private FIRE (financial independence) dashboard with a risk-tiered investment
advisor. It runs in one Podman container on this machine, bound to `127.0.0.1`.
No logins, no analytics, no external scripts or fonts. Your numbers stay in a
Podman volume.

Based on the build described in Nadia Hansen's article "How Much Is Enough?"
(LinkedIn, 2026-10-25), with these corrections and additions:

| Article version | This dashboard |
|---|---|
| Home equity counts toward FIRE | Home equity is in net worth only; FIRE uses investable assets |
| FIRE number = spend × 25 | Target = tax-grossed spend ÷ withdrawal rate + Social Security bridge + healthcare-to-65 bridge. The 20×/25×/32× ladder is still shown |
| 4% default | 3.5% default (40+ year retirements); editable |
| Fixed 3/5/7% projections | Plus Monte Carlo: chance the money lasts to your plan age, FIRE-age range |
| No advice | **Advise** button: low / medium / high risk tiers simulated on your numbers, a rule-based recommendation, and personal flags |

The article's sample numbers do not add up: its inputs sum to $1.84M (it prints $1.82M), and
$1.82M reaching $2.46M at 5% real with $11,300/month takes about 3 years, not 7.8.
`tests/finance.test.mjs` checks both.

## Run

```bash
./run.sh            # builds the image, (re)starts the container
open http://127.0.0.1:8095
```

`run.sh` creates `.env` from `.env.example` on first run (mode 600, gitignored).

| Setting | Meaning |
|---|---|
| `PFD_PORT` | Host port (default 8095) |
| `OLLAMA_URL`, `OLLAMA_MODEL` | Optional local model that explains the advice in plain English. Blank = off |
| `OLLAMA_TIMEOUT` | Seconds to wait for the model (default 180) |

Bookmark `http://127.0.0.1:8095/#advise` to open straight into the advice panel.

## Your data

- Saved automatically to `/data/state.json` in the `pfd-data` volume. Rebuilding or
  removing the container keeps it.
- One backup per day in `/data/backups/`, last 60 kept.
- **Export JSON** / **Import JSON** in the header for your own encrypted copy.
- The server never logs request bodies.

Restore a backup:

```bash
podman exec personal_financial_dashboard ls /data/backups
podman exec personal_financial_dashboard cp /data/backups/state-2026-11-02.json /data/state.json
```

## What the Advise button does

1. Runs 2,000 simulated market paths for each tier (low 3.0%, medium 4.5%, high 5.5%
   median real return; 7/11/16% volatility). Seeded, so results only change when inputs do.
2. Recommends the lowest-risk tier with at least an 85% chance the money lasts to your
   plan age if you retire at your target age.
3. Flags your situation from fixed rules: company-stock concentration, cash months,
   allocation drift, penalty-free money to 59½, savings rate, deferred comp, debt rate,
   sequence risk.
4. Optionally sends a rounded summary (no names or account details) to your local
   Ollama model for a written explanation. The model explains; it never calculates.

Strategy level only: it does not pick funds or tickers. Not financial advice.

## Formulas

Every formula is shown in plain English at the bottom of the page with your
live numbers. The code is in `static/finance.js` (math) and `static/advice.js` (rules).

## Tests

```bash
node --test tests/*.test.mjs
```

## Layout

```
server.py            stdlib HTTP server: static files, /api/state, /api/advise
static/finance.js    all calculations (pure, tested)
static/advice.js     tier strategies, recommendation, personal flags
static/app.js        UI
static/charts.js     inline SVG charts
Containerfile, run.sh
```

## Roadmap

- **Phase 2: account sync (read-only).** E*TRADE Accounts API (OAuth 1.0a; consumer
  key/secret in `.env`, daily browser approval) and/or SimpleFIN Bridge for other
  institutions. Only GET endpoints for balances and positions; account numbers never stored.
