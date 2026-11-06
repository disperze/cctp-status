// CCTP V1 status page: static, no backend.
//  - Live checks are read from the chain by this browser (Noble LCD + Ethereum RPC).
//  - History and burns come from JSON published by the GitHub Action (VITE_DATA_URL).
// All API strings are inserted with textContent (never innerHTML). Amount math is bigint.
import Chart from "chart.js/auto";
import type { BurnsFile } from "../src/burns";
import { domainName, ETH, loadConfig, OSMOSIS } from "../src/config";
import { fetchEthereumChecks } from "../src/ethereum";
import { changeInfo, chartSeries, type SeriesPoint } from "../src/history";
import { fetchNobleChecks, type RecentBurn } from "../src/noble";
import { fetchAlloyedPool, type AlloyedPoolState } from "../src/osmosis";
import type { HistoryFile } from "../src/publish";
import { planRoutes, skipGoUrl, type OsmosisOption, type OsmosisStatus, type RouteOptionId, type RoutePlan } from "../src/routes";
import { composeStatus, trendFromRecords } from "../src/status";
import type { SnapshotRecord } from "../src/storage";
import type { CheckId, CheckResult, Direction, StatusSnapshot } from "../src/types";
import { formatUsdc, parseUsdc } from "../src/units";

const env = import.meta.env;
const POLL_SEC = Number(env.VITE_POLL_SEC || 60);
const cfg = loadConfig({
  ETH_RPC_URLS: env.VITE_ETH_RPC_URLS,
  NOBLE_LCD_URLS: env.VITE_NOBLE_LCD_URLS,
  OSMOSIS_LCD_URLS: env.VITE_OSMOSIS_LCD_URLS,
  SAFETY_MARGIN: env.VITE_SAFETY_MARGIN,
  ALLOWANCE_WARN_USDC: env.VITE_ALLOWANCE_WARN_USDC,
  TREND_WINDOW_HOURS: env.VITE_TREND_WINDOW_HOURS,
  STATUS_CACHE_SEC: String(POLL_SEC), // stale after 2x the poll interval
});
const DATA_URL = String(env.VITE_DATA_URL || "data").replace(/\/+$/, "");
const DATA_POLL_MS = 5 * 60_000;

const state: {
  status: StatusSnapshot | null;
  records: SnapshotRecord[];
  burns: BurnsFile | null;
  latest: StatusSnapshot | null;
  hours: number;
  charts: Record<string, Chart>;
  calcShown: boolean;
  pool: AlloyedPoolState | null;
  poolError?: string;
} = { status: null, records: [], burns: null, latest: null, hours: 72, charts: {}, calcShown: false, pool: null };
const lastGood = new Map<CheckId, CheckResult>();

// ---------------------------------------------------------------- helpers
type Child = Node | string | number | null | undefined | false | Child[];
function h(tag: string, attrs: Record<string, string | boolean | undefined | null> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "text") el.textContent = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  const add = (c: Child) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) return c.forEach(add);
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}
const $ = (id: string) => document.getElementById(id)!;

/** Decimal string from the API ("73186100.066559") -> "73,186,100.066559". Exact. */
function fmtDec(dec: string | null | undefined): string {
  if (dec === null || dec === undefined) return "—";
  const neg = dec.startsWith("-");
  const [i, f] = (neg ? dec.slice(1) : dec).split(".");
  return (neg ? "−" : "") + i!.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? "." + f : "");
}
const fmtRaw = (raw: string | null | undefined) => (raw ? formatUsdc(BigInt(raw)) : "—");
/** Whole-USDC display for big aggregates (truncates sub-dollar dust). */
const fmtRawWhole = (raw: bigint) => formatUsdc((raw / 1_000_000n) * 1_000_000n);

function fmtTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function ago(iso: string) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// Icon + label so status is never color alone. Static markup only.
type IconKind = "good" | "warning" | "critical" | "pause" | "unknown";
function icon(kind: IconKind): SVGSVGElement {
  const colorVar = { good: "--good", warning: "--warning", critical: "--critical", pause: "--critical", unknown: "--unknown" }[kind];
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const paths: Record<IconKind, string> = {
    good: '<circle cx="8" cy="8" r="7" fill="C"/><path d="M4.5 8.2l2.3 2.3 4.7-4.8" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    warning: '<path d="M8 1.2l7 13.3H1z" fill="C"/><path d="M8 6v4" stroke="#0b0b0b" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="12.3" r="1" fill="#0b0b0b"/>',
    critical: '<circle cx="8" cy="8" r="7" fill="C"/><path d="M5.3 5.3l5.4 5.4M10.7 5.3l-5.4 5.4" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
    pause: '<circle cx="8" cy="8" r="7" fill="C"/><path d="M6.2 5v6M9.8 5v6" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
    unknown: '<circle cx="8" cy="8" r="7" fill="C"/><path d="M6 6.2a2 2 0 1 1 2.6 1.9c-.5.2-.6.5-.6 1v.4" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/><circle cx="8" cy="11.8" r="0.9" fill="#fff"/>',
  };
  svg.innerHTML = paths[kind].replaceAll('"C"', `"${css(colorVar)}"`);
  return svg;
}
const ROUTE_ICON: Record<string, IconKind> = { OPEN: "good", DEGRADED: "warning", PAUSED: "pause", BLOCKED: "critical", UNKNOWN: "unknown" };
const CHECK_ICON: Record<string, IconKind> = { ok: "good", warn: "warning", blocked: "critical", error: "unknown" };

function isStale(c: CheckResult) {
  return Date.now() - Date.parse(c.fetched_at) > (state.status?.config.stale_after_sec ?? 2 * POLL_SEC) * 1000;
}

// ---------------------------------------------------------------- live status (read in the browser)
async function readLive(): Promise<StatusSnapshot> {
  const deps = { timeoutMs: cfg.requestTimeoutMs, allowanceWarnRaw: cfg.allowanceWarnRaw };
  const [noble, eth] = await Promise.all([fetchNobleChecks(cfg.nobleLcdUrls, deps), fetchEthereumChecks(cfg.ethRpcUrls, deps)]);
  const checks = [...noble, ...eth].map((c) => {
    if (c.status !== "error") {
      lastGood.set(c.id, c);
      return c;
    }
    const prev = lastGood.get(c.id);
    return prev ? { ...c, last_good: { raw: prev.raw, value_usdc: prev.value_usdc, fetched_at: prev.fetched_at } } : c;
  });
  const now = new Date();
  return composeStatus(checks, trendFromRecords(state.records, cfg, now), cfg, now, now);
}

function renderRoutes(s: StatusSnapshot) {
  const root = $("routes");
  root.replaceChildren();
  for (const dir of ["noble-eth", "eth-noble"] as const) {
    const r = s.routes[dir];
    // If this tab's data has gone stale (e.g. the device slept), never keep showing OPEN.
    const anyStale = r.check_ids.some((id) => {
      const c = s.checks.find((x) => x.id === id);
      return c && isStale(c);
    });
    const shown = anyStale && (r.state === "OPEN" || r.state === "DEGRADED") ? "UNKNOWN" : r.state;
    const reasons = shown !== r.state ? ["Data is stale: waiting for a fresh read.", ...r.reasons] : r.reasons;
    const [limitId, capId] = dir === "noble-eth" ? ["A1", "A5"] : ["B1", "B2"];
    root.append(
      h("article", { class: `card route${dir === "noble-eth" ? " primary" : ""}`, "data-state": shown, "aria-label": `${r.label}: ${shown}` },
        h("div", { class: "route-head" }, h("h2", { text: r.label }), h("span", { class: "pill" }, icon(ROUTE_ICON[shown] ?? "unknown"), h("span", { text: shown }))),
        h("div", { class: "stats" },
          h("div", {},
            h("div", { class: "stat-label", text: `Max per transaction (${limitId})` }),
            h("div", { class: "stat-value" }, fmtDec(r.max_per_tx_usdc), h("span", { class: "unit", text: "USDC" }))),
          h("div", {},
            h("div", { class: "stat-label", text: `Max total right now (${capId})` }),
            h("div", { class: "stat-value" }, fmtDec(r.destination_cap_usdc), h("span", { class: "unit", text: "USDC" })),
            h("div", { class: "stat-note", text: "Destination allowance, shared by all users" }))),
        reasons.length ? h("ul", { class: "reasons" }, reasons.slice(0, 6).map((t) => h("li", { text: t }))) : null));
  }
}

function renderScheduled() {
  const l = state.latest;
  $("scheduled").textContent = l
    ? `Last scheduled snapshot (GitHub Action): ${fmtTime(l.generated_at)} (${ago(l.generated_at)}). Noble → Ethereum ${l.routes["noble-eth"].state}, Ethereum → Noble ${l.routes["eth-noble"].state}.`
    : "";
}

// ---------------------------------------------------------------- countdowns
function renderCountdowns() {
  const s = state.status;
  if (!s) return;
  const now = Date.now();
  $("countdowns").replaceChildren(
    ...s.dates.map((d) => {
      const t = Date.parse(d.date);
      const diff = t - now;
      let left: string;
      if (diff <= 0) left = `${Math.floor(-diff / 86400000)} days ago`;
      else {
        const p = (n: number) => String(n).padStart(2, "0");
        left = `${Math.floor(diff / 86400000)}d ${p(Math.floor((diff % 86400000) / 3600000))}h ${p(Math.floor((diff % 3600000) / 60000))}m ${p(Math.floor((diff % 60000) / 1000))}s`;
      }
      return h("div", { class: `countdown${diff <= 0 ? " past" : ""}` },
        h("div", { class: "when", text: new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) + " (UTC)" }),
        h("div", { class: "left", text: left }),
        h("div", { class: "what", text: d.label }));
    }));
}

// ---------------------------------------------------------------- checks table
const ROUTE_USE: Record<string, string> = {
  A1: "N→E", A2: "both", A3: "both", A4: "both", A5: "N→E", A6: "N→E", A7: "both", A8: "both", A9: "both", A10: "both", A11: "both", B1: "E→N", B2: "E→N",
};
function renderChecks(s: StatusSnapshot) {
  const head = h("tr", {}, ["ID", "Check", "Value", "Status", "Route", "Fetched", "Source"].map((t) => h("th", { text: t, scope: "col" })));
  const rows: HTMLElement[] = [];
  for (const [name, ids] of [["Noble", ["A1", "A2", "A3", "A4", "A11", "B2"]], ["Ethereum", ["A5", "A6", "A7", "A8", "A9", "A10", "B1"]]] as const) {
    rows.push(h("tr", { class: "group" }, h("th", { colspan: "7", text: name })));
    for (const id of ids) {
      const c = s.checks.find((x) => x.id === id);
      if (!c) continue;
      let value: Child;
      if (c.status === "error") {
        value = h("span", {}, h("span", { class: "error-text", text: "read failed" }),
          c.last_good ? h("div", { class: "muted small", text: `last good: ${c.last_good.value_usdc ? fmtDec(c.last_good.value_usdc) + " USDC" : c.last_good.raw} (${ago(c.last_good.fetched_at)})` }) : null);
      } else if (c.value_usdc !== undefined) value = `${fmtDec(c.value_usdc)} USDC`;
      else value = h("span", { class: c.raw?.startsWith("0x") ? "mono" : "", text: c.raw ?? "—" });
      rows.push(h("tr", {},
        h("td", { text: c.id }),
        h("td", {}, c.label, c.detail ? h("div", { class: "muted small", text: c.detail }) : null),
        h("td", { class: c.value_usdc !== undefined ? "num" : "" }, value),
        h("td", {}, h("span", { class: "status" }, icon(CHECK_ICON[c.status] ?? "unknown"), c.status)),
        h("td", { text: ROUTE_USE[c.id] ?? "" }),
        h("td", { title: c.fetched_at }, ago(c.fetched_at), isStale(c) ? h("span", { class: "stale-tag", text: "STALE" }) : null),
        h("td", {},
          h("a", { href: c.source_url, target: "_blank", rel: "noopener", text: c.source }),
          h("div", { class: "muted small", text: [c.endpoint, c.block ? `block ${c.block}` : null].filter(Boolean).join(" · ") }))));
    }
  }
  $("checks").replaceChildren(h("thead", {}, head), h("tbody", {}, rows));
}

// ---------------------------------------------------------------- calculator (local bigint math)
async function readPool() {
  try {
    state.pool = await fetchAlloyedPool(cfg.osmosisLcdUrls, { timeoutMs: cfg.requestTimeoutMs });
    state.poolError = undefined;
  } catch (err) {
    // Keep the previous reading: it turns "unknown" by itself once it is stale.
    state.poolError = (err as Error).message.split(": ")[0];
  }
}

const stat = (label: string, v: string | null, unit: string | false = "USDC", note?: string) =>
  h("div", {},
    h("div", { class: "stat-label", text: label }),
    h("div", { class: "stat-value" }, unit ? fmtDec(v) : v ?? "—", unit ? h("span", { class: "unit", text: unit }) : null),
    note ? h("div", { class: "stat-note", text: note }) : null);

const OSMO_ICON: Record<OsmosisStatus, IconKind> = { ok: "good", insufficient: "critical", unavailable: "pause", unknown: "unknown" };
const OSMO_LABEL: Record<OsmosisStatus, string> = { ok: "Enough liquidity", insufficient: "Not enough liquidity", unavailable: "Unavailable", unknown: "Unknown" };

function optionCard(id: RouteOptionId, recommended: boolean, title: string, statusEl: HTMLElement, ...body: Child[]) {
  return h("article", { class: `option${recommended ? " recommended" : ""}`, "data-option": id, "aria-label": `${title}${recommended ? " (recommended)" : ""}` },
    h("div", { class: "option-head" },
      h("h3", {}, title, h("span", { class: "tag", text: recommended ? "Recommended" : id === "osmosis" ? "Preferred when liquid" : "Fallback" })),
      statusEl),
    body);
}

function osmosisCard(o: OsmosisOption, recommended: boolean, amount: bigint) {
  const status = h("span", { class: "pill" }, icon(OSMO_ICON[o.status]), h("span", { text: OSMO_LABEL[o.status] }));
  return optionCard("osmosis", recommended, o.label, status,
    h("p", { class: `option-detail ${o.status === "ok" ? "good-text" : o.status === "insufficient" ? "error-text" : ""}`, text: o.status_detail }),
    h("div", { class: "calc-summary" },
      stat(`Pool balance (${o.asset_out.symbol})`, o.available_usdc, "USDC", "The most one swap can take out"),
      stat(`Usable (balance × ${cfg.safetyMargin.text})`, o.usable_usdc),
      stat("Swap", `${o.asset_in.symbol} → ${o.asset_out.symbol}`, false, "1:1 transmuter swap")),
    h("ol", { class: "steps" }, o.steps.map((t) => h("li", { text: t }))),
    h("p", { class: "links" },
      h("a", { href: skipGoUrl(amount), target: "_blank", rel: "noopener", text: "Open in Skip Go" }), " · ",
      h("a", { href: OSMOSIS.poolUrl, target: "_blank", rel: "noopener", text: `Pool ${OSMOSIS.poolId} on Osmosis` }),
      o.source_url ? [" · ", h("a", { href: o.source_url, target: "_blank", rel: "noopener", text: "Raw balances" })] : null),
    o.fetched_at
      ? h("p", { class: "muted small" },
          `Read ${ago(o.fetched_at)} from ${[o.endpoint, o.block ? `block ${o.block}` : null].filter(Boolean).join(" · ")}`,
          o.stale ? h("span", { class: "stale-tag", text: "STALE" }) : null)
      : null,
    h("ul", { class: "warnings" }, o.notes.map((w) => h("li", { text: w }))));
}

function cctpCard(p: RoutePlan) {
  const r = p.cctp;
  const fitsEl =
    r.fits_destination_cap === null
      ? h("span", { class: "fits" }, icon("unknown"), "Destination allowance unknown")
      : r.fits_destination_cap
        ? h("span", { class: "fits yes" }, icon("good"), "Fits within destination allowance")
        : h("span", { class: "fits no" }, icon("critical"), "Exceeds destination allowance");
  const items: HTMLElement[] = [];
  let n = 0;
  for (const g of r.chunks) {
    const count = Number(g.count);
    if (count <= 20) for (let i = 0; i < count; i++) items.push(h("li", { text: `${fmtDec(g.amount_usdc)} USDC` }));
    else items.push(h("li", { text: `${count} × ${fmtDec(g.amount_usdc)} USDC` }));
    n += count;
  }
  const status = h("span", { class: "pill" }, icon(ROUTE_ICON[r.route_state] ?? "unknown"), h("span", { text: r.route_state }));
  const title = p.direction === "noble-eth" ? "Noble → Ethereum USDC via CCTP V1" : `CCTP V1 direct: ${r.route_label}`;
  return optionCard("cctp", p.recommended === "cctp", title, status,
    h("div", { class: "calc-summary" },
      stat("Messages needed", r.messages, false),
      stat(`Safe chunk (limit × ${r.safety_margin})`, r.safe_chunk_usdc),
      stat("Per-message limit", r.per_tx_limit_usdc),
      stat("Destination allowance", r.destination_cap_usdc)),
    h("p", {}, fitsEl),
    items.length ? h("details", { open: n <= 20 }, h("summary", { text: `Chunks (${n})` }), h("ol", { class: "chunks" }, items)) : "",
    h("ul", { class: "warnings" }, r.warnings.map((w) => h("li", { text: w }))));
}

function runCalc() {
  const out = $("calc-result");
  if (!state.status) return;
  const direction = ($("calc-direction") as HTMLSelectElement).value as Direction;
  let amount: bigint;
  try {
    amount = parseUsdc(($("calc-amount") as HTMLInputElement).value);
    if (amount <= 0n) throw new Error("Amount must be greater than 0");
  } catch (err) {
    out.replaceChildren(h("p", { class: "error-text", text: (err as Error).message }));
    return;
  }
  state.calcShown = true;
  const p = planRoutes(state.status, direction, amount, cfg.safetyMargin, state.pool, {
    now: new Date(),
    staleAfterMs: (state.status.config.stale_after_sec ?? 2 * POLL_SEC) * 1000,
    poolError: state.poolError,
  });
  const cctp = cctpCard(p);
  const osmo = p.osmosis ? osmosisCard(p.osmosis, p.recommended === "osmosis", amount) : null;
  const cards = p.recommended === "osmosis" ? [osmo, cctp] : [cctp, osmo];
  const recLabel = p.recommended === "osmosis" ? p.osmosis!.label : p.direction === "noble-eth" ? "Noble → Ethereum USDC via CCTP V1" : "CCTP V1 direct";
  const recIcon: IconKind = p.recommended === "osmosis" || p.cctp.route_state === "OPEN" ? "good" : "warning";
  out.replaceChildren(
    h("p", { class: "recommendation" },
      icon(recIcon),
      h("span", {}, h("strong", { text: `Recommended for ${fmtDec(p.amount_usdc)} USDC: ${recLabel}. ` }), p.recommended_reason)),
    h("div", { class: "options" }, cards));
}

// ---------------------------------------------------------------- chart helpers
function compact(n: number) {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "k";
  return String(n);
}
const crosshair = {
  id: "crosshair",
  afterDatasetsDraw(chart: Chart) {
    const active = chart.tooltip?.getActiveElements() ?? [];
    if (!active.length || (chart.config as any).type !== "line") return;
    const x = active[0]!.element.x;
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = css("--axis");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  },
};
interface SeriesDef { id: CheckId; name: string; color: string; dash?: number[] }
function legend(el: HTMLElement, defs: { name: string; color: string; dash?: number[] }[]) {
  el.replaceChildren(...defs.map((s) => {
    const sw = h("i");
    sw.style.background = s.dash ? `repeating-linear-gradient(90deg, ${css(s.color)} 0 5px, transparent 5px 8px)` : css(s.color);
    return h("span", {}, sw, s.name);
  }));
}
function axes() {
  const grid = css("--grid");
  const tick = css("--muted");
  return { grid, tick, axis: css("--axis") };
}

// ---------------------------------------------------------------- limit history
const SERIES: Record<"limits" | "allow", SeriesDef[]> = {
  limits: [
    { id: "A1", name: "Noble burn limit (Noble → Eth)", color: "--series-1" },
    { id: "B1", name: "Ethereum burn limit (Eth → Noble)", color: "--series-2", dash: [6, 4] },
  ],
  allow: [
    { id: "A5", name: "Ethereum TokenMinter (Noble → Eth)", color: "--series-1" },
    { id: "B2", name: "Noble CCTP module (Eth → Noble)", color: "--series-2", dash: [6, 4] },
  ],
};

function drawLineChart(key: "limits" | "allow", series: SeriesPoint[], from: number, to: number) {
  const { grid, tick, axis } = axes();
  const datasets = SERIES[key].map((s) => {
    const data = series.filter((p) => p[s.id]).map((p) => ({ x: Date.parse(p.ts), y: Number(p[s.id]) / 1e6, raw: p[s.id] }));
    return {
      label: s.name, data, borderColor: css(s.color), backgroundColor: css(s.color), borderWidth: 2, borderDash: s.dash,
      borderCapStyle: "round" as const, borderJoinStyle: "round" as const, stepped: "before" as const,
      pointRadius: data.length <= 2 ? 4 : 0, pointHoverRadius: 5, pointHoverBorderColor: css("--surface"), pointHoverBorderWidth: 2,
    };
  });
  state.charts[key]?.destroy();
  state.charts[key] = new Chart($(`chart-${key}`) as HTMLCanvasElement, {
    type: "line",
    data: { datasets: datasets as any },
    plugins: [crosshair],
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
      interaction: { mode: "index", intersect: false, axis: "x" },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => (items[0] ? fmtTime(new Date(items[0].parsed.x as number).toISOString()) : ""),
            label: (item) => `${item.dataset.label}: ${fmtRaw((item.raw as any).raw)} USDC`, // exact, from base units
          },
        },
      },
      scales: {
        x: {
          type: "linear", min: from, max: to, grid: { color: grid, drawTicks: false }, border: { color: axis },
          ticks: {
            color: tick, maxTicksLimit: 6,
            callback: (v) => {
              const d = new Date(Number(v));
              return state.hours <= 24 ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
            },
          },
        },
        y: { grace: "10%", grid: { color: grid, drawTicks: false }, border: { display: false }, ticks: { color: tick, callback: (v) => compact(Number(v)), maxTicksLimit: 5, padding: 6 } },
      },
    },
  });
}

function renderHistory() {
  const to = Date.now();
  const from = to - state.hours * 3600_000;
  const records = state.records.filter((r) => Date.parse(r.ts) >= from);
  const series = chartSeries(records);
  $("hist-meta").textContent = records.length
    ? `${records.length} snapshots in the last ${state.hours}h · one every ${cfg.snapshotIntervalMin} min`
    : "No snapshots in this window yet. The GitHub Action records one every ~15 min.";
  for (const key of ["limits", "allow"] as const) {
    legend($(`legend-${key}`), SERIES[key]);
    drawLineChart(key, series, from, to);
    $(`changes-${key}`).replaceChildren(...SERIES[key].map((s) => {
      const c = changeInfo(records, s.id);
      if (c.current_raw === null) return h("div", { text: `${s.name}: no data yet` });
      const parts: Child[] = [h("strong", { text: `${s.name.split(" (")[0]}: ` }), `${fmtDec(c.current_usdc)} USDC · `];
      if (c.last_changed_at) {
        const down = c.delta_raw!.startsWith("-");
        parts.push(`last changed ${fmtTime(c.last_changed_at)} `, h("span", { class: down ? "delta-down" : "delta-up", text: `(${down ? "" : "+"}${fmtDec(c.delta_usdc)})` }));
      } else parts.push(`unchanged since ${fmtTime(c.observed_since)}`);
      return h("div", {}, parts);
    }));
  }
  const cols: CheckId[] = ["A1", "B1", "A5", "B2"];
  $("hist-table").replaceChildren(
    h("thead", {}, h("tr", {}, h("th", { text: "Time" }), cols.map((c) => h("th", { class: "num", text: `${c} (USDC)` })), h("th", { text: "Noble→Eth" }), h("th", { text: "Eth→Noble" }))),
    h("tbody", {}, series.slice().reverse().slice(0, 500).map((p) =>
      h("tr", {}, h("td", { text: fmtTime(p.ts) }), cols.map((c) => h("td", { class: "num", text: fmtRaw(p[c]) })), h("td", { text: p.routes["noble-eth"] }), h("td", { text: p.routes["eth-noble"] })))));
}

// ---------------------------------------------------------------- burns per day
function dayRange(fromDay: string, toDay: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(fromDay + "T00:00:00Z"); t <= Date.parse(toDay + "T00:00:00Z"); t += 86400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

function renderBurns() {
  const b = state.burns;
  if (!b || !b.tracking_since) {
    $("burns-meta").textContent = "No burn data published yet. The GitHub Action collects it every ~15 min.";
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const firstDay = b.tracking_since.slice(0, 10);
  const days = dayRange(firstDay, today).slice(-30);
  const ETH_DOMAIN = "0";
  const sum = (day: string, pred: (d: string) => boolean) => {
    let amount = 0n, count = 0;
    for (const [d, v] of Object.entries(b.days[day] ?? {})) if (pred(d)) { amount += BigInt(v.amount_raw); count += v.count; }
    return { amount, count };
  };
  const isEth = (d: string) => d === ETH_DOMAIN;
  const all = () => true;

  $("burns-meta").textContent =
    `Counting since ${fmtTime(b.tracking_since)} (first day is partial). ` +
    (b.caught_up ? `Up to date as of ${fmtTime(b.updated_at)}.` : `Backfill in progress, counted through ${fmtTime(b.cursor_time)}.`);

  const last7 = days.slice(-7);
  const agg = (ds: string[], p: (d: string) => boolean) => ds.reduce((acc, d) => { const s = sum(d, p); return { amount: acc.amount + s.amount, count: acc.count + s.count }; }, { amount: 0n, count: 0 });
  const tile = (label: string, v: { amount: bigint; count: number }) =>
    h("div", {}, h("div", { class: "stat-label", text: label }), h("div", { class: "stat-value" }, fmtRawWhole(v.amount), h("span", { class: "unit", text: "USDC" })), h("div", { class: "stat-note", text: `${v.count} burns` }));
  $("burns-stats").replaceChildren(
    tile("Today → Ethereum (UTC, so far)", sum(today, isEth)),
    tile("Today → all destinations", sum(today, all)),
    tile("Last 7 days → Ethereum", agg(last7, isEth)),
    tile("Last 7 days → all destinations", agg(last7, all)));

  // Stacked bars: Ethereum vs every other V1 destination.
  const defs = [
    { name: "Ethereum", color: "--series-1", pred: isEth },
    { name: "Other destinations", color: "--series-2", pred: (d: string) => d !== ETH_DOMAIN },
  ];
  legend($("legend-burns"), defs);
  const { grid, tick, axis } = axes();
  const values = defs.map((d) => days.map((day) => sum(day, d.pred)));
  const datasets = defs.map((d, i) => ({
    label: d.name,
    data: values[i]!.map((v) => Number(v.amount) / 1e6),
    backgroundColor: css(d.color),
    borderColor: css("--surface"),
    borderWidth: 2, // 2px surface gap between stacked segments
    borderSkipped: false as const,
    maxBarThickness: 24,
    // 4px rounding only on the top data end of each stack
    borderRadius: (ctx: { dataIndex: number }) =>
      i === 1 || values[1]![ctx.dataIndex]!.amount === 0n ? { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 } : 0,
  }));
  state.charts.burns?.destroy();
  state.charts.burns = new Chart($("chart-burns") as HTMLCanvasElement, {
    type: "bar",
    data: { labels: days.map((d) => new Date(d + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })), datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const d = days[items[0]!.dataIndex]!;
              return `${d}${d === today ? " (so far)" : d === firstDay ? " (partial)" : ""}`;
            },
            label: (item) => {
              const v = values[item.datasetIndex]![item.dataIndex]!;
              return `${defs[item.datasetIndex]!.name}: ${formatUsdc(v.amount)} USDC (${v.count} burns)`;
            },
          },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, border: { color: axis }, ticks: { color: tick, maxTicksLimit: 10, autoSkip: true } },
        y: { stacked: true, grid: { color: grid, drawTicks: false }, border: { display: false }, ticks: { color: tick, callback: (v) => compact(Number(v)), maxTicksLimit: 5, padding: 6 } },
      },
    },
  });

  // Table: one column per destination that appears.
  const domains = [...new Set(days.flatMap((d) => Object.keys(b.days[d] ?? {})))].sort((a, c) => Number(a) - Number(c));
  $("burns-table").replaceChildren(
    h("thead", {}, h("tr", {}, h("th", { text: "Day (UTC)" }), domains.map((d) => h("th", { class: "num", text: domainName(Number(d)) })), h("th", { class: "num", text: "Total" }))),
    h("tbody", {}, days.slice().reverse().map((day) => {
      const tot = sum(day, all);
      return h("tr", {},
        h("td", {}, day, day === today ? h("span", { class: "partial", text: " so far" }) : day === firstDay ? h("span", { class: "partial", text: " partial" }) : null),
        domains.map((d) => {
          const v = b.days[day]?.[d];
          return h("td", { class: "num", title: v ? `${v.count} burns` : "" , text: v ? fmtRawWhole(BigInt(v.amount_raw)) : "—" });
        }),
        h("td", { class: "num", text: `${fmtRawWhole(tot.amount)} (${tot.count})` }));
    })));

  renderActivity(b.recent);
}

function recipientLink(burn: RecentBurn): Child {
  if (!burn.mint_recipient) return "—";
  if (burn.destination_domain === 0) return h("a", { class: "mono", href: `${ETH.explorer}/address/${burn.mint_recipient}`, target: "_blank", rel: "noopener", text: burn.mint_recipient });
  return h("span", { class: "mono", text: burn.mint_recipient });
}

const ACTIVITY_PAGE_SIZE = 10;
let activityPage = 0;

function renderActivity(items: RecentBurn[]) {
  const pages = Math.max(1, Math.ceil(items.length / ACTIVITY_PAGE_SIZE));
  activityPage = Math.min(activityPage, pages - 1);
  const start = activityPage * ACTIVITY_PAGE_SIZE;
  const pageItems = items.slice(start, start + ACTIVITY_PAGE_SIZE);

  const head = h("tr", {}, ["Time", "Destination", "Amount (USDC)", "Recipient", "Noble tx"].map((t, i) => h("th", { class: i === 2 ? "num" : "", text: t })));
  const rows = pageItems.map((b) =>
    h("tr", {},
      h("td", { title: b.time, text: `${fmtTime(b.time)} (${ago(b.time)})` }),
      h("td", { text: domainName(b.destination_domain) }),
      h("td", { class: "num", text: fmtDec(b.amount_usdc) }),
      h("td", {}, recipientLink(b)),
      h("td", {}, h("a", { class: "mono", href: b.explorer_url, target: "_blank", rel: "noopener", text: b.txhash.slice(0, 10) + "…" }))));
  $("activity").replaceChildren(h("thead", {}, head), h("tbody", {}, rows.length ? rows : [h("tr", {}, h("td", { colspan: "5", class: "muted", text: "No burns recorded yet." }))]));

  const pager = $("activity-pager");
  if (pages <= 1) {
    pager.hidden = true;
    pager.replaceChildren();
    return;
  }
  const go = (delta: number) => () => { activityPage += delta; renderActivity(items); };
  const prev = h("button", { type: "button", disabled: activityPage === 0, "aria-label": "Newer burns", text: "‹ Newer" });
  const next = h("button", { type: "button", disabled: activityPage >= pages - 1, "aria-label": "Older burns", text: "Older ›" });
  prev.addEventListener("click", go(-1));
  next.addEventListener("click", go(1));
  pager.hidden = false;
  pager.replaceChildren(
    prev,
    h("span", { class: "muted small", "aria-live": "polite", text: `${start + 1}–${start + pageItems.length} of ${items.length} · page ${activityPage + 1}/${pages}` }),
    next);
}

// ---------------------------------------------------------------- loops
async function loadData() {
  const [hist, burns, latest] = await Promise.allSettled([
    getJson<HistoryFile>(`${DATA_URL}/history.json`),
    getJson<BurnsFile>(`${DATA_URL}/burns.json`),
    getJson<StatusSnapshot>(`${DATA_URL}/latest.json`),
  ]);
  if (hist.status === "fulfilled") state.records = hist.value.records;
  else $("hist-meta").textContent = `History unavailable (${hist.reason?.message ?? hist.reason}).`;
  if (burns.status === "fulfilled") state.burns = burns.value;
  if (latest.status === "fulfilled") state.latest = latest.value;
  renderHistory();
  renderBurns();
  renderScheduled();
}

async function loadStatus() {
  const updated = $("updated");
  try {
    // The pool read never throws; it only feeds the calculator.
    const [s] = await Promise.all([readLive(), readPool()]);
    state.status = s;
    renderRoutes(s);
    renderChecks(s);
    renderCountdowns();
    updated.textContent = `Read live at ${fmtTime(s.generated_at)} · refreshes every ${POLL_SEC}s`;
    if (state.calcShown) runCalc();
  } catch (err) {
    updated.textContent = `Live read failed (${(err as Error).message}). Showing last known data.`;
    if (state.status) {
      renderRoutes(state.status);
      renderChecks(state.status);
    }
  }
}

$("calc-form").addEventListener("submit", (e) => {
  e.preventDefault();
  runCalc();
});
$("calc-direction").addEventListener("change", runCalc);
$("range").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-hours]");
  if (!btn) return;
  state.hours = Number(btn.dataset.hours);
  for (const b of (e.currentTarget as HTMLElement).querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === btn));
  renderHistory();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  renderHistory();
  renderBurns();
  if (state.status) renderRoutes(state.status);
});
for (const [id, file] of [["link-latest", "latest.json"], ["link-history", "history.json"], ["link-burns", "burns.json"]]) {
  $(id!).setAttribute("href", `${DATA_URL}/${file}`);
}

// History first (the trend rule needs it), then the live read.
await loadData().catch(() => {});
await loadStatus();
runCalc();
setInterval(loadStatus, POLL_SEC * 1000);
setInterval(() => loadData().catch(() => {}), DATA_POLL_MS);
setInterval(renderCountdowns, 1000);
