// PROTOTYPE（#879、使い捨て）— 文の終わりで発言にする規則に「文の終わりが出てから N ミリ秒、そこまでの本文が変わらなければ切る」を足し、
// 出した後の書き換えと、話し終わり → 発言の遅れの釣り合いを見る。#763 の sim.mjs（prototype/763-judge-cut）から、Jev と話者の規則を外して作った。
// Claude は呼ばない。
//
// node sim.mjs <stt.jsonl> <timeline.tsv> [--holds 0,300,500,1000] [--emit <N ミリ秒> <out.json>]
// KINDS=1 で書き換えの種類を標準エラーに出す。CARRY=0 で、開き直したときの引き継ぎを外す（#763 の試作と同じ動き）
import { readFileSync, writeFileSync } from "node:fs";
import { createRemarkGate } from "../../src/core/remarkGate.ts";

const args = process.argv.slice(2);
const [sttPath, tlPath] = args;
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const HOLDS = opt("--holds", "0,300,500,1000").split(",").map(Number);
const QUIET = 1; // いまの規則（SETTLE_QUIET_MS）。どの規則もこれを土台に持つ

const results = readFileSync(sttPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).sort((a, b) => a.arrival - b.arrival);
const lines = readFileSync(tlPath, "utf8").trim().split("\n").filter((l) => !l.startsWith("#"))
  .map((l) => { const [speaker, s, e, text] = l.split("\t"); return { speaker, start: +s, end: +e, text }; });

const SENT_END = /[。？！?!]/g;
// 書き換えの種類（本文は出さず、種類・編集距離・出してからの秒だけを数える）
const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
function kindOf(sent, now, after) {
  const head = now.slice(0, sent.length);
  const endKept = /[。？！?!]/.test(head.at(-1) ?? "");
  const dist = lev(sent, head);
  // 文の終わりの位置に記号が無くなった＝切った位置が文の途中になった
  const kind = !endKept ? (/[。？！?!]/.test(now.slice(sent.length - 3, sent.length + 3)) ? "記号の位置がずれた" : "文の終わりが取り消された") : "文の中の字が変わった";
  return { kind, dist, after };
}

// hold: null ならいまの規則だけ。数値（秒）なら、文の終わり c までの本文 text[0..c) が hold 秒変わらなかったときに c で切る
function simulate(hold) {
  const out = [];
  const utt = new Map(); // track+start → 発話
  let rewritten = 0; const kinds = []; let reopened = 0;

  const timeAt = (u, c) => (u.hist.find((h) => h.len >= c) ?? u.hist.at(-1)).end;
  const emit = (u, c, at, why) => {
    if (c <= u.sent) return;
    u.sentText = u.text.slice(0, c); u.sentAt = at;
    const end = timeAt(u, c);
    out.push({ track: u.track, start: u.cutAt, end: Math.max(end, u.cutAt), text: u.text.slice(u.sent, c), at, why });
    u.sent = c; u.cutAt = end;
  };
  // 時刻 now までに期限が来たものを、期限の時刻で出す（本番ではタイマーで出す）
  const flushDue = (now) => {
    for (const u of utt.values()) {
      if (u.done) continue;
      for (const k of [...u.pending.keys()].sort((a, b) => a - b)) {
        const p = u.pending.get(k);
        if (p.since + hold <= now) { emit(u, k, p.since + hold, "hold"); u.pending.delete(k); }
      }
      if (u.last + QUIET < now) { emit(u, u.text.length, u.last + QUIET, "quiet"); u.done = true; }
    }
  };

  for (const r of results) {
    flushDue(r.arrival);
    const key = `${r.track}\u0000${r.start}`;
    if (r.isFinal) {
      for (const u of utt.values()) if (!u.done && u.track === r.track && u.start <= r.end) { emit(u, u.text.length, r.arrival, "final"); u.done = true; }
      continue;
    }
    let u = utt.get(key);
    if (!u || u.done) {
      const prev = u;
      if (prev) reopened++;
      u = { track: r.track, start: r.start, cutAt: r.start, text: "", sent: 0, last: r.arrival, hist: [], done: false, pending: new Map() };
      // 1 秒止まって出した後に同じ start の続きが来たら、同じ発話で出した所までを引き継ぐ（CARRY=0 で外す。外すと、関所が直前の 1 文としか比べず全文がもう一度出る）
      if (prev && process.env.CARRY !== "0") Object.assign(u, { cutAt: prev.cutAt, sent: prev.sent, sentText: prev.sentText, sentAt: prev.sentAt, hist: prev.hist, flagged: prev.flagged });
      utt.set(key, u);
    }
    // 出した後に、出した分の本文が書き換わった（発言は書き換えないので、ずれたまま残る）
    if (u.sentText && !r.text.startsWith(u.sentText) && !u.flagged?.has(u.sent)) { (u.flagged ??= new Set()).add(u.sent); rewritten++; kinds.push(kindOf(u.sentText, r.text, r.arrival - u.sentAt)); }
    u.text = r.text; u.last = r.arrival; u.hist.push({ len: r.text.length, end: r.end });

    if (hold === null) continue;
    // 待っている文の終わりのうち、そこまでの本文が変わったものは取り下げる（新しい本文で見つかれば、その時刻から数え直す）
    for (const [k, p] of u.pending) if (r.text.slice(0, k) !== p.prefix) u.pending.delete(k);
    for (const m of r.text.matchAll(SENT_END)) {
      const c = m.index + 1;
      if (c > u.sent && !u.pending.has(c)) u.pending.set(c, { prefix: r.text.slice(0, c), since: r.arrival });
    }
    if (hold === 0) flushDue(r.arrival);
  }
  flushDue(Infinity);
  out.sort((a, b) => a.at - b.at);
  const gate = createRemarkGate();
  const gated = out.flatMap((r) => { const g = gate.pass(r); return g ? [{ ...g, at: r.at, why: r.why }] : []; });
  if (process.env.KINDS) console.error(hold, '同じ start で開き直した', reopened, '関所の前', out.length, '後', gated.length);
  return { remarks: gated, rewritten, kinds };
}

// 数え方は #763 と同じ: 行の話し終わりの 0.3 秒前を含む最初の発言が出た時刻 − 行の end
const pct = (v, p) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const f1 = (x) => (Number.isNaN(x) ? "-" : x.toFixed(1));
function measure(remarks) {
  const d = [];
  for (const l of lines) {
    const t = l.end - 0.3;
    const r = remarks.filter((a) => a.start <= t && t <= a.end + 1).sort((a, b) => a.at - b.at)[0];
    if (r) d.push(r.at - l.end);
  }
  return { p50: pct(d, 0.5), p90: pct(d, 0.9), n: remarks.length, short: remarks.filter((r) => r.text.length < 8).length };
}

// 台本との文字誤り率（記号と空白を除く）。確定結果だけを並べたときと比べ、書き換えで本文が重なった・欠けた分を見る
const norm = (t) => t.replace(/[\s。、？！?!「」『』（）()・…,.]/g, "");
function cer(hyp, ref) {
  let prev = new Int32Array(hyp.length + 1).map((_, j) => j), cur = new Int32Array(hyp.length + 1);
  for (let i = 1; i <= ref.length; i++) { cur[0] = i; for (let j = 1; j <= hyp.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)); [prev, cur] = [cur, prev]; }
  return prev[hyp.length] / ref.length;
}
const REF = norm(lines.map((l) => l.text).join(""));
const textCer = (texts) => { const h = norm(texts.join("")); return `${(cer(h, REF) * 100).toFixed(1)}%（${h.length - REF.length >= 0 ? "+" : ""}${h.length - REF.length} 字）`; };
console.log(`確定結果だけ: CER ${textCer(results.filter((r) => r.isFinal).map((r) => r.text))}`);
const table = [["規則", "話し終わり → 発言 p50 / p90（秒）", "発言", "8 字未満", "出した後の書き換え", "CER（台本との字数の差）"]];
for (const hold of [null, ...HOLDS.map((ms) => ms / 1000)]) {
  const sim = simulate(hold);
  const m = measure(sim.remarks);
  const pctOf = (x) => `${x}（${((x / m.n) * 100).toFixed(1)}%）`;
  if (process.env.KINDS && sim.kinds.length) { const c = {}; for (const k of sim.kinds) c[k.kind] = (c[k.kind] ?? 0) + 1; console.error(hold, JSON.stringify(c), "距離", sim.kinds.map((k) => k.dist).sort((a, b) => a - b).join(","), "出してからの秒", sim.kinds.map((k) => k.after.toFixed(1)).sort((a, b) => a - b).join(",")); }
  table.push([hold === null ? "いま（1 秒変わらなければ）" : `文の終わり N=${hold * 1000}`, `${f1(m.p50)} / ${f1(m.p90)}`, m.n, pctOf(m.short), pctOf(sim.rewritten), textCer(sim.remarks.map((r) => r.text))]);
}
// --emit <N ミリ秒> <out.json>: その規則の発言を m761.ts（prototype/763-judge-cut）に渡す形で書く
const emitAt = opt("--emit", null);
if (emitAt !== null) {
  const sim = simulate(Number(emitAt) / 1000);
  writeFileSync(args[args.indexOf("--emit") + 2], JSON.stringify(sim.remarks.map(({ why, ...r }, i) => ({ id: `r${i + 1}`, ...r, source: "stable" }))));
}
console.log(table.map((r) => `| ${r.join(" | ")} |`).join("\n"));
