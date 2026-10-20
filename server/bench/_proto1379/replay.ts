// PROTOTYPE（#1379、使い捨て）— 10/09 のログの diff の区切りで規則 B を再生し、Jev の判定を重ねる。発言の本文は読まない
// node replay.ts <none|all|gated> <model> <min> [from=1800] [to=2280] [nth=0]
//   all:   画面が届くたびに、その時点で最後に添えた画像と比べて判定する（規則 B の前）
//   gated: 規則 B が添えうる画面だけ判定する。届いた時点で起点 + 10 秒以上か、持ち越しになったとき（規則 B の後）
//   答えが「変わっていない」（p < min）なら候補から外す。差分更新の組み立てまでに答えが無い・失敗したら今どおり
//   判定は [from, to) の画面だけ。外は規則 B だけで流す
import { readFileSync } from "node:fs";
import { anchorAfter, byStart, carriedOf, selectScreens, SCREEN_GAP_SECONDS } from "../../src/core/screenSelection.ts";
import { judge } from "./jev.ts";

const [mode, model, minArg, from = "1800", to = "2280", nthArg = "0"] = process.argv.slice(2);
const MIN = Number(minArg), FROM = Number(from), TO = Number(to), NTH = Number(nthArg);
const SESSION = `${process.env.HOME}/.live-mindmap/sessions/2026-10-09T11-59-57.947Z`;
const SCREENS_MAX = 3, IMAGE_USD = 0.0044, TOKEN_USD = 42 / 1e9;
const lines = readFileSync(`${SESSION}/log.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));

type S = { seq: number; start: number; image: string | null; at: number };
type J = { readyAt: number; p?: number; ms: number; tokens?: number; error?: string };
const screens: S[] = [];
const remarkAt = new Map<string, number>(), remarkEnd = new Map<string, number>();
for (const e of lines) {
  if (e.type === "screen") screens.push({ seq: screens.length, start: e.start, image: e.image ?? null, at: Date.parse(e.at) });
  if (e.type === "remark") { remarkAt.set(e.remark.id, Date.parse(e.at)); remarkEnd.set(e.remark.id, e.remark.end); }
}
// diff の組み立ての時刻は記録が無いので、最も早く見積もる: screenCount 枚目の画面と新しい発言のうち、遅く届いた方
type D = { fresh: string[]; screenCount: number; t: number };
const diffs: D[] = lines.filter((e) => e.type === "diff" && e.input.fresh.length).map((e) => {
  const sc = e.input.screenCount ?? 0;
  const t = Math.max(sc ? screens[sc - 1].at : 0, ...e.input.fresh.map((id: string) => remarkAt.get(id)!));
  return { fresh: e.input.fresh, screenCount: sc, t: sc < screens.length ? Math.min(t, screens[sc].at - 1) : t };
});
type Ev = { t: number; k: 0; s: S } | { t: number; k: 1; d: D };
const events: Ev[] = [...screens.map((s) => ({ t: s.at, k: 0 as const, s })), ...diffs.map((d) => ({ t: d.t, k: 1 as const, d }))]
  .sort((a, b) => a.t - b.t || a.k - b.k);

const inWin = (h: { start: number; image: string | null }) => h.image !== null && h.start >= FROM && h.start < TO;
const path = (img: string) => `${SESSION}/screens/${img}`;
let unsent: S[] = [], carried: string | undefined, anchor: number | undefined, ref: string | undefined;
const judged = new Map<number, J>(), attached: S[] = [], late = new Set<number>(), dropped = new Set<number>();

async function ask(h: S, at: number) {
  if (mode === "none" || h.image === null || ref === undefined || !inWin(h) || judged.has(h.seq) || h.image === ref) return;
  const a = await judge(model, path(ref), path(h.image), NTH);
  judged.set(h.seq, { readyAt: at + a.ms, ms: a.ms, ...("p" in a ? { p: a.p, tokens: a.tokens } : { error: a.error }) });
}

for (const ev of events) {
  if (ev.k === 0) {
    const h = ev.s; unsent.push(h);
    if (mode === "all" || (mode === "gated" && (anchor === undefined || h.start >= anchor + SCREEN_GAP_SECONDS))) await ask(h, ev.t);
    continue;
  }
  const { d, t } = ev;
  const cutoff = Math.max(...d.fresh.map((id) => remarkEnd.get(id)!));
  const seen = unsent.filter((h) => h.seq < d.screenCount);
  const out = seen.filter((h) => {
    const j = judged.get(h.seq);
    if (!j || j.error) return false;
    if (j.readyAt > t) { late.add(h.seq); return false; }
    return j.p! < MIN;
  });
  for (const h of out) dropped.add(h.seq);
  unsent = unsent.filter((h) => !out.includes(h));
  const cand = byStart(seen.filter((h) => !out.includes(h) && (h.start <= cutoff || (h.image !== null && h.image === carried))));
  const chosen = selectScreens(cand, carried, anchor, cutoff).slice(-SCREENS_MAX);
  carried = carriedOf(cand, new Set(chosen.flatMap((c) => (c.image === null ? [] : [c.image]))));
  anchor = anchorAfter(chosen, anchor);
  ref = chosen.findLast((h) => h.image !== null)?.image ?? ref;
  unsent = unsent.filter((h) => !cand.includes(h) || (carried !== undefined && h.image === carried));
  attached.push(...chosen);
  // 規則 B の後: 持ち越しになった画面は、この時点で裏で聞く（次に添えうるのは起点 + 10 秒の後）
  if (mode === "gated" && carried !== undefined) { const h = unsent.find((x) => x.image === carried); if (h) await ask(h, t); }
}

const js = [...judged.values()], ok = js.filter((j) => j.p !== undefined);
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) : null; };
const hours = (TO - FROM) / 3600, win = attached.filter(inWin).length, tokens = ok.reduce((a, j) => a + (j.tokens ?? 0), 0);
console.log(JSON.stringify({ mode, model, min: MIN, nth: NTH, attachedWin: win, attachedAll: attached.filter((h) => h.image).length,
  judged: js.length, errors: js.length - ok.length, late: late.size, dropped: dropped.size,
  imageUsdPerH: +(win * IMAGE_USD / hours).toFixed(3), judgeUsdPerH: +(tokens * TOKEN_USD / hours).toFixed(3),
  totalUsdPerH: +((win * IMAGE_USD + tokens * TOKEN_USD) / hours).toFixed(3), p50: q(ok.map((j) => j.ms), 0.5), p90: q(ok.map((j) => j.ms), 0.9), max: q(ok.map((j) => j.ms), 1) }));
