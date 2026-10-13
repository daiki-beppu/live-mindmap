// PROTOTYPE（#763、使い捨て）— 途中結果から発言を切る規則を差し替えて、話し終わり → 発言の遅れと発言の数を比べる。
// 入力: stt-bench run の JSONL と、合成会議の timeline.tsv（話者・行の時刻）。
// 出力: 規則ごとの表と、_m761.ts に渡せる発言（--emit <規則> <out.json>）。
// Jev の答えは cache.json に貯める（同じ問いは 2 度投げない）。鍵は TYPESAFE_API_KEY（op run で渡す）。
//
// node sim.mjs <stt.jsonl> <timeline.tsv> [--diar 0.5] [--emit <rule> <out.json>]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRemarkGate } from "../../src/core/remarkGate.ts";

const args = process.argv.slice(2);
const [sttPath, tlPath] = args;
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const DIAR = Number(opt("--diar", "0.5")); // 話者の交代を知るまでの遅れ（秒）の仮定
const QUIET = 1;
const CACHE = new URL("./cache.json", import.meta.url);
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};

const results = readFileSync(sttPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).sort((a, b) => a.arrival - b.arrival);
const lines = readFileSync(tlPath, "utf8").trim().split("\n").filter((l) => !l.startsWith("#"))
  .map((l) => { const [speaker, s, e, text] = l.split("\t"); return { speaker, start: +s, end: +e, text }; });
// 話者が替わった時刻（次の行の始まり）
const changes = lines.slice(1).map((l, i) => (l.speaker !== lines[i].speaker ? l.start : null)).filter((t) => t !== null);

const SENT_END = /[。？！?!]/g;

// ---- Jev: 「ここで切ってよいか」を yes-no で聞く -------------------------------------------------
async function jevCut(context, head, tail) {
  const key = `${context}\u0001${head}\u0001${tail}`;
  if (cache[key]) return cache[key];
  const state = ["# 直前の発言", context || "（なし）", "# 話している途中の文字列（｜が切る候補）", `${head}｜${tail}`].join("\n");
  const t0 = performance.now();
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "jev-latest", state,
      questions: {
        cut: {
          type: "noul",
          instructions: "会議の文字起こしで、｜より前は、話し手が言い終えたひとまとまりの話か。｜の後ろが同じ文や同じ考えの続きなら false",
          criteria: { true: "｜の前で話がひとまとまり言い終わっている", false: "｜の前は話の途中で、後ろに続きがある" },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Jev ${res.status}: ${await res.text()}`);
  const b = await res.json();
  const ans = { p: b.answers.cut.noul, ms: performance.now() - t0, tokens: b.usage?.input_tokens ?? 0 };
  cache[key] = ans;
  return ans;
}

// ---- 規則 -----------------------------------------------------------------------------------
// どの規則も、いまの規則（途中結果が 1 秒変わらなければ残りを出す）を土台に持ち、その上で早く切る位置を足す。
//   quiet:        いまの規則だけ
//   punct:        途中結果に文の終わり（。？！）が現れたら、そこまでを出す
//   speaker:      話者が替わった時刻（正解）を DIAR 秒後に知り、そこで切る。話者分離（#610）が入った後の姿の見積もり
//   speaker+punct / speaker+jev: speaker に加えて、同じ話者の中の文の終わりで切る（jev は Jev が「言い終えた」と答えたときだけ）
async function simulate(rule) {
  const out = [];
  const utt = new Map(); // track+start → 発話
  const useSpeaker = rule.startsWith("speaker");
  const usePunct = rule === "punct" || rule === "speaker+punct";
  const useJev = rule === "speaker+jev" || rule === "jev";
  let rewritten = 0, jevCalls = 0, jevMs = [], jevTokens = 0;
  const lastText = () => out.at(-1)?.text ?? "";

  // 文字位置 c が最初に現れた途中結果の end（その文字までの音声の時刻の見積もり）
  const timeAt = (u, c) => (u.hist.find((h) => h.len >= c) ?? u.hist.at(-1)).end;
  const emit = (u, c, at, why) => {
    if (c <= u.sent) return;
    u.sentText = u.text.slice(0, c);
    const end = timeAt(u, c);
    out.push({ track: u.track, start: u.cutAt, end: Math.max(end, u.cutAt), text: u.text.slice(u.sent, c), at, source: "stable", why });
    u.sent = c; u.cutAt = end;
  };
  const flushQuiet = (now) => {
    for (const u of utt.values()) if (!u.done && u.last + QUIET < now) { emit(u, u.text.length, u.last + QUIET, "quiet"); u.done = true; }
  };

  for (const r of results) {
    flushQuiet(r.arrival);
    const key = `${r.track}\u0000${r.start}`;
    if (r.isFinal) {
      // 確定結果: まだ出していない分を届いた時刻に出して閉じる（本文は途中結果のものを使う）
      for (const u of utt.values()) if (!u.done && u.track === r.track && (u.start + u.last) >= 0 && u.start <= r.end) { emit(u, u.text.length, r.arrival, "final"); u.done = true; }
      continue;
    }
    let u = utt.get(key);
    if (!u || u.done) {
      u = { track: r.track, start: r.start, cutAt: r.start, text: "", sent: 0, last: r.arrival, hist: [], done: false, asked: new Set() };
      utt.set(key, u);
    }
    // 書き換えで、出した分より前が変わっても、出した文字数のところから後ろを新しい発言にする（いまの規則と同じ割り切り）
    // 出した後に、出した分の本文が書き換わった（発言は書き換えないので、ずれたまま残る）
    if (u.sentText && !r.text.startsWith(u.sentText) && !u.flagged?.has(u.sent)) { (u.flagged ??= new Set()).add(u.sent); rewritten++; }
    u.text = r.text; u.last = r.arrival; u.hist.push({ len: r.text.length, end: r.end });

    // 話者の交代: 交代の時刻を DIAR 秒過ぎた最初の途中結果で、交代の時刻に一番近い文の終わり（無ければ見積もった位置）で切る
    if (useSpeaker) {
      for (const t of changes) {
        if (t <= u.cutAt || t + DIAR > r.arrival || t > r.end + 1) continue;
        if (u.asked.has(`s${t}`)) continue;
        u.asked.add(`s${t}`);
        const est = (u.hist.find((h) => h.end >= t) ?? u.hist.at(-1)).len;
        let best = null;
        for (const m of r.text.matchAll(SENT_END)) { const c = m.index + 1; if (c > u.sent && (best === null || Math.abs(c - est) < Math.abs(best - est))) best = c; }
        emit(u, best ?? est, r.arrival, "speaker");
      }
    }
    // 文の終わり
    if (usePunct || useJev) {
      const ends = [...r.text.matchAll(SENT_END)].map((m) => m.index + 1).filter((c) => c > u.sent);
      for (const c of ends) {
        if (usePunct) { emit(u, c, r.arrival, "punct"); continue; }
        if (u.asked.has(c)) continue;
        u.asked.add(c);
        const ans = await jevCut(lastText().slice(-80), r.text.slice(u.sent, c), r.text.slice(c));
        jevCalls++; jevMs.push(ans.ms); jevTokens += ans.tokens;
        if (ans.p >= 0.5) emit(u, c, r.arrival + ans.ms / 1000, "jev");
      }
    }
  }
  flushQuiet(Infinity);
  out.sort((a, b) => a.at - b.at);
  // 本番と同じ関所（出した本文と重なる分は出さない）を、出す順に通す
  const gate = createRemarkGate();
  const gated = out.flatMap((r) => { const g = gate.pass(r); return g ? [{ ...g, at: r.at, source: r.source, why: r.why }] : []; });
  return { remarks: gated.map((r, i) => ({ id: `r${i + 1}`, ...r })), rewritten, jevCalls, jevMs, jevTokens };
}

// ---- 集計（tail.mjs と同じ数え方: 行の区間の中央を覆う最初の発言が出た時刻 − 行の end）---------------------
const pct = (v, p) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const f1 = (x) => (Number.isNaN(x) ? "-" : x.toFixed(1));
function measure(remarks) {
  const rows = [];
  for (const [i, l] of lines.entries()) {
    // 行の話し終わりの直前（end − 0.3 秒）を含む最初の発言。1 行に文が複数あっても、最後の文が出るまでを数える
    const tEnd = l.end - 0.3;
    const r = remarks.filter((a) => a.start <= tEnd && tEnd <= a.end + 1).sort((a, b) => a.at - b.at)[0];
    if (!r) continue;
    const sameNext = i + 1 < lines.length && lines[i + 1].speaker === l.speaker;
    rows.push({ d: r.at - l.end, sameNext });
  }
  const d = rows.map((r) => r.d);
  const len = remarks.map((r) => r.end - r.start), chars = remarks.map((r) => r.text.length);
  return {
    lines: rows.length, p50: pct(d, 0.5), p90: pct(d, 0.9), neg: d.filter((x) => x < -0.5).length,
    // 次の行も同じ話者の行（話者分離が入っても縮まない部分）
    same50: pct(rows.filter((r) => r.sameNext).map((r) => r.d), 0.5), same90: pct(rows.filter((r) => r.sameNext).map((r) => r.d), 0.9), sameN: rows.filter((r) => r.sameNext).length,
    remarks: remarks.length, len50: pct(len, 0.5), chars50: pct(chars, 0.5), short: remarks.filter((r) => r.text.length < 8).length,
  };
}

const RULES = ["quiet", "punct", "speaker", "speaker+punct", "speaker+jev"];
const emitRule = opt("--emit", null);
const table = [["規則", "行", "遅れ p50", "p90", "同じ話者が続く行 p50 / p90（件）", "発言", "1 発言の秒 p50", "字 p50", "8 字未満", "出した後の書き換え", "Jev 呼び出し", "Jev ms p50 / p90"]];
for (const rule of emitRule ? [emitRule] : RULES) {
  if (rule.includes("jev") && !process.env.TYPESAFE_API_KEY) { console.error(`skip ${rule}: TYPESAFE_API_KEY なし`); continue; }
  const sim = await simulate(rule);
  const m = measure(sim.remarks);
  table.push([rule, m.lines, f1(m.p50), f1(m.p90), `${f1(m.same50)} / ${f1(m.same90)}（${m.sameN}）`, m.remarks, f1(m.len50), m.chars50, m.short, sim.rewritten,
    sim.jevCalls || "", sim.jevMs.length ? `${pct(sim.jevMs, 0.5).toFixed(0)} / ${pct(sim.jevMs, 0.9).toFixed(0)}` : ""]);
  if (emitRule) writeFileSync(args[args.indexOf("--emit") + 2], JSON.stringify(sim.remarks.map(({ why, ...r }) => r)));
  if (sim.jevCalls) console.error(`${rule}: Jev 入力トークン ${sim.jevTokens}`);
}
writeFileSync(CACHE, JSON.stringify(cache));
console.log(table.map((r) => `| ${r.join(" | ")} |`).join("\n"));
