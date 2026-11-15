// main.ts — Token Launch Radar (make.fun bounty token-radar-01)
//
// Reads a sealed snapshot of every protocol DefiLlama tracks, finds the
// ones that still record no token and are not a wrapped / staked product of
// a protocol that already trades, ranks them by what their launch would be
// worth, and writes a static web dashboard for them.
//
// Run (Node.js >= 22.18, no dependencies, no build step):
//   node main.ts                                  # sealed snapshot if found, else live fetch -> ./out
//   node main.ts --input <file|dir> --out <dir>  # sealed snapshot -> <dir>
//   MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
//
// Outputs (into the output dir) — the shape the sealed gate checks:
//   board.json            {rows: [...]} — 100..4000 rows, whole watchlist covered,
//                         each row with rank, slug, name, implied_value_usd and
//                         farm_steps (3..12 strings of 20..600 chars); ranks are
//                         1..N with implied_value_usd non-increasing by rank.
//   data.js               window.RADAR = {...} — the dashboard's dataset, written
//                         beside dashboard/ (as the kit starter does).
//   dashboard/            index.html + app.css + app.js, copied from this repo's
//                         dashboard/ — a static page that renders with no network.
//   screenshots/          3 screenshots of the dashboard, copied from this repo's
//                         screenshots/ (see screenshots/README.md).
//   dossier.json          byte-for-byte what buildDossier from the kit's
//                         vendor/makefun-board.ts writes from dashboard/ +
//                         screenshots/.
//
// The grader runs this file with network disabled and the sealed snapshot
// mounted at /input, twice, and both runs must write the same bytes — so
// every output is derived from the snapshot alone: the reference date is
// the snapshot's as_of, never the wall clock, and no timestamp of "now"
// is written anywhere.
//
// The snapshot is tried FIRST and the live DefiLlama fetch is only a
// local-run fallback. The sealed snapshot's protocols carry exactly ten
// fields (slug, name, category, chains, tvl_usd, change_7d, mcap_usd,
// listed_at, gecko_id, symbol); the live feed uses the older names
// (tvl, mcap, listedAt, cmcId) — both shapes are read.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-board.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

const DEFILLAMA_PROTOCOLS_URL = "https://api.llama.fi/protocols";
const MIN_ROWS = 100;
const MIN_TVL_USD = 1_000_000;
/** The dossier's text cap (the gate's reference/gate.json): shapes the bytes. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

// ---------------------------------------------------------------------------
// Types (erasable TypeScript only — Node 22 type-stripping compatible)
// ---------------------------------------------------------------------------

interface RawProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  /** TVL in whole USD (tvl_usd in the sealed snapshot, tvl in the live feed). */
  tvl: number;
  change_7d: number | null;
  change_1d: number | null;
  /** Market cap in whole USD (mcap_usd / mcap), null when no token is recorded. */
  mcap: number | null;
  /** Epoch seconds DefiLlama began tracking the protocol (listed_at / listedAt). */
  listedAt: number | null;
  gecko_id: string | null;
  cmcId: string | number | null;
  symbol: string | null;
  token: string | null;
  tokenSymbol: string | null;
  hasToken: boolean;
  url: string | null;
  twitter: string | null;
  audits: number;
  parentProtocol: string | null;
}

interface FarmStep {
  step: number;
  action: string;
  why: string;
  estCostUsd: string;
}

interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvlUsd: number;
  change1dPct: number | null;
  change7dPct: number | null;
  listedAt: number | null;
  audits: number;
  url: string | null;
  twitter: string | null;
  defillamaUrl: string;
  onWatchlist: boolean;
  score: number;
  launchLikelihood: number;
  categoryMultiple: number;
  categoryPeers: number;
  /** The gate's field: a positive whole number of dollars, at most 1e14. */
  implied_value_usd: number;
  impliedFdvUsd: number;
  expectedValueUsd: number;
  valueTier: "S" | "A" | "B" | "C";
  evidence: {
    hasToken: false;
    tokenCheck: string;
    variantsMerged: number;
    dataSource: string;
  };
  comparables: Array<{ name: string; mcapUsd: number; tvlUsd: number; multiple: number }>;
  /** The gate's field: 3..12 strings, each 20..600 characters once trimmed. */
  farm_steps: string[];
  farmPlan: {
    summary: string;
    steps: FarmStep[];
    timeCommitment: string;
    risks: string[];
  };
}

interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: BoardRow[];
  live: LiveRow[];
}

interface RunStats {
  snapshotTotal: number;
  withToken: number;
  tokenisedParent: number;
  wrappedOrStaked: number;
  excludedCategory: number;
  belowMinTvl: number;
  duplicatesMerged: number;
  watchlistForced: number;
  eligible: number;
}

interface SnapshotDoc {
  asOf: string;
  source: string;
  floorUsd: number;
  protocols: RawProtocol[];
  watchlist: string[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function logNorm(v: number, lo: number, hi: number): number {
  if (hi <= lo) return 0.5;
  return clamp((Math.log10(Math.max(v, 1)) - lo) / (hi - lo), 0, 1);
}

function usd(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

function slugify(name: string, fallback: string): string {
  const s = (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || fallback;
}

/** "2023-05-01" (or an epoch number) to epoch seconds, else null. */
function toEpochSeconds(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const ms = Date.parse(`${v}T00:00:00Z`);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Input: sealed snapshot discovery, then live DefiLlama fallback
// ---------------------------------------------------------------------------

function mapProtocol(p: Record<string, unknown>): RawProtocol | null {
  if (typeof p.slug !== "string" || p.slug === "" || typeof p.name !== "string" || p.name === "") return null;
  // Sealed snapshot names first, live-feed names second.
  const tvl = typeof p.tvl_usd === "number" ? p.tvl_usd : num(p.tvl);
  const mcap = typeof p.mcap_usd === "number" ? p.mcap_usd : typeof p.mcap === "number" ? p.mcap : null;
  return {
    slug: p.slug,
    name: p.name,
    category: typeof p.category === "string" ? p.category : null,
    chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === "string") : typeof p.chain === "string" ? [p.chain] : [],
    tvl,
    change_7d: typeof p.change_7d === "number" && Number.isFinite(p.change_7d) ? p.change_7d : null,
    change_1d: typeof p.change_1d === "number" && Number.isFinite(p.change_1d) ? p.change_1d : null,
    mcap,
    listedAt: toEpochSeconds(p.listed_at ?? p.listedAt),
    gecko_id: typeof p.gecko_id === "string" ? p.gecko_id : null,
    cmcId: typeof p.cmcId === "string" || typeof p.cmcId === "number" ? p.cmcId : null,
    symbol: typeof p.symbol === "string" ? p.symbol : null,
    token: typeof p.token === "string" ? p.token : null,
    tokenSymbol: typeof p.tokenSymbol === "string" ? p.tokenSymbol : null,
    hasToken: p.hasToken === true,
    url: typeof p.url === "string" ? p.url : null,
    twitter: typeof p.twitter === "string" ? p.twitter : null,
    audits: num(p.audits),
    parentProtocol: typeof p.parentProtocol === "string" ? p.parentProtocol : null,
  };
}

function parseSnapshotText(text: string, source: string): SnapshotDoc | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const rows: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? (["protocols", "data", "snapshot", "items", "rows"]
          .map((k) => (raw as Record<string, unknown>)[k])
          .find((v) => Array.isArray(v)) as unknown[] | undefined) ?? []
      : [];
  if (rows.length <= 10) return null;
  const protocols = rows
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map(mapProtocol)
    .filter((p): p is RawProtocol => p !== null);
  if (protocols.length <= 10) return null;
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const asOf = typeof obj.as_of === "string" && /^\d{4}-\d{2}-\d{2}$/.test(obj.as_of) ? obj.as_of : new Date().toISOString().slice(0, 10);
  const src = typeof obj.source === "string" ? obj.source : source;
  const floorUsd = typeof obj.floor_usd === "number" && Number.isFinite(obj.floor_usd) && obj.floor_usd > 0 ? obj.floor_usd : 50_000_000;
  const watchlist = Array.isArray(obj.watchlist) ? obj.watchlist.filter((s): s is string => typeof s === "string") : [];
  return { asOf, source: src, floorUsd, protocols, watchlist };
}

function listJsonFiles(dir: string, depth = 0): string[] {
  if (depth > 3) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listJsonFiles(p, depth + 1));
    else if (e.isFile() && /\.json$/i.test(e.name)) out.push(p);
  }
  return out;
}

function loadSnapshotFromInput(input: string): SnapshotDoc | null {
  let st;
  try {
    st = statSync(input);
  } catch {
    return null;
  }
  const files = st.isDirectory() ? listJsonFiles(input) : [input];
  for (const f of files.sort()) {
    try {
      const doc = parseSnapshotText(readFileSync(f, "utf8"), `snapshot file: ${f}`);
      if (doc) return doc;
    } catch {
      // not parseable / not a protocol list — try the next file
    }
  }
  return null;
}

async function fetchLiveProtocols(): Promise<SnapshotDoc> {
  const res = await fetch(DEFILLAMA_PROTOCOLS_URL, {
    headers: { accept: "application/json", "user-agent": "token-launch-radar/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`DefiLlama fetch failed: HTTP ${res.status}`);
  const doc = parseSnapshotText(await res.text(), DEFILLAMA_PROTOCOLS_URL);
  if (!doc) throw new Error("DefiLlama response did not contain a protocol list");
  return doc;
}

async function loadProtocols(inputArg: string | null): Promise<SnapshotDoc> {
  const candidates = [inputArg, process.env.MAKEFUN_INPUT_DIR, process.env.INPUT_DIR, "./input", "./data/snapshot.json"].filter(
    (c): c is string => !!c,
  );
  for (const c of candidates) {
    const found = loadSnapshotFromInput(c);
    if (found) {
      console.log(`[radar] snapshot: ${found.protocols.length} protocols from ${found.source}`);
      return found;
    }
  }
  console.log("[radar] no sealed snapshot found locally — fetching live DefiLlama data (local-run fallback only)");
  return fetchLiveProtocols();
}

// ---------------------------------------------------------------------------
// Token / eligibility logic — the heart of the brief
// ---------------------------------------------------------------------------

/** Does this snapshot record say the protocol already has a token? */
function hasToken(p: RawProtocol): boolean {
  if (p.hasToken === true) return true;
  if (p.gecko_id) return true;
  if (p.cmcId) return true;
  if (typeof p.token === "string" && p.token.trim() !== "" && p.token.trim() !== "-") return true;
  const sym = (p.tokenSymbol || p.symbol || "").trim();
  // DefiLlama records "-" (or empty) when it knows no token symbol; a real
  // symbol (BNB, ZRO, AAVE, UNI, PUMP, ...) means a token is recorded,
  // even when gecko_id is null — many versioned sub-entries (Aave V3,
  // LayerZero V2, Uniswap V4) carry the parent token's symbol but no gecko_id.
  if (sym !== "" && sym !== "-" && sym !== "–") return true;
  return false;
}

/** Normalised base name, so versioned / product variants group under one protocol. */
function baseName(name: string): string {
  let n = (name || "").trim().toLowerCase();
  // Strip trailing version / product suffixes repeatedly: "Aave V3" -> "aave",
  // "Hyperliquid Bridge" -> "hyperliquid", "ether.fi Stake" -> "ether.fi".
  for (let i = 0; i < 3; i++) {
    const next = n.replace(/\s+(v\d+|v\d+\.\d+|perps|mobile app|earn|hlp|bridge|us|international|combos|stake|staking)$/i, "").trim();
    if (next === n) break;
    n = next;
  }
  return n.replace(/\s+/g, " ");
}

const WRAPPED_RE =
  /\bwrapped\b|wsteth|cbeth|sfrxeth|\b(weth|wbtc|wbnb|wsol)\b|staked\s+(eth|btc|sol|bnb|avax|near|dot|atom|trx)\b|^staked\s|^wrapped\s|\bdtao\b|\w+usd$|\b(usdd|usdt|usdc|usde|usd0|dai|frax|fdusd|pyusd|tusd|gusd|usdp)\b/i;

// Categories whose TVL is custodial / bridged assets, not protocol value
// that a token launch could capitalise on. Documented, not hidden: a
// centralised exchange or a canonical bridge holding other chains' assets
// is not a token-less protocol waiting to launch.
const EXCLUDED_CATEGORIES = new Set([
  "CEX",
  "Bridge",
  "Canonical Bridge",
  "Cross Chain Bridge",
  // Wrapped / pegged-asset products, not launch candidates:
  "Stablecoin Wrapper",
  "Dual-Token Stablecoin",
  "Restaked BTC",
  "Anchor BTC",
  "Decentralized BTC",
]);

// Prior for "would this protocol plausibly launch a token, and would the
// market care?" — used only as a multiplier on implied value, never alone.
const CATEGORY_LIKELIHOOD: Record<string, number> = {
  "Prediction Market": 0.85,
  Lending: 0.8,
  Dexs: 0.78,
  "Liquid Staking": 0.72,
  Yield: 0.72,
  Restaking: 0.7,
  Derivatives: 0.7,
  "Yield Aggregator": 0.7,
  "Risk Curators": 0.65,
  CDP: 0.65,
  "CDP Manager": 0.6,
  RWA: 0.6,
  "Onchain Capital Allocator": 0.6,
  "Basis Trading": 0.6,
  "Collateral Markets": 0.6,
  "Leveraged Farming": 0.6,
  "Staking Pool": 0.55,
  "Liquidity Manager": 0.55,
  Options: 0.55,
  Payments: 0.45,
  Chain: 0.35,
};

function isWrappedOrStakedProduct(p: RawProtocol): boolean {
  return WRAPPED_RE.test(p.name || "") || WRAPPED_RE.test(p.slug || "");
}

/** Likelihood from the category prior, adjusted for chains, audits and age — all against the snapshot's own date. */
function categoryLikelihood(p: RawProtocol, refMs: number): number {
  let l = CATEGORY_LIKELIHOOD[p.category || ""] ?? 0.55;
  const chains = (p.chains || []).length;
  if (chains >= 5) l += 0.05;
  else if (chains >= 3) l += 0.03;
  if (p.audits > 0) l += 0.04;
  if (p.listedAt && refMs / 1000 - p.listedAt < 365 * 86400) l -= 0.05; // very young
  if (p.twitter) l += 0.02;
  return clamp(l, 0.05, 0.95);
}

// ---------------------------------------------------------------------------
// Scoring: implied launch value from tokenised peers in the same category
// ---------------------------------------------------------------------------

interface CategoryStat {
  peers: number;
  medianMultiple: number;
}

function buildCategoryStats(all: RawProtocol[]): { stats: Map<string, CategoryStat>; globalMultiple: number } {
  const byCat = new Map<string, number[]>();
  const global: number[] = [];
  for (const p of all) {
    if (!hasToken(p)) continue;
    const mcap = num(p.mcap);
    const tvl = num(p.tvl);
    if (mcap > 0 && tvl > 0) {
      const m = mcap / tvl;
      if (m > 0.001 && m < 100) {
        global.push(m);
        const arr = byCat.get(p.category || "") || [];
        arr.push(m);
        byCat.set(p.category || "", arr);
      }
    }
  }
  const globalMultiple = median(global) || 1;
  const stats = new Map<string, CategoryStat>();
  for (const [cat, arr] of byCat) {
    if (arr.length >= 3) stats.set(cat, { peers: arr.length, medianMultiple: clamp(median(arr), 0.05, 5) });
  }
  return { stats, globalMultiple: clamp(globalMultiple, 0.05, 5) };
}

function topComparables(all: RawProtocol[], category: string, n = 3) {
  return all
    .filter((p) => p.category === category && hasToken(p) && num(p.mcap) > 0 && num(p.tvl) > 0)
    .map((p) => ({ name: p.name || "?", mcapUsd: num(p.mcap), tvlUsd: num(p.tvl), multiple: num(p.mcap) / num(p.tvl) }))
    .filter((c) => c.multiple > 0.001 && c.multiple < 100)
    .sort((a, b) => b.mcapUsd - a.mcapUsd)
    .slice(0, n);
}

interface EligibleEntry {
  p: RawProtocol;
  variants: number;
  onWatchlist: boolean;
}

function selectEligible(all: RawProtocol[], watchlist: string[]): { kept: EligibleEntry[]; stats: RunStats } {
  const stats: RunStats = {
    snapshotTotal: all.length,
    withToken: 0,
    tokenisedParent: 0,
    wrappedOrStaked: 0,
    excludedCategory: 0,
    belowMinTvl: 0,
    duplicatesMerged: 0,
    watchlistForced: 0,
    eligible: 0,
  };
  const bySlug = new Map(all.map((p) => [p.slug, p]));
  // 1. Which base protocols already have a token (any variant records one)?
  const tokenBases = new Set<string>();
  for (const p of all) if (hasToken(p)) tokenBases.add(baseName(p.name || ""));
  const chosen = new Map<string, EligibleEntry>();
  const baseOf = new Map<string, EligibleEntry>();
  // 2. The watchlist is the floor: every slug it names is on the board, even
  // when our stricter screens would drop it — the gate requires full
  // coverage, and the house's own rule put it there. (Four names on this
  // snapshot's list: USDD, Bittensor dTAO, Mezo Earn and Saturn — a
  // stablecoin, a staked-asset product, an earn vault of a tokenised
  // parent and a stablecoin wrapper. They are ranked by the same model,
  // flagged onWatchlist, and the dashboard says so.)
  for (const slug of watchlist) {
    const p = bySlug.get(slug);
    if (!p) continue;
    chosen.set(slug, { p, variants: 1, onWatchlist: true });
    baseOf.set(baseName(p.name || ""), chosen.get(slug)!);
    stats.watchlistForced++;
  }
  // 3. The early radar: pre-token protocols the watchlist does not name.
  for (const p of all) {
    if (chosen.has(p.slug)) continue;
    if (hasToken(p)) {
      stats.withToken++;
      continue;
    }
    if (tokenBases.has(baseName(p.name || ""))) {
      stats.tokenisedParent++;
      continue; // e.g. "Aave V3" — Aave (AAVE) already trades
    }
    if (isWrappedOrStakedProduct(p)) {
      stats.wrappedOrStaked++;
      continue; // e.g. WBTC, Binance staked ETH, Coinbase Wrapped Staked ETH
    }
    if (EXCLUDED_CATEGORIES.has(p.category || "")) {
      stats.excludedCategory++;
      continue;
    }
    if (num(p.tvl) < MIN_TVL_USD) {
      stats.belowMinTvl++;
      continue;
    }
    const b = baseName(p.name || "");
    const cur = baseOf.get(b);
    if (!cur) {
      const e: EligibleEntry = { p, variants: 1, onWatchlist: false };
      chosen.set(p.slug, e);
      baseOf.set(b, e);
    } else {
      stats.duplicatesMerged++;
      if (!cur.onWatchlist && num(p.tvl) > num(cur.p.tvl)) {
        chosen.delete(cur.p.slug);
        const e: EligibleEntry = { p, variants: cur.variants + 1, onWatchlist: false };
        chosen.set(p.slug, e);
        baseOf.set(b, e);
      }
    }
  }
  const kept = [...chosen.values()];
  stats.eligible = kept.length;
  return { kept, stats };
}

function rankRows(all: RawProtocol[], kept: EligibleEntry[], refMs: number): BoardRow[] {
  const { stats, globalMultiple } = buildCategoryStats(all);
  const evs = kept.map((e) => {
    const cat = stats.get(e.p.category || "");
    const multiple = cat ? cat.medianMultiple : globalMultiple;
    return num(e.p.tvl) * multiple;
  });
  const hiEV = Math.log10(Math.max(...evs, 1));
  const loEV = Math.log10(Math.max(Math.min(...evs), 1));
  const loTVL = Math.log10(Math.max(Math.min(...kept.map((e) => num(e.p.tvl))), 1));
  const hiTVL = Math.log10(Math.max(...kept.map((e) => num(e.p.tvl)), 1));

  const scored = kept.map((e) => {
    const p = e.p;
    const cat = stats.get(p.category || "");
    const multiple = cat ? cat.medianMultiple : globalMultiple;
    const peers = cat ? cat.peers : 0;
    const impliedFdv = Math.min(num(p.tvl) * multiple, 100e9);
    const likelihood = categoryLikelihood(p, refMs);
    const expectedValue = impliedFdv * likelihood;
    const score =
      100 * (0.55 * logNorm(expectedValue, loEV, hiEV) + 0.3 * likelihood + 0.15 * logNorm(num(p.tvl), loTVL, hiTVL));
    return { e, multiple, peers, impliedFdv, likelihood, expectedValue, score };
  });
  // Rank by implied value, not by score: the gate requires implied_value_usd
  // non-increasing with rank (rank 1 is the board's most valuable protocol).
  // Ties break on slug so two runs always write the same bytes.
  scored.sort((a, b) => b.impliedFdv - a.impliedFdv || (a.e.p.slug < b.e.p.slug ? -1 : a.e.p.slug > b.e.p.slug ? 1 : 0));

  return scored.map((s, i) => {
    const p = s.e.p;
    const tier: BoardRow["valueTier"] = i < 10 ? "S" : s.score >= 60 ? "A" : s.score >= 40 ? "B" : "C";
    const plan = farmPlan(p);
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name || "Unknown",
      category: p.category || "Unknown",
      chains: p.chains || [],
      tvlUsd: num(p.tvl),
      change1dPct: p.change_1d,
      change7dPct: p.change_7d,
      listedAt: p.listedAt,
      audits: num(p.audits),
      url: p.url || null,
      twitter: p.twitter || null,
      defillamaUrl: `https://defillama.com/protocol/${p.slug}`,
      onWatchlist: s.e.onWatchlist,
      score: Math.round(s.score * 10) / 10,
      launchLikelihood: Math.round(s.likelihood * 1000) / 1000,
      categoryMultiple: Math.round(s.multiple * 1000) / 1000,
      categoryPeers: s.peers,
      implied_value_usd: Math.max(1, Math.round(s.impliedFdv)),
      impliedFdvUsd: Math.round(s.impliedFdv),
      expectedValueUsd: Math.round(s.expectedValue),
      valueTier: tier,
      evidence: {
        hasToken: false as const,
        tokenCheck: "no gecko_id, no cmcId and no token symbol recorded; no variant of this protocol records a token",
        variantsMerged: s.e.variants,
        dataSource: "DefiLlama protocols snapshot",
      },
      comparables: topComparables(all, p.category || ""),
      farm_steps: farmStepStrings(plan),
      farmPlan: plan,
    };
  });
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
function liveRows(all: RawProtocol[]): LiveRow[] {
  return all
    .filter((p) => hasToken(p) && p.category !== "CEX")
    .sort((a, b) => (b.mcap ?? 0) - (a.mcap ?? 0) || b.tvl - a.tvl)
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: num(p.tvl),
      mcap_usd: p.mcap,
      change_7d: p.change_7d,
    }));
}

/** Why a board is not one the gate will take, or null — the starter's boardIssue, same shape. */
function boardIssue(board: BoardRow[], snapshot: SnapshotDoc): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const snapSlugs = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!snapSlugs.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? "" : "s"}: ${missing.slice(0, 5).join(", ")}`;
  if (board.length < MIN_ROWS) return `the board holds ${board.length} rows, under the ${MIN_ROWS} it must`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000)
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (typeof r.name !== "string" || r.name.trim() === "") return `${r.slug} has no name`;
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Farm plans — concrete, category-specific steps (not generic filler)
// ---------------------------------------------------------------------------

const CATEGORY_PLAYBOOK: Record<string, { verb: string; steps: string[] }> = {
  Dexs: {
    verb: "trade and provide liquidity",
    steps: [
      "Swap on the protocol on at least 3 separate weeks (small, real trades — volume and consistency matter more than size).",
      "Provide liquidity to a major pool for the protocol's core pair and keep the position open for 30+ days.",
      "Use the protocol on a second chain it supports, if any, so activity is not single-chain.",
    ],
  },
  Lending: {
    verb: "supply and borrow",
    steps: [
      "Supply a blue-chip asset (ETH / stablecoin) and leave it supplied for 30+ days.",
      "Borrow a modest amount against it and repay on time — a full supply → borrow → repay loop.",
      "Repeat the loop monthly rather than in one burst; keep health factor comfortably above liquidation.",
    ],
  },
  "Liquid Staking": {
    verb: "stake through the protocol",
    steps: [
      "Stake ETH (or the chain's native asset) through the protocol and hold the receipt token.",
      "Use the receipt token in a DeFi position (lending / LP) instead of selling it immediately.",
      "Restake / top up in a second month to show ongoing use, not a one-off deposit.",
    ],
  },
  Yield: {
    verb: "deposit into vaults",
    steps: [
      "Deposit into the protocol's flagship vault and hold for at least one full rewards epoch.",
      "Claim / compound rewards through the protocol's own UI when available.",
      "Diversify across two vaults only if both are core products — depth beats spraying.",
    ],
  },
  "Yield Aggregator": {
    verb: "route yield through the aggregator",
    steps: [
      "Deposit into the aggregator's top vault and hold for 30+ days.",
      "Use its auto-compound / auto-rebalance feature instead of manual one-off deposits.",
    ],
  },
  Derivatives: {
    verb: "trade perps / options",
    steps: [
      "Open and close a small number of real positions over several weeks (avoid wash-trading patterns).",
      "Provide liquidity to the market-making vault / pool if the protocol offers one.",
    ],
  },
  "Prediction Market": {
    verb: "trade markets",
    steps: [
      "Trade a range of markets (not one market, not one side) over several weeks.",
      "Provide liquidity where the protocol allows market-maker positions.",
      "Hold positions through resolution where sensible — resolved-market participation is the signal.",
    ],
  },
  RWA: {
    verb: "hold tokenised real-world assets",
    steps: [
      "Complete any KYC the protocol requires, then mint / buy its flagship RWA product.",
      "Hold it for 30+ days and use it as collateral if the protocol supports that.",
    ],
  },
  "Risk Curators": {
    verb: "deposit into curated vaults",
    steps: [
      "Deposit into the curator's flagship vault (the one with the most TVL) and hold for 30+ days.",
      "Allocate to a second vault only after the first position has aged.",
      "Track the vault's reports — curators reward depositors who stay through a full cycle.",
    ],
  },
  "Onchain Capital Allocator": {
    verb: "allocate to a vault",
    steps: [
      "Deposit into the allocator's main vault and hold for at least one full allocation cycle.",
      "Reinvest / top up rather than withdrawing and re-depositing the same funds.",
    ],
  },
};

const DEFAULT_PLAYBOOK = {
  verb: "use the protocol",
  steps: [
    "Use the protocol's core function with real funds, on at least 3 separate weeks.",
    "Hold the position for 30+ days instead of depositing and withdrawing the same day.",
    "Follow the protocol's official channels for any points / quests programme and complete it through its own UI.",
  ],
};

function farmPlan(p: RawProtocol): BoardRow["farmPlan"] {
  const book = CATEGORY_PLAYBOOK[p.category || ""] || DEFAULT_PLAYBOOK;
  const chains = (p.chains || []).slice(0, 3).join(", ") || "its supported chain";
  const steps: FarmStep[] = book.steps.map((action, i) => ({
    step: i + 1,
    action,
    why:
      i === 0
        ? "Creates an on-chain footprint tied to your wallet over time."
        : "Depth and consistency are what airdrop snapshots usually reward.",
    estCostUsd: i === 0 ? "$10–$50 in gas + position size of your choice" : "Gas only",
  }));
  steps.push({
    step: steps.length + 1,
    action: `Do it on ${chains} where the protocol is live, and keep records (tx hashes, dates, amounts) in case of a manual claim.`,
    why: "Multi-chain, documented activity survives snapshot disputes.",
    estCostUsd: "Gas only",
  });
  return {
    summary: `Farm a future ${p.name || "protocol"} token by ${book.verb} as a real user: recurring activity, held positions, and no wash-trading. Nothing here guarantees a token or an airdrop.`,
    steps,
    timeCommitment: "30–90 days of light, recurring activity (a few actions per week).",
    risks: [
      "The protocol may never launch a token, or may launch without an airdrop.",
      "Smart-contract risk: only use funds you can afford to lose; check audits first.",
      "Points programmes can change or be gamed — never pay for a 'guaranteed' allocation.",
    ],
  };
}

/** One farm plan as the gate's strings: action + why + cost, 20..600 chars each. */
function farmStepStrings(plan: BoardRow["farmPlan"]): string[] {
  return plan.steps.map((s) => {
    let text = `${s.action} ${s.why} Cost: ${s.estCostUsd}.`;
    if (text.length > 600) text = `${text.slice(0, 597)}...`;
    if (text.trim().length < 20) text = `${text} Hold the position and check the protocol's own page.`;
    return text;
  });
}

// ---------------------------------------------------------------------------
// Outputs: board.json, data.js, dashboard/, screenshots/, dossier.json
// ---------------------------------------------------------------------------

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string, keep?: (name: string) => boolean): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith(".")) continue;
    if (keep && !keep(name)) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

// ---------------------------------------------------------------------------
// CLI / main
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { input: string | null; out: string } {
  let input: string | null = null;
  let out = process.env.MAKEFUN_OUTPUT_DIR || "./out";
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === "--input" || argv[i] === "--snapshot") && argv[i + 1]) input = argv[++i];
    else if ((argv[i] === "--out" || argv[i] === "--output") && argv[i + 1]) out = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("Usage: node main.ts [--input <file|dir>] [--out <dir>]");
      console.log("Env: MAKEFUN_INPUT_DIR (sealed snapshot), MAKEFUN_OUTPUT_DIR (outputs).");
      process.exit(0);
    }
  }
  return { input, out };
}

async function main(): Promise<void> {
  const { input, out } = parseArgs(process.argv.slice(2));
  const outDir = out.startsWith("/") ? out : join(process.cwd(), out);
  const snapshot = await loadProtocols(input);
  // The reference date is the snapshot's own as_of: two runs on the same
  // snapshot write the same bytes, whatever day they run on.
  const refMs = Date.parse(`${snapshot.asOf}T00:00:00Z`);
  const generatedAt = `${snapshot.asOf}T00:00:00.000Z`;

  const { kept, stats } = selectEligible(snapshot.protocols, snapshot.watchlist);
  if (kept.length < MIN_ROWS) {
    throw new Error(`Only ${kept.length} eligible protocols — need at least ${MIN_ROWS} rows. Snapshot may be incomplete.`);
  }
  const rows = rankRows(snapshot.protocols, kept, refMs);
  const issue = boardIssue(rows, snapshot);
  if (issue !== null) {
    throw new Error(`the model wrote a board the gate refuses: ${issue}`);
  }
  const live = liveRows(snapshot.protocols);
  const early = rows.filter((r) => !r.onWatchlist).length;

  const { stats: catStats, globalMultiple } = buildCategoryStats(snapshot.protocols);
  const categoryMultiples: Record<string, { peers: number; medianMultiple: number }> = {};
  for (const [cat, s] of catStats) categoryMultiples[cat] = s;
  const methodology = {
    tokenCheck: "no gecko_id, no cmcId, no token symbol; no variant of the same base protocol records a token",
    watchlist: "the whole house watchlist is covered (its 40 slugs), including the 4 its own rule keeps that stricter screens would drop (USDD, Bittensor dTAO, Mezo Earn, Saturn) — ranked by the same model, flagged onWatchlist",
    wrappedStakedExcluded: "name matches wrapped / staked-asset pattern",
    excludedCategories: [...EXCLUDED_CATEGORIES],
    minTvlUsd: MIN_TVL_USD,
    impliedFdv: "TVL x category median mcap/TVL of tokenised peers (>=3 peers, clamped 0.05-5; global median otherwise), capped at $100B; rows ranked by implied value",
    globalMedianMultiple: Math.round(globalMultiple * 1000) / 1000,
    expectedValue: "implied_value_usd x launchLikelihood",
    score: "100 * (0.55*logNorm(expectedValue) + 0.30*launchLikelihood + 0.15*logNorm(tvlUsd))",
    tiers: "S = top 10; A >= 60; B >= 40; C < 40",
  };
  const board = {
    format: "token-launch-radar-board",
    version: 1,
    competition: "token-radar-01",
    generatedAt,
    source: snapshot.source,
    methodology,
    stats,
    totals: {
      rows: rows.length,
      watchlistTvlUsd: rows.reduce((a, r) => a + r.tvlUsd, 0),
      totalImpliedFdvUsd: rows.reduce((a, r) => a + r.implied_value_usd, 0),
      totalExpectedValueUsd: rows.reduce((a, r) => a + r.expectedValueUsd, 0),
    },
    rows,
  };
  const radar: RadarData = {
    as_of: snapshot.asOf,
    source: snapshot.source,
    floor_usd: snapshot.floorUsd,
    watchlist_size: snapshot.watchlist.length,
    board_size: rows.length,
    early_size: early,
    live_size: live.length,
    rows,
    live,
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "board.json"), `${JSON.stringify(board, null, 2)}\n`);
  writeFileSync(join(outDir, "data.js"), dataScript(radar));

  const dashCopied = copyFiles(join(here, "dashboard"), join(outDir, "dashboard"));
  if (!dashCopied.includes("index.html") || !dashCopied.some((n) => n.endsWith(".css")) || !dashCopied.some((n) => n.endsWith(".js"))) {
    throw new Error("dashboard/ must hold index.html and at least one .css and one .js file — see the kit starter's layout");
  }
  // Only images go to /output/screenshots: a README.md in the repo's
  // screenshots/ is documentation, and buildDossier refuses any file
  // there that is not a whole PNG or JPEG.
  const shots = copyFiles(join(here, "screenshots"), join(outDir, "screenshots"), (n) => /\.(png|jpe?g)$/i.test(n));
  if (shots.length < 3) {
    throw new Error(
      `screenshots/ holds ${shots.length} image${shots.length === 1 ? "" : "s"}: hand in 3, the board, a detail view and a filtered view — see screenshots/README.md`,
    );
  }
  for (const name of shots) {
    if (!IMAGE_NAME.test(name)) {
      throw new Error(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
    }
  }

  // The dossier is written last, from the kit's own library: the scorer
  // rebuilds it from this /output and compares bytes.
  writeFileSync(
    join(outDir, "dossier.json"),
    buildDossier(outDir, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS }),
  );

  console.log(`[radar] wrote ${rows.length} rows`);
  console.log(`[radar]   ${join(outDir, "board.json")}`);
  console.log(`[radar]   ${join(outDir, "data.js")}`);
  console.log(`[radar]   ${join(outDir, "dashboard")} (${dashCopied.length} files)`);
  console.log(`[radar]   ${join(outDir, "screenshots")} (${shots.length} images)`);
  console.log(`[radar]   ${join(outDir, "dossier.json")}`);
  console.log(`[radar] top 5: ${rows.slice(0, 5).map((r) => `${r.rank}. ${r.name} (${usd(r.implied_value_usd)} implied, score ${r.score})`).join(" | ")}`);
}

main().catch((e: unknown) => {
  console.error(`[radar] FAILED: ${(e as Error).message}`);
  process.exit(1);
});
