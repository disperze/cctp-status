# CCTP V1 Status: Noble ⇄ Ethereum

A read-only status page showing the **live** CCTP V1 (Legacy) limits and route health for
**Noble → Ethereum** (primary) and **Ethereum → Noble** (secondary), with a transfer-size calculator, a history
chart of how limits change, and **daily USDC burned on Noble** per destination.

Runs entirely on GitHub: a static page on GitHub Pages plus a scheduled GitHub Action. No server, no domain.

> **Informational only. Limits are set by Circle and can change at any time. Always do a small test transfer first.**
>
> This tool never signs or sends transactions, holds no keys, and never touches user funds.

## Why

Circle is retiring CCTP V1, and Noble will not get CCTP V2:

| Date | Event |
|---|---|
| 2026-10-31 | V1 burn limits start decreasing (schedule not published) |
| 2026-12-01 | V1 contracts paused network-wide; Noble exits may be limited to destinations still accepting V1 |
| 2027-01-12 | Noble USDC contract and all Noble CCTP routes fully paused |
| 2027-01-13 | Circle manual redemption process opens (snapshot-based) |

Limits change without notice, so every number is read on-chain. Nothing is hardcoded.

## How it works

```
 visitor's browser ──(every 60 s)──► Noble LCD + Ethereum RPC      live checks, route status, calculator
        │
        └──(every 5 min)──► raw.githubusercontent.com/<owner>/<repo>/data/*.json
                                       ▲
 GitHub Action "Snapshot" ─(every ~15 min)─┘  reads all checks, syncs new Noble burns,
                                              force-pushes JSON to the `data` branch
 GitHub Action "Deploy page" ─(on push)──► GitHub Pages (static build of web/)
```

- **Live values come from the visitor's own browser**: it calls the public Noble LCD and Ethereum RPC endpoints
  directly (all defaults allow cross-origin requests). Users don't have to trust a server for the numbers.
- **History, trend and burns come from the Action**, which needs no server: it runs on GitHub's schedule and publishes
  static JSON to the `data` branch. That branch is kept as a single force-pushed commit, so the repo doesn't grow.
- **The published JSON doubles as a read-only API** for bots and scripts (see [Published data](#published-data)).

## Deploy on GitHub

1. Push this repo to GitHub. It should be **public**: free Pages, unlimited Action minutes, and `raw.githubusercontent.com`
   only serves public repos. A private repo would use ~3,000 Action minutes a month.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Actions → Snapshot → Run workflow** once. This creates the `data` branch and backfills `BURNS_BACKFILL_DAYS`
   (default 7) of burns. A large backfill finishes over the next few runs.
4. Push to `main`/`master` (or run **Deploy page** manually). The page is at `https://<owner>.github.io/<repo>/`.

Optional, under **Settings → Secrets and variables → Actions**:

| Name | Kind | Used by |
|---|---|---|
| `ETH_RPC_URLS`, `NOBLE_LCD_URLS` | Variable | Snapshot Action **and** the page build. Shipped to browsers, so public keyless URLs only. |
| `ETH_RPC_URLS`, `NOBLE_LCD_URLS` | Secret | Snapshot Action only (overrides the variable). Use this for keyed RPC URLs. |
| `SAFETY_MARGIN`, `ALLOWANCE_WARN_USDC`, `TREND_WINDOW_HOURS` | Variable | Both |
| `BURNS_BACKFILL_DAYS` | Variable | Snapshot Action |
| `OSMOSIS_LCD_URLS` | Variable | Page build only (calculator pool read). Public keyless URLs only. |
| `ALERT_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Secret | Alerts on limit changes and route flips |

Changing a Variable used by the page requires re-running **Deploy page**.

**GitHub Actions caveats**

- Scheduled runs are best-effort and are often started 5–15+ minutes late, sometimes more under load. History points
  are therefore roughly, not exactly, 15 minutes apart. The live status on the page is unaffected.
- GitHub disables scheduled workflows in public repos after 60 days without repository activity. The window to
  2027-01-12 is longer than that, so check the Actions tab in early January, or push any commit, to keep it alive.

## Local development

```bash
npm install
npm run verify      # read-only: checks every constant against mainnet, then runs all checks
npm run snapshot    # one Action run locally: writes ./data/{snapshots.jsonl,latest,history,burns}.json
npm run dev         # page at http://localhost:5173, serving ./data at /data
```

Node 20.19+ (Vite 8). `.env` is loaded automatically by the Node scripts; see [.env.example](.env.example).

| Script | What it does |
|---|---|
| `npm run dev` / `build` / `preview` | Vite dev server / static build into `dist/` / preview the build |
| `npm run snapshot` | One scheduled run: snapshot + burn sync + publish JSON into `DATA_DIR` |
| `npm run verify` | Read-only mainnet verification of all constants and checks |
| `npm test` | Unit tests, all against mocked LCD / JSON-RPC responses (no network) |
| `npm run typecheck` | `tsc --noEmit` over src, scripts, tests and web |
| `npm run api` | Optional self-hosted JSON API (Hono). Not needed for the GitHub setup. |

## What the page shows

- **Route status** per direction, computed in the browser from fresh reads:
  - `OPEN`: every check is ok and fresh.
  - `DEGRADED`: open, but the destination allowance is below `ALLOWANCE_WARN_USDC`, or the per-message limit is below
    the highest value in the last `TREND_WINDOW_HOURS` of published history (trending down).
  - `PAUSED`: a pause flag is set (A2, A3, A4, A7, A8, A10).
  - `BLOCKED`: anything else is blocking: limit 0, allowance 0, TokenMinter no longer a minter, or a remote domain not registered.
  - `UNKNOWN`: a check could not be read on any endpoint, or its value is older than 2× the poll interval.
    The page **never shows `OPEN` without fresh data for every check.**
  - Precedence: `PAUSED > BLOCKED > UNKNOWN > DEGRADED > OPEN`.
- **Max per transaction**: A1 (Noble → Eth) / B1 (Eth → Noble).
- **Max total right now**: the destination minter allowance, A5 / B2. This is an aggregate cap shared by everyone, not reserved for you.
- **Transfer calculator**: the goal is to **exit Noble USDC** before Circle deprecates it, into Circle-native USDC.
  For Noble → out it shows two exits, the recommended one first:
  1. **USDC.inj via Osmosis allUSDC pool 3497 and [Skip Go](https://go.skip.build)** (preferred). Noble → Osmosis →
     swap USDC.n → USDC.inj 1:1 → Injective, as one Skip Go transaction that doesn't use Noble CCTP V1 or its limits.
     Recommended when `amount ≤ floor(pool USDC.inj balance × SAFETY_MARGIN)`, the pool is active and USDC.n isn't
     corrupted. Liquidity check only: no Skip quote is requested.
  2. **Ethereum USDC via CCTP V1** (fallback): `safe_chunk = floor(limit × SAFETY_MARGIN)`,
     `messages = ceil(amount / safe_chunk)`, with every chunk and whether the amount fits the destination allowance.

  If the pool can't be read, its reading is stale, or it doesn't hold enough USDC.inj, CCTP V1 is recommended. When the
  pool holds some but not all of the amount, the page shows how much could still exit through it.
  Ethereum → Noble moves funds *into* Noble USDC, so it shows CCTP V1 only.
- **Countdowns** to the retirement dates above.
- **USDC burned on Noble per day**: stacked daily bars (Ethereum vs. other V1 destinations), today and 7-day totals,
  a per-destination table, and the 25 most recent burns.
- **Limit history**: per-message limits and destination allowances over time, "last changed at" with the delta, and a table view.
- **All checks**: every raw value with its status, age, the endpoint and block height that answered, and a link to verify it yourself.
- **IBC escrow tab**: Noble USDC locked in the ICS-20 escrow account of each top counterparty (dYdX, Osmosis, Neutron,
  Cosmos Hub, Injective, Terra), i.e. how much Noble USDC sits on each chain. Read only when the tab is opened (or the
  page is loaded with `#escrow`); see [IBC escrow](#ibc-escrow).

All amounts are 6-decimal base-unit integers handled as `bigint` end to end. Chart line positions use floats for
plotting only; tooltips, labels and tables show exact values.

## Data sources

Every value can be verified by hand. Click the "source" link next to any check in the UI, or use the links below.

### Ethereum mainnet (CCTP V1)

Addresses: [Circle docs: CCTP V1 EVM contracts](https://developers.circle.com/cctp/v1/evm-smart-contracts).
ABIs: [circlefin/evm-cctp-contracts `docs/abis/cctp`](https://github.com/circlefin/evm-cctp-contracts/tree/master/docs/abis/cctp)
and FiatToken ([circlefin/stablecoin-evm](https://github.com/circlefin/stablecoin-evm)).
A5–A10 and B1 are read in a single [Multicall3](https://www.multicall3.com/) call at one block number (shown in the UI).

| # | Check | Contract | Call | Blocked if |
|---|---|---|---|---|
| A5 | Minter allowance for TokenMinter | [USDC `0xA0b8…eB48`](https://etherscan.io/address/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48#readProxyContract) | `minterAllowance(0xc4922d64a24675E16e1586e3e3Aa56C06fABe907)` | `0` (warn below threshold or below your amount) |
| A6 | TokenMinter is a minter | USDC | `isMinter(0xc4922d64a24675E16e1586e3e3Aa56C06fABe907)` | `false` |
| A7 | MessageTransmitter paused | [MessageTransmitter `0x0a99…8F81`](https://etherscan.io/address/0x0a992d191DEeC32aFe36203Ad87D7d289a738F81#readContract) | `paused()` | `true` |
| A8 | TokenMinter paused | [TokenMinter `0xc492…e907`](https://etherscan.io/address/0xc4922d64a24675E16e1586e3e3Aa56C06fABe907#readContract) | `paused()` | `true` |
| A9 | Noble registered on Ethereum | [TokenMessenger `0xBd3f…3155`](https://etherscan.io/address/0xBd3fa81B58Ba92a82136038B25aDec7066af3155#readContract) | `remoteTokenMessengers(4)` | `0x0` |
| A10 | USDC paused | USDC | `paused()` | `true` |
| B1 | Ethereum per-message burn limit | TokenMinter | `burnLimitsPerMessage(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48)` | `0` |

### Noble

REST paths are taken from the `google.api.http` annotations in
[noble-cctp `proto/circle/cctp/v1/query.proto`](https://github.com/circlefin/noble-cctp/blob/master/proto/circle/cctp/v1/query.proto) and
[noble-fiattokenfactory `proto/circle/fiattokenfactory/v1/query.proto`](https://github.com/circlefin/noble-fiattokenfactory/blob/master/proto/circle/fiattokenfactory/v1/query.proto).
Try any of them against a public LCD, e.g. `https://noble-api.polkachu.com<path>`.

| # | Check | REST path | Response | Blocked if |
|---|---|---|---|---|
| A1 | Per-message burn limit (`uusdc`) | `GET /circle/cctp/v1/per_message_burn_limits` (single: `/circle/cctp/v1/per_message_burn_limits/{denom}`) | `{"burn_limits":[{"denom":"uusdc","amount":"500000000000"}]}` | `0` or missing |
| A2 | Burning & minting paused | `GET /circle/cctp/v1/burning_and_minting_paused` | `{"paused":{"paused":false}}` | `true` |
| A3 | Sending & receiving paused | `GET /circle/cctp/v1/sending_and_receiving_messages_paused` | `{"paused":{"paused":false}}` | `true` |
| A4 | Noble USDC paused | `GET /noble/fiattokenfactory/paused` | `{"paused":{"paused":false}}` | `true` |
| A11 | Ethereum registered on Noble | `GET /circle/cctp/v1/remote_token_messengers` (domain 0) | base64 bytes32 of the Ethereum TokenMessenger | missing / zero (warn if it differs from config) |
| B2 | Minter allowance for the CCTP module | `GET /cosmos/auth/v1beta1/module_accounts/cctp` → address, then `GET /noble/fiattokenfactory/minters/{address}` | `{"minters":{"allowance":{"denom":"uusdc","amount":"…"}}}` | `0` or not a minter (gRPC NotFound) |
| C | Recent burns to Ethereum | `GET /cosmos/tx/v1beta1/txs?query=circle.cctp.v1.DepositForBurn.destination_domain=0&order_by=ORDER_BY_DESC` | typed event [`circle.cctp.v1.DepositForBurn`](https://github.com/circlefin/noble-cctp/blob/master/proto/circle/cctp/v1/events.proto) | n/a (context only) |

The CCTP module address is discovered at runtime, not hardcoded. On 2026-11-06 it was `noble12l2w4ugfz4m6dd73yysz477jszqnfughxvkss5`.

### Osmosis allUSDC pool 3497 (calculator only)

Read live by the browser from the [transmuter](https://github.com/osmosis-labs/transmuter) contract
`osmo147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0` via CosmWasm smart queries
(`GET /cosmwasm/wasm/v1/contract/{contract}/smart/{base64(msg)}`). All three come from the same endpoint:

| Query | Used for |
|---|---|
| `{"get_total_pool_liquidity":{}}` | USDC.inj balance = the most one exit swap can take |
| `{"is_active":{}}` | `false` → swaps disabled, route unavailable |
| `{"get_corrupted_denoms":{}}` | A corrupted USDC.n can't be swapped in |

| Member | Denom on Osmosis | Origin |
|---|---|---|
| USDC.n | `ibc/498A0751…6BA6E4` | Noble `uusdc`, `transfer/channel-750` |
| USDC.inj | `ibc/794C7D7F…476138` | Circle-native USDC on Injective `erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a`, `transfer/channel-122` |
| axlUSDC | `ibc/D189335C…F1D858` | Axelar (not used; near-empty on 2026-11-06) |

`npm run verify` checks the pool → contract mapping, the `allUSDC` subdenom, both denom traces, and that every
member's `normalization_factor` is 1 (1:1 swaps). `lcd.osmosis.zone` is not a default: it answers 403 to smart queries.

### Which checks apply to which route

| Route | Checks | Why |
|---|---|---|
| Noble → Ethereum | A1–A4, A11 (burn on Noble), A5–A10 (mint on Ethereum) | |
| Ethereum → Noble | B1, A7–A10 (burn on Ethereum), B2, A2–A4, A11 (mint on Noble) | `MessageTransmitter.sendMessage` and `TokenMinter.burn` are `whenNotPaused`; `depositForBurn` needs `remoteTokenMessengers(4)`; USDC must be unpaused to `transferFrom`. |

The task spec listed only A2, A3, A4, A7 as shared. A8, A9, A10 and A11 were added to Eth → Noble because the
contracts gate burns on them (see `whenNotPaused` in
[TokenMinter.sol](https://github.com/circlefin/evm-cctp-contracts/blob/master/src/TokenMinter.sol)).

### Verified constants

`npm run verify` confirms, read-only on mainnet:

- `TokenMessenger.localMinter() == TokenMinter`, `TokenMessenger.localMessageTransmitter() == MessageTransmitter`, `TokenMinter.localTokenMessenger() == TokenMessenger`
- `MessageTransmitter.localDomain() == 0`, Noble `GET /circle/cctp/v1/local_domain == 4`
- Noble's remote token messenger for domain 0 == Ethereum TokenMessenger
- Ethereum `remoteTokenMessengers(4)` == the Noble `cctp` module account (bech32-decoded)
- all four Ethereum addresses have deployed bytecode

## Burn tracking

Each Action run calls

```
GET /cosmos/tx/v1beta1/txs?query=circle.cctp.v1.DepositForBurn.destination_domain EXISTS AND tx.height>{cursor}
    &order_by=ORDER_BY_ASC&page={n}&limit=50
```

and adds every `DepositForBurn` event to `burns.json`, bucketed by UTC day and destination domain.

- **Incremental and idempotent**: `cursor_height` is the highest block whose burns are all counted, so a rerun never
  double counts. If a run stops at `BURNS_MAX_PAGES` mid-block, that block is dropped and re-read next run.
- **Backfill**: the first run starts `BURNS_BACKFILL_DAYS` back, estimated from the measured block time. The first day
  is partial, as is "today", and the page labels both. `caught_up: false` means a backfill is still in progress.
  Public nodes only keep a limited tx index, so very old burns may be unavailable.
- Failed txs (`code != 0`) are ignored. All V1 destinations are counted (Ethereum, Avalanche, OP, Arbitrum, Solana,
  Base, Polygon PoS, …), because on 2026-11-06 only ~20% of Noble burns went to Ethereum.
- Burn txs are heavy (relayer light-client headers, ~70 KB each), so the sync is capped per run and uses a 60 s timeout.
- A burn-sync failure never blocks the status snapshot. The previous `burns.json` is kept and retried next run.

## IBC escrow

An ICS-20 channel and its escrow address never change, so both are fixed in `ESCROW_CHAINS` (`src/escrow.ts`):
the `transfer` ↔ `transfer` channel tagged `preferred` in the
[Cosmos chain registry](https://github.com/cosmos/chain-registry/tree/master/_IBC) (`_IBC/dydx-noble.json`,
`noble-osmosis.json`, …), and its escrow address as ibc-go `GetEscrowAddress` derives it:
`bech32("noble", sha256("ics20-1" ‖ 0x00 ‖ "transfer/<channel>")[:20])`. Neither the page nor the Action fetches the
registry; `npm run verify` re-checks every entry against the registry and Noble mainnet.

When the tab is opened, the browser reads every balance from one Noble LCD (same block), plus `total_escrow` for uusdc
and the uusdc supply for context:

```
GET /cosmos/bank/v1beta1/balances/{escrow}/by_denom?denom=uusdc
GET /ibc/apps/transfer/v1/denoms/uusdc/total_escrow
GET /cosmos/bank/v1beta1/supply/by_denom?denom=uusdc
```

| Chain | Noble channel | Chain channel | Escrow address |
|---|---|---|---|
| dYdX | channel-33 | channel-0 | `noble1ukv0qhw3zszzyjty32cck2j229ekpmr6g806yp` |
| Osmosis | channel-1 | channel-750 | `noble1kq2rzz6fq2q7fsu75a9g7cpzjeanmk68qxshr6` |
| Neutron | channel-18 | channel-30 | `noble1gw2v3j8jxpmnq73rmu3vjz5egle5eep4xvvjtu` |
| Cosmos Hub | channel-4 | channel-536 | `noble17sael2kcmm8npe2pmkxj3un90xfg60vvuk39mn` |
| Injective | channel-31 | channel-148 | `noble1vn26uz7pxhz5aqd4s4q8kuar84ev9emhhgxuc2` |
| Terra | channel-30 | channel-253 | `noble12vssh8spx53qzg532xpj22sa7e85ts4x76e5rm` |

Verified 2026-11-07 against the registry and `GET /ibc/apps/transfer/v1/channels/{channel}/ports/transfer/escrow_address`.

**Daily snapshots and 24h / 7d change.** The scheduled Action records one escrow reading per UTC day into
`escrow.json` (the first run after 00:00 UTC; later runs that day skip the reads, and a day missing a chain is retried).
The page compares the live balance with the daily snapshot nearest to 24 h / 7 d ago. The baseline must be at least
half the window old and on the same channel, and its timestamp is shown on hover. Changes appear once a few days have
been recorded. An escrow read failure never blocks the status snapshot.

Escrow counts USDC that left Noble over that channel. USDC forwarded from that chain to a third chain stays in the first
chain's escrow.

## Published data

Served from the `data` branch, e.g. `https://raw.githubusercontent.com/<owner>/<repo>/data/latest.json`
(CORS open, cached ~5 min by GitHub).

| File | Contents |
|---|---|
| `latest.json` | The last full status snapshot from the Action: all 13 checks in the shape below, both routes, config, dates |
| `history.json` | Compact snapshots for the last `HISTORY_PUBLISH_DAYS` (default 30): A1, B1, A5, B2 + route states |
| `burns.json` | `days[YYYY-MM-DD][domain] = {count, amount_raw}`, `recent[]` (25 newest), `cursor_height`, `tracking_since`, `caught_up` |
| `escrow.json` | One reading per UTC day (`days[]`, last 400): uusdc per chain escrow, the Noble channel used, `total_escrow_raw`, `supply_raw` |
| `snapshots.jsonl` | Full snapshot history, one JSON object per line (the Action's source of truth) |

Each check has this shape:

```jsonc
{
  "id": "A1",
  "label": "Noble per-message burn limit (uusdc)",
  "raw": "500000000000",           // string; bigints as decimal strings, bools as "true"/"false"
  "value_usdc": "500000",          // only for amounts; exact decimal string
  "status": "ok",                  // ok | warn | blocked | error
  "source": "Noble x/cctp PerMessageBurnLimits",
  "source_url": "https://noble-api.polkachu.com/circle/cctp/v1/per_message_burn_limits?pagination.limit=1000",
  "endpoint": "https://noble-api.polkachu.com",
  "block": "63353333",
  "fetched_at": "2026-11-06T22:00:26.442Z",
  "stale": false,
  "detail": "…",                   // explanation for non-ok
  "last_good": { … }               // on error: the last successful reading
}
```

### Optional self-hosted API

`npm run api` still runs the original Hono server (`/api/status`, `/api/history`, `/api/calc`, `/api/activity`) with
its own 15-min scheduler, for anyone who prefers a server. The GitHub setup doesn't use it, and it can be deleted
(`src/server.ts`, `src/index.ts`, and the `hono` / `@hono/node-server` dependencies).

## Configuration

See [.env.example](.env.example).

| Variable | Default | |
|---|---|---|
| `ETH_RPC_URLS` | publicnode, drpc, 1rpc | Comma-separated, tried in order |
| `NOBLE_LCD_URLS` | polkachu, api.noble.xyz, cosmos.directory | Comma-separated, tried in order |
| `OSMOSIS_LCD_URLS` | polkachu, publicnode, cosmos.directory | Pool 3497 liquidity for the calculator; must allow CosmWasm smart queries |
| `SAFETY_MARGIN` | `0.998` | Exact decimal in (0, 1] |
| `ALLOWANCE_WARN_USDC` | `5000000` | Allowance below this → DEGRADED |
| `TREND_WINDOW_HOURS` | `24` | Window for the "limit trending down" rule |
| `REQUEST_TIMEOUT_MS` | `8000` | Per endpoint (burn queries use at least 60 s) |
| `DATA_DIR` | `data` | Where the Action writes the JSON |
| `HISTORY_PUBLISH_DAYS` | `30` | Days in `history.json` |
| `BURNS_BACKFILL_DAYS` | `7` | First-run burn backfill |
| `BURNS_MAX_PAGES` | `20` | Tx pages (50 each) per run |
| `ALERT_WEBHOOK_URL` | — | Discord/Slack-compatible webhook on limit changes or route flips |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | — | Telegram alerts |
| `VITE_DATA_URL` | `data` (dev: served from `DATA_DIR`) | Where the page loads JSON; set by the Pages workflow |
| `VITE_ETH_RPC_URLS`, `VITE_NOBLE_LCD_URLS`, `VITE_OSMOSIS_LCD_URLS`, `VITE_POLL_SEC` | defaults above, `60` | Browser-side endpoints and poll interval |

## Resilience

- Every Noble check and the Ethereum multicall fail over across all configured endpoints, with a per-endpoint timeout.
  A malformed response is treated like a failed endpoint. If every endpoint fails the check is `error`, never `ok`.
- A gRPC `NotFound` from the minters query is treated as a real answer ("not a minter"), not an endpoint failure.
- In the browser, errors carry forward the last good value (`last_good`) so it is still shown, clearly marked.
- Staleness is re-checked when rendering, so a tab that slept or lost network never keeps showing `OPEN`.
- If the published JSON can't be loaded, the live status still works. Only history, trend and burns are missing.
- Endpoint URLs are redacted (credentials, query strings, key-like path segments) before they appear in JSON or the UI.
- Alerts fire on per-message limit changes, route state flips, and check status changes. Allowances move with every
  transfer, so they alert only when they cross the warning threshold.

## Project layout

```
src/                 shared TypeScript (runs in Node and in the browser unless noted)
  config.ts          constants (verified) + env config
  units.ts           bigint USDC parsing/formatting
  failover.ts        endpoint failover + URL redaction
  noble.ts           LCD checks A1–A4, A11, B2 + DepositForBurn parsing
  ethereum.ts        viem multicall checks A5–A10, B1
  aggregate.ts       route status rules
  status.ts          status composition (shared by Action and browser)
  calc.ts            transfer calculator (CCTP chunking)
  osmosis.ts         Osmosis allUSDC pool 3497 liquidity read
  routes.ts          calculator exits: USDC.inj via Osmosis (preferred) vs CCTP V1
  history.ts         chart series, last-changed/delta, change detection
  burns.ts           incremental daily burn sync
  escrow.ts          IBC escrow: fixed channels + escrow addresses, balances, daily history
  storage.ts         JSONL / SQLite snapshot store          (Node)
  publish.ts         writes latest/history/burns/escrow JSON (Node)
  service.ts         snapshot + carry-forward + alerts      (Node)
  alerts.ts          webhook / Telegram                     (Node)
  server.ts, index.ts  optional self-hosted API             (Node)
web/                 static page (Vite): index.html, main.ts, styles.css
scripts/             snapshot-once.ts (the Action), verify-mainnet.ts
.github/workflows/   snapshot.yml (every 15 min), pages.yml (deploy on push)
test/                vitest suites with mocked LCD + JSON-RPC
```

## Disclaimer

Informational only. Limits are set by Circle and can change at any time. Always do a small test transfer first.
Not affiliated with Circle or Noble.
