// #764 の試作（使い捨て）: 途中結果から「いまどのノードの話か」を Jev に聞き、Claude が実際に触ったノードと比べる。
// 使い方: op run --env-file=.env.op -- node measure.mjs <途中結果.jsonl> <m761 の out.json> <out.json>
// 入力は #763 の試作（prototype/763-judge-cut）が残した途中結果と、それを Claude まで流したセッション。
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [interimPath, runPath, outPath] = process.argv.slice(2);
const MIN_CHARS = 15; // 途中結果がこの字数を超えたら聞き始める
const REASK = 1.0; // 以後、文字が変わっていればこの秒数ごとに聞き直す
const RECENT = 2; // state に入れる直前の発言の数
const TOPICS = process.env.TOPICS === "1"; // 選択肢とマップの一覧を議題・論点だけに絞る

const cachePath = new URL(process.env.TOPICS === "1" ? "./cache-topics.json" : "./cache.json", import.meta.url).pathname;
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};

// ---- セッションから、時刻ごとのマップと「発言ごとに Claude が触ったノード」を作る ----
const run = JSON.parse(readFileSync(runPath, "utf8"));
const log = readFileSync(`${run.dir}/log.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const diffs = log.filter((l) => l.type === "diff");
if (diffs.length !== run.calls.filter((c) => c.ok).length) throw new Error("diff と呼び出しの数が合わない");
const okCalls = run.calls.filter((c) => c.ok);

const nodes = new Map([["root", { id: "root", kind: "会議", text: "会議", parent: null, born: 0 }]]);
let counter = 0;
const touchedByRemark = new Map(); // remark id → { at: 反映の時刻, nodes: Set（光らせて当たりのノード） , added: [] }
diffs.forEach((d, i) => {
  const at = run.diffEnds[i];
  const refs = new Map();
  const existed = new Set(nodes.keys()); // この差分の前からあったノード
  const hit = new Set();
  const resolveExisting = (id) => {
    // 同じ差分で足したノードなら、前からある祖先まで上る。root は光らせる先にならない
    let cur = id;
    while (cur && !existed.has(cur)) cur = nodes.get(cur)?.parent;
    return cur && cur !== "root" ? cur : null;
  };
  for (const op of d.ops) {
    if (op.op === "add") {
      const id = `n${++counter}`;
      refs.set(op.ref, id);
      const parent = refs.get(op.parent) ?? op.parent;
      nodes.set(id, { id, kind: op.kind, text: op.text, parent, born: at });
      const p = resolveExisting(parent);
      if (p) hit.add(p);
    } else if (op.op === "update") {
      const n = nodes.get(op.node);
      if (n) { if (existed.has(op.node)) hit.add(op.node); n.text = op.text; }
    } else if (op.op === "close") {
      if (existed.has(op.node)) hit.add(op.node);
    }
  }
  for (const r of okCalls[i].fresh) touchedByRemark.set(r, { at, nodes: hit, noop: d.ops.every((o) => o.op === "noop") });
});

// 時刻 t に見えているマップ（反映が t 以前の add だけ。文はその時点の版にはしない: 試作の簡略化）
const outlineAt = (t) => {
  const alive = [...nodes.values()].filter((n) => n.id !== "root" && n.born <= t && (!TOPICS || n.kind === "議題" || n.kind === "論点"));
  const depth = (n) => { let k = 0, c = n; while (c.parent && c.parent !== "root") { k++; c = nodes.get(c.parent); } return k; };
  return alive.map((n) => ({ id: n.id, line: `${"  ".repeat(depth(n))}${n.kind}: ${n.text}` }));
};

// ---- 途中結果を区間ごとにまとめ、聞く時刻を決める ----
const interim = readFileSync(interimPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const segs = new Map();
for (const e of interim) {
  const k = `${e.track}@${e.start}`;
  if (!segs.has(k)) segs.set(k, { track: e.track, start: e.start, updates: [] });
  segs.get(k).updates.push(e);
}
const items = run.items; // 発言（at: 発言になった時刻）
// 1 つの区間から発言が何本も切り出される（1 秒変わらなければ、そこまでを発言にする）。
// 区間の途中で発言が出たら、それより後に増えた文字だけを「いま話している」とみなし、次に出る発言の話として聞く
const queries = [];
for (const seg of segs.values()) {
  let lastAt = -Infinity, lastNew = "", emittedLen = 0, emittedUpTo = -Infinity;
  let prevText = "";
  for (const u of seg.updates) {
    const emitted = items.filter((r) => r.track === seg.track && r.at <= u.arrival && r.at > emittedUpTo && r.end > seg.start);
    if (emitted.length) { emittedLen = prevText.length; emittedUpTo = Math.max(...emitted.map((r) => r.at)); }
    prevText = u.text;
    const fresh = u.text.slice(emittedLen);
    if (fresh.length < MIN_CHARS || fresh === lastNew || u.arrival - lastAt < REASK) continue;
    const remark = items.find((r) => r.track === seg.track && r.at > u.arrival);
    queries.push({ at: u.arrival, text: fresh.slice(-100), remark: remark?.id ?? null, end: u.end, segStart: seg.start });
    lastAt = u.arrival; lastNew = fresh;
  }
}
queries.sort((a, b) => a.at - b.at);

const recentBefore = (t) => items.filter((r) => r.at <= t).slice(-RECENT).map((r) => r.text.slice(-120));

async function ask(q) {
  const outline = outlineAt(q.at);
  const criteria = Object.fromEntries(outline.map((n) => [n.id, n.line.trim()]));
  criteria.new = "マップのどのノードにも当てはまらない新しい話";
  criteria.none = "会議の中身ではない（挨拶・進行・相づち・雑談）";
  const state = ["# 現在のマップ", outline.map((n) => `[${n.id}] ${n.line}`).join("\n") || "（まだ空）", "# 直前の発言", ...recentBefore(q.at), "# いま話している途中の文字列", q.text].join("\n");
  const key = state;
  if (cache[key]) return cache[key];
  const t0 = performance.now();
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "jev-latest", state,
      questions: { target: { type: "choice", instructions: "いま話している途中の文字列は、現在のマップのどのノードの話か", criteria } },
    }),
  });
  if (!res.ok) throw new Error(`Jev ${res.status}: ${await res.text()}`);
  const b = await res.json();
  const a = { choice: b.answers.target.choice, conf: b.answers.target.confidence, ms: performance.now() - t0, tokens: b.usage?.input_tokens ?? 0, size: outline.length };
  cache[key] = a;
  return a;
}

// 並べて聞く（各問いの state は時刻で決まっているので、順番に依らない）
const answers = new Array(queries.length);
let next = 0, done = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < queries.length) {
    const i = next++;
    for (let tries = 0; ; tries++) {
      try { answers[i] = await ask(queries[i]); break; } catch (e) { if (tries >= 3) throw e; await new Promise((r) => setTimeout(r, 1000 * (tries + 1))); }
    }
    if (++done % 50 === 0) { writeFileSync(cachePath, JSON.stringify(cache)); process.stderr.write(`${done}/${queries.length}\n`); }
  }
}));
writeFileSync(cachePath, JSON.stringify(cache));

const rows = queries.map((q, i) => {
  const t = q.remark ? touchedByRemark.get(q.remark) : undefined;
  return { ...q, ...answers[i], truth: t ? [...t.nodes] : null, reflectAt: t?.at ?? null, noop: t?.noop ?? null };
});
writeFileSync(outPath, JSON.stringify({ run: runPath, interim: interimPath, rows, nodes: [...nodes.values()] }));
console.error(`queries ${rows.length} → ${outPath}`);
