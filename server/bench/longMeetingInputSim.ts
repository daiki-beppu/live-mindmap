// PROTOTYPE（issue #130 の試作。main には入れない）: 差分更新の入力の渡し方ごとの費用を、実走のログからオフラインで見積もる。
//   node bench/longMeetingInputSim.ts <longMeeting.ts の出力フォルダ> [--closeAfter <分>]
// log.jsonl を適用関数で流し直し、各呼び出しの直前のマップから、渡し方ごとのプロンプトを作る。
// query は QUERY_RENEW_CALLS 回ごとに開き直す前提で、会話の履歴（前の依頼と応答）をキャッシュから読み、今回の依頼と前回の応答を書き込むとして数える。
// 「済み」は試作では代わりの規則で決める: 現在の議題（直近の差分が当たった議題）以外で、配下に closeAfter 分以上根拠が足されていない議題。
// 本物は AI の「閉じる」で決める（ADR 0005）。ここでは費用の見積もりにだけ使う。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildPrompt, QUERY_RENEW_CALLS } from "../src/claude.ts";
import { applyOps, children, emptyMap, pointStatus, ROOT_ID, type MeetingMap, type Op, type Remark } from "../src/core/index.ts";

const { positionals, values } = parseArgs({ allowPositionals: true, options: { closeAfter: { type: "string", default: "10" } } });
const dir = positionals[0];
if (!dir) throw new Error("usage: node bench/longMeetingInputSim.ts <出力フォルダ> [--closeAfter <分>]");
const closeAfter = Number(values.closeAfter) * 60;

type Call = { at: number; error?: string; result?: { usage: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; output_tokens: number } } };
const calls: Call[] = readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const events = readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

// ---- 渡し方 ----
const nodeLine = (map: MeetingMap, id: string, depth: number) => {
  const n = map.nodes[id]!;
  const status = n.kind === "論点" ? `(${pointStatus(map, id)})` : n.planStatus === "却下" ? "(却下)" : "";
  return `${"  ".repeat(depth)}- ${n.id} ${n.kind}${status}: ${n.text}`;
};
const subtree = (map: MeetingMap, id: string, depth: number, out: string[]) => {
  out.push(nodeLine(map, id, depth));
  for (const c of children(map, id)) subtree(map, c.id, depth + 1, out);
};
const descendants = (map: MeetingMap, id: string): string[] => children(map, id).flatMap((c) => [c.id, ...descendants(map, c.id)]);

type Closed = (map: MeetingMap, topic: string) => string[];
// 済みの議題の渡し方 3 種
const closedStyles: Record<string, Closed> = {
  // 議題名だけ
  title: (map, t) => [nodeLine(map, t, 1) + "（済み）"],
  // 議題名と、決定・TODO・未決の論点だけ（親の論点も残す）
  outcomes: (map, t) => {
    const out = [nodeLine(map, t, 1) + "（済み）"];
    for (const p of children(map, t)) {
      const keep = descendants(map, p.id).map((id) => map.nodes[id]!).filter((n) => n.kind === "決定" || n.kind === "TODO");
      const pk = map.nodes[p.id]!;
      if (pk.kind === "論点" || keep.length || pk.kind === "TODO" || pk.kind === "決定") {
        out.push(nodeLine(map, p.id, 2));
        for (const k of keep) out.push(nodeLine(map, k.id, 3));
      }
    }
    return out;
  },
  // 要約文（オフラインでは作れないので、議題名＋ 80 字の要約が付くとして長さだけ数える）
  summary: (map, t) => [nodeLine(map, t, 1) + "（済み）", `    要約: ${"あ".repeat(80)}`],
};

function lastEvidenceAt(map: MeetingMap, id: string, remarks: Map<string, Remark>): number {
  let last = 0;
  for (const nid of [id, ...descendants(map, id)]) for (const e of map.nodes[nid]!.evidence) last = Math.max(last, remarks.get(e)?.end ?? 0);
  return last;
}

function outlineWithClosed(map: MeetingMap, closed: Set<string>, style: Closed): string {
  const lines = [nodeLine(map, ROOT_ID, 0)];
  for (const t of children(map, ROOT_ID)) {
    if (closed.has(t.id)) lines.push(...style(map, t.id));
    else subtree(map, t.id, 1, lines);
  }
  return lines.join("\n");
}

// 前回の呼び出しから変わったノードだけを出す（変更分だけ送る）。消えたノードは id だけ
function changedLines(before: MeetingMap, after: MeetingMap): string {
  const lines: string[] = [];
  for (const id of after.order) {
    const a = after.nodes[id]!, b = before.nodes[id];
    if (!b || a.text !== b.text || a.parent !== b.parent || a.planStatus !== b.planStatus) lines.push(`${nodeLine(after, id, 0)}（親 ${a.parent}）`);
  }
  for (const id of before.order) if (!after.nodes[id]) lines.push(`- ${id} 削除`);
  return lines.join("\n") || "（変更なし）";
}

// ---- 流し直し ----
type Turn = { at: number; prompts: Record<string, string>; output: number; error: boolean };
const remarks = new Map<string, Remark>();
const known = new Set<string>();
let map = emptyMap("parnassus");
let current: string | undefined; // 直近の差分が当たった議題
const turns: Turn[] = [];
let callIdx = 0;
const topicOf = (m: MeetingMap, id: string) => { let c = m.nodes[id]; while (c && c.parent && c.parent !== ROOT_ID) c = m.nodes[c.parent]; return c?.parent === ROOT_ID ? c.id : undefined; };
// 変更分だけ送る案は、その query の中で前回送ったときのマップとの差分を出す
let prevSent: MeetingMap | undefined;

for (const e of events) {
  if (e.type === "start") map = emptyMap(e.title);
  if (e.type === "remark") remarks.set(e.remark.id, e.remark);
  if (e.type !== "diff") continue;
  const call = calls[callIdx++];
  const fresh = e.input.fresh.map((id: string) => remarks.get(id)!);
  const recent = e.input.recent.map((id: string) => remarks.get(id)!);
  const now = fresh.at(-1)!.end;
  const base = buildPrompt({ map, recent, fresh });
  const head = base.slice(0, base.indexOf("## 現在のマップ"));
  const tail = base.slice(base.indexOf("## 直前の発言"));
  const closed = new Set(children(map, ROOT_ID).map((t) => t.id).filter((t) => t !== current && now - lastEvidenceAt(map, t, remarks) > closeAfter));
  const withOutline = (outline: string) => `${head}## 現在のマップ（ルートの ID: ${ROOT_ID}）\n${outline}\n\n${tail}`;
  const firstInQuery = (turns.length % QUERY_RENEW_CALLS) === 0;
  const diffPart = firstInQuery || !prevSent ? undefined : changedLines(prevSent, map);
  const prompts: Record<string, string> = { A_今の作り: base };
  for (const [name, style] of Object.entries(closedStyles)) prompts[`B_済み=${name}`] = withOutline(outlineWithClosed(map, closed, style));
  prompts["C_変更分だけ"] = diffPart === undefined ? base : `${head}## 前回からのマップの変更\n${diffPart}\n\n${tail}`;
  prompts["D_済み=outcomes+変更分"] = diffPart === undefined ? prompts["B_済み=outcomes"]! : prompts["C_変更分だけ"]!;
  turns.push({ at: now, prompts, output: call?.result?.usage.output_tokens ?? 0, error: !call?.result });
  prevSent = map;
  const next = (() => { for (const id of e.input.fresh) known.add(id); return applyOps(map, e.ops as Op[], known).map; })();
  // 今の議題: 今回の操作が当たった（足された・変わった）ノードの議題
  for (const id of next.order) {
    const b = map.nodes[id], a = next.nodes[id]!;
    if (!b || a.evidence.length !== b.evidence.length || a.text !== b.text) current = topicOf(next, id) ?? current;
  }
  map = next;
}

// ---- 費用 ----
// k（トークン/文字）と前置き S は、各 query の最初の呼び出しの実測から当てはめる
const tokIn = (c: Call) => c.result!.usage.input_tokens + c.result!.usage.cache_read_input_tokens + c.result!.usage.cache_creation_input_tokens;
const firsts = turns.map((t, i) => ({ t, c: calls[i]! })).filter((x, i) => i % QUERY_RENEW_CALLS === 0 && x.c.result);
const xs = firsts.map((x) => x.t.prompts.A_今の作り!.length), ys = firsts.map((x) => tokIn(x.c));
const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
const k = xs.reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0);
const S = my - k * mx;
// Sonnet 5.5 の定価（$/100 万トークン）。書き込みは 1 時間 TTL で入力の 2 倍、5 分 TTL で 1.25 倍
const P = { input: 2, read: 0.2, w1h: 4, w5m: 2.5, output: 10 };

type Cost = { read: number; write: number; output: number };
function simulate(name: string): Cost[] {
  const out: Cost[] = [];
  let hist = 0; // 会話の履歴（前の依頼と応答）のトークン
  let lastOut = 0;
  turns.forEach((t, i) => {
    if (i % QUERY_RENEW_CALLS === 0) { hist = 0; lastOut = 0; }
    const p = k * t.prompts[name]!.length;
    out.push({ read: S + hist, write: p + lastOut, output: t.output });
    hist += p + t.output;
    lastOut = t.output;
  });
  return out;
}
const dollars = (c: Cost, w: number) => (c.read * P.read + c.write * w + c.output * P.output) / 1e6;

const names = Object.keys(turns[0]!.prompts);
const end = Math.max(...turns.map((t) => t.at));
const lines: string[] = [];
lines.push(`呼び出し ${turns.length} 回、k = ${k.toFixed(3)} トークン/文字、前置き S ≈ ${Math.round(S)}、済みの代わりの規則: ${closeAfter / 60} 分`);
// 見積もりの当てはまり: A の見積もりと実測の比
const realCost = turns.map((_, i) => calls[i]?.result ? (calls[i]!.result!.usage.cache_read_input_tokens * P.read + (calls[i]!.result!.usage.cache_creation_input_tokens + calls[i]!.result!.usage.input_tokens) * P.w1h + calls[i]!.result!.usage.output_tokens * P.output) / 1e6 : 0);
const simA = simulate("A_今の作り").map((c) => dollars(c, P.w1h));
lines.push(`当てはまり: 今の作りの見積もり $${simA.reduce((a, b) => a + b, 0).toFixed(2)} / 実測（定価換算）$${realCost.reduce((a, b) => a + b, 0).toFixed(2)}`);
lines.push("");
lines.push(`| 渡し方 | TTL | ${Array.from({ length: Math.ceil(end / 3600) }, (_, h) => `${h}–${h + 1} 時間`).join(" | ")} | 合計 | 終盤 30 分の 1 回の入力（平均トークン） |`);
lines.push(`| --- | --- | ${Array(Math.ceil(end / 3600)).fill("---").join(" | ")} | --- | --- |`);
for (const name of names) {
  const sim = simulate(name);
  for (const [ttl, w] of [["1h", P.w1h], ["5m", P.w5m]] as const) {
    const hours = Array.from({ length: Math.ceil(end / 3600) }, (_, h) => sim.reduce((s, c, i) => (turns[i]!.at > h * 3600 && turns[i]!.at <= (h + 1) * 3600 ? s + dollars(c, w) : s), 0));
    const late = sim.filter((_, i) => turns[i]!.at > end - 30 * 60);
    lines.push(`| ${name} | ${ttl} | ${hours.map((h) => `$${h.toFixed(2)}`).join(" | ")} | $${hours.reduce((a, b) => a + b, 0).toFixed(2)} | ${Math.round(late.reduce((s, c) => s + c.write + c.read, 0) / late.length)} |`);
  }
}
// 終盤の 1 回分のプロンプトの見本
const sample = turns.at(-1)!;
lines.push("");
lines.push(`済みの議題の数（最後の呼び出し）: ${children(map, ROOT_ID).length} 議題中、代わりの規則で済み ${children(map, ROOT_ID).filter((t) => t.id !== current && end - lastEvidenceAt(map, t.id, remarks) > closeAfter).length}`);
for (const name of names) lines.push(`- ${name}: 終盤の 1 回のプロンプト ${sample.prompts[name]!.length} 文字`);
process.stdout.write(lines.join("\n") + "\n");
