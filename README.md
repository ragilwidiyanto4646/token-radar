# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/ragilwidiyanto4646/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/ragilwidiyanto4646/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token launch radar: every protocol DefiLlama tracks that still records no token, ranked by what its launch would be worth, with a farm plan for each.

## Run it

```sh
node main.ts --out ./out
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=ztnjpsw2&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>

## Details

- Bounty: **Build the best token launch radar** — $1,325 in USDC
  (`token-radar-01`, https://make.fun/bounty/token-radar-01)
- Deadline: **2026-12-14 10:00 UTC** (Mon 14 Dec 2026, 17:00 WIB)
- Prizes: $1,000 / $50×4 / $25×5 (10 places, $1,325 total)
- Judging: an AI judge compares dashboards two at a time; entries rank by
  win rate. The winner is featured on make.fun.
- Runtime: Node.js 22.18+ (`node main.ts` runs TypeScript directly, no
  build step, no dependencies). The grader runs it with network disabled
  and the sealed snapshot mounted at `/input`, twice — both runs write
  the same bytes.

## How it works

`main.ts` reads the sealed snapshot (`/input/snapshot.json`: 758
protocols at or above $5M TVL, 40 on the watchlist), scores every
pre-token protocol, and writes `board.json`, `data.js`, `dashboard/`,
`screenshots/` and `dossier.json` to the output directory.

1. **Token check (the trap in this bounty).** A protocol counts as "no
   token" only if the snapshot records no `gecko_id`, no `cmcId` and no
   token symbol — and no variant of the same protocol records one
   either. In the raw DefiLlama feed many versioned entries carry the
   parent token's symbol with a null `gecko_id` (Aave V3 → `AAVE`,
   Uniswap V4 → `UNI`, LayerZero V2 → `ZRO`, Morpho Blue → `MORPHO`).
   A naive `gecko_id`-only filter would wrongly rank Aave, Uniswap and
   LayerZero as token-less. Variants group by base name (stripping
   `V2`/`V3`/`Bridge`/`Earn`/… suffixes) and the whole group is excluded
   if any variant records a token.
2. **The watchlist is the floor, never the ceiling.** The board covers
   the whole house watchlist (40 protocols) plus the pre-token protocols
   below the $50M floor the radar exists to find. Four names on the
   watchlist would fail the stricter screens — USDD (a stablecoin),
   Bittensor dTAO (a staked-asset product), Mezo Earn (an earn vault of
   a tokenised parent) and Saturn (a stablecoin wrapper) — but the gate
   requires full coverage, so they are ranked by the same model and
   flagged `onWatchlist` (★ in the table).
3. **Wrapped / staked products and custodial value excluded.** WBTC,
   Binance staked ETH, Coinbase Wrapped Staked ETH, stablecoins that
   already trade, CEXs and bridges / canonical bridges: their TVL is
   other people's assets or other chains' tokens, not protocol value a
   launch could capitalise on.
4. **Implied FDV.** Per category, the median `mcap / TVL` of tokenised
   peers in the same category (≥3 peers, clamped 0.05–5×; global median
   otherwise) × the candidate's TVL, capped at $100B. All multiples are
   computed from the snapshot itself, never hard-coded. Rows are ranked
   by implied value (rank 1 is the most valuable).
5. **Expected value = implied FDV × launch likelihood**, where
   likelihood is a category prior (prediction markets 0.85 … chains
   0.35) adjusted for multi-chain spread, audits and age.
6. **Score (0–100)** = 55 × log-normalised expected value + 30 ×
   likelihood + 15 × log-normalised TVL. Tiers: S = top 10, A ≥ 60,
   B ≥ 40, C below.
7. **Farm plans** are category playbooks (recurring real use, held
   positions, 30–90 days), written to `farm_steps` as 3–12 strings of
   20–600 characters each. They describe how to be a genuine user, not
   a guarantee — a protocol may never launch a token, or may launch
   without an airdrop. Not financial advice.

On the sealed snapshot (2026-11-14): 758 protocols → 416 already have
a token, 17 are wrapped / staked products, 93 are CEX/bridge entries,
1 duplicate variant merged, 40 watchlist slugs force-included →
**231 rows** (≥ the required 100). Top 5: Sentora Curator, Steakhouse
Financial, Gauntlet, Veda, USDD.

## Outputs

- `board.json` — `{rows: [...]}`: rank, slug, name, `implied_value_usd`,
  `farm_steps`, score, comparables and farm plan per row.
- `data.js` — `window.RADAR`, the dashboard's dataset beside `dashboard/`.
- `dashboard/` — `index.html` + `app.css` + `app.js`: a static page that
  renders with no network (no `http(s)` address in any dashboard file).
  Board, search / category / chain / tier filters, sorting, a detail
  view per protocol (`#slug` deep links), a live-token view, methodology.
- `screenshots/` — the 3 required screenshots (board, detail, filtered);
  see `screenshots/README.md` for how they are taken.
- `dossier.json` — byte-for-byte what `buildDossier` from the kit's
  `vendor/makefun-board.ts` writes from `dashboard/` + `screenshots/`.

## Layout

```
main.ts                    # the entrypoint (Node 22, root)
vendor/makefun-board.ts    # the kit's dossier library, byte for byte
dashboard/index.html       # dashboard shell (source)
dashboard/app.css          # dashboard styles
dashboard/app.js           # dashboard rendering (reads window.RADAR)
screenshots/README.md      # how to take the 3 required screenshots
```
