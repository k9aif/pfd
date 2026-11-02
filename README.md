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

Locally (Mac):

```bash
cp .env.example .env     # once; mode 600, gitignored
./run.sh                 # http://localhost:8118, data in ./data
./run.sh test            # calculation tests
```

In a Podman container (same script on the MacBook and on an Ubuntu host):

```bash
ubuntu/build-run.sh all       # git pull (if there is a remote) + build + start
ubuntu/build-run.sh logs | stop | backups
```

On macOS it uses the rootless Podman machine (starting it if needed) and no sudo. The container
binds to `127.0.0.1:8118` only: open http://localhost:8118. On a remote host, tunnel with
`ssh -L 8118:localhost:8118 <host>`. `PFD_BIND=0.0.0.0` in `.env` opens it to the LAN (there is no
login). Never put it behind the Cloudflare tunnel.

| Setting | Meaning |
|---|---|
| `PFD_PORT` | Port for `./run.sh` (default 8118) |
| `PFD_BIND` | Container bind address (default 127.0.0.1) |
| `OLLAMA_URL`, `OLLAMA_MODEL` | Optional local model that explains the advice in plain English. Blank = off |
| `OLLAMA_TIMEOUT` | Seconds to wait for the model (default 180) |

Bookmark `http://localhost:8118/app#advise` to open straight into the advice panel.

## People and sign-in

Up to three people, each with a login. Whoever holds `.env` is the admin.

With no one added yet it runs in **demo mode**: sign in with `demo` / `demo` to explore sample
numbers. Adding the first person turns demo login off.

```bash
./run.sh adduser ravi                 # or: ubuntu/build-run.sh adduser ravi (also restarts the container)
./run.sh passwd ravi                  # change a password
./run.sh removeuser ravi              # their dashboard file stays on disk
```

- `.env` stores a one-way scrypt hash per person (`PFD_USER_1..3`), never the password.
- Everyone who signs in sees and can edit every dashboard: one per person, plus **Household**
  when there are two or more people. Household holds joint accounts, the house and shared
  expenses, and adds each person's saved balances and income on top (a checkbox turns that off).
  Ages, retirement spend and assumptions are the household's own.
- Every save records who made it. If two people edit the same dashboard, the second save is
  refused with "Changed by X, reload" instead of overwriting.
- Sessions expire after 12 idle hours; five wrong passwords lock sign-in for a minute.
- The dashboard cannot see or move money. A login protects privacy, not accounts.
  Data files on disk are plain JSON (mode 600): FileVault protects them at rest.

## Holdings (optional)

Instead of typing account totals, add one row per fund, stock or cash balance: account
(taxable, pre-tax, Roth, cash, vested company stock), name or ticker, asset class, shares and
price (or just a value), and optional cost basis. With "Use holdings" on, the account totals,
company stock line and allocation percentages come from the rows, and a cost basis on every
taxable row replaces the assumed gain share. Common index funds get their asset class filled in.
As you invest, raise the shares or add a row per purchase; update prices monthly, then
**Update month** records the snapshot.

## Your data

- Saved automatically, one file per dashboard in `dashboards/`: `./data/` locally,
  `~/containers/volumes/personal-financial-dashboard/data/` for the container (mode 700).
  Rebuilding the container keeps it.
- One backup per dashboard per day in `backups/`, last 60 kept. Restore by copying one over its file in `dashboards/`.
- **Export JSON** / **Import JSON** in the header for your own encrypted copy.
- The server never logs request bodies. `/healthz` shows the deployed commit and build date.

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
./run.sh test       # node math tests + python server tests
```

## Layout

```
server.py            stdlib HTTP server: sign-in, dashboards, /api/advise; user CLI
static/finance.js    all calculations incl. holdings (pure, tested)
static/advice.js     tier strategies, recommendation, personal flags
static/landing.*     landing page and sign-in
static/app.js        dashboard UI
static/charts.js     inline SVG charts
run.sh               local run + tests
ubuntu/              Containerfile + build-run.sh for the Podman host
```

## Roadmap

- **Phase 2: account sync (read-only).** E*TRADE Accounts API (OAuth 1.0a; consumer
  key/secret in `.env`, daily browser approval) and/or SimpleFIN Bridge for other
  institutions. Only GET endpoints for balances and positions; account numbers never stored.
# pfd
