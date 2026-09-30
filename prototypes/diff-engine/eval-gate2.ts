// PROTOTYPE — 判定の構造を組み直した Jev ゲートの評価。Claude は呼ばない。
// v1（eval-gate.ts）との違い: state に会議の目的と現在のマップを入れる / 「中身があるか」の代わりに役割を選ばせる /
// 話題の区切りは聞かず target の変化から導く。
// 使い方: op run --env-file=.env.op -- bun eval-gate2.ts
import { writeFileSync } from "node:fs";
import { emptyMap, renderOutline, ROOT, issueStatus, type MindMap, type Segment } from "./map";

const ROLES = {
  idea: "新しい案やアイデアを出している",
  issue: "問題や懸念を指摘している",
  question: "答えを出すべき問いを立てている",
  decision: "結論や決定を述べている",
  todo: "誰かが後でやる作業を決めている",
  elaboration: "すでに出ている話の理由・具体例・補足を述べている",
  facilitation: "挨拶・進行・段取り・時間の確認",
  chitchat: "雑談・脱線・相づち・番組の解説",
};
const NOISE = ["facilitation", "chitchat"];

// ラベル: ファシリテーター会議は Sonnet の 1 発言ごとの判断、ブレストはゲートなし batch2 で根拠になった発言
const SAMPLES = [
  { run: "runs/facilitators-meeting__claude-sonnet-5-5__batch1.json", purpose: "テーマ「OJT 受け入れをもっとうまくいかせるには」を議論する社内会議", label: "changed" as const },
  { run: "runs/silly-app-brainstorm__claude-sonnet-5-5__batch2.json", purpose: "おバカなアプリのアイデアを 1 人ずつ発表し、周りが突っ込むブレスト会議", label: "evidence" as const },
];

function nodeCriteria(map: MindMap): Record<string, string> {
  const c: Record<string, string> = {};
  for (const id of map.order) {
    if (id === ROOT) continue;
    const n = map.nodes[id]!;
    c[id] = `${n.kind}${n.kind === "論点" ? `(${issueStatus(map, id)})` : ""}: ${n.text}`;
    if (Object.keys(c).length >= 250) break;
  }
  c.new = "マップのどのノードにも当てはまらない新しい話";
  c.none = "会議の中身ではない（挨拶・進行・相づち・雑談・解説）";
  return c;
}

async function ask(purpose: string, map: MindMap, recent: Segment[], seg: Segment) {
  const state = ["# 会議の目的", purpose, "# 現在のマップ", renderOutline(map), "# 直前の発言", ...recent.map((s) => s.text), "# 新しい発言", seg.text].join("\n");
  const t0 = Date.now();
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "jev-latest", state,
      questions: {
        role: { type: "choice", instructions: "会議の目的に照らして、新しい発言の主な役割はどれか", criteria: ROLES },
        target: { type: "choice", instructions: "新しい発言は、現在のマップのどのノードに最も関係するか", criteria: nodeCriteria(map) },
      },
    }),
  });
  if (!res.ok) throw new Error(`Jev ${res.status}: ${await res.text()}`);
  const b = (await res.json()) as any;
  return {
    role: b.answers.role.choice as string, noise: NOISE.reduce((t, k) => t + (b.answers.role.probabilities?.[k] ?? 0), 0),
    target: b.answers.target.choice as string, targetConf: b.answers.target.confidence as number,
    ms: Date.now() - t0, tokens: b.usage?.input_tokens ?? 0,
  };
}

const out: any[] = [];
for (const sample of SAMPLES) {
  const run = await Bun.file(sample.run).json();
  const segs: Segment[] = run.segments;
  const used = new Set(Object.values(run.steps.at(-1).map.nodes).flatMap((n: any) => n.evidence));
  const rows: any[] = [];
  let prevTarget = "";
  for (const [si, step] of run.steps.entries()) {
    const before: MindMap = si === 0 ? emptyMap() : run.steps[si - 1].map; // その発言が届いた時点のマップ
    const changed = step.results.some((r: any) => r.ok && r.op.op !== "noop");
    for (const id of step.segIds) {
      const i = segs.findIndex((s) => s.id === id);
      const a = await ask(sample.purpose, before, segs.slice(Math.max(0, i - 3), i), segs[i]!);
      rows.push({ id, positive: sample.label === "changed" ? changed : used.has(id), shift: prevTarget !== "" && a.target !== prevTarget, ...a });
      if (a.target !== "none") prevTarget = a.target;
    }
  }
  out.push({ sample: sample.run, rows });
  const pos = rows.filter((r) => r.positive).length;
  console.log(`\n== ${sample.run.split("/")[1]}  発言 ${rows.length}・正例 ${pos}・Jev p50 ${rows.map((r) => r.ms).sort((a, b) => a - b)[rows.length >> 1]}ms・入力平均 ${Math.round(rows.reduce((t, r) => t + r.tokens, 0) / rows.length)} トークン`);
  const rep = (name: string, pred: (r: any) => boolean) => {
    const d = rows.filter(pred), m = d.filter((r) => r.positive).length;
    console.log(`${name.padEnd(28)} 捨てる ${String(d.length).padStart(3)} (${((d.length / rows.length) * 100).toFixed(0)}%)  取りこぼし ${m}/${pos} (${((m / pos) * 100).toFixed(0)}%)`);
  };
  rep("role が進行・雑談", (r) => NOISE.includes(r.role));
  for (const th of [0.5, 0.7, 0.9]) rep(`進行・雑談の確率 > ${th}`, (r) => r.noise > th);
  rep("target=none", (r) => r.target === "none");
  rep("role が進行・雑談 かつ target=none", (r) => NOISE.includes(r.role) && r.target === "none");
  const roles: Record<string, number> = {};
  for (const r of rows) roles[r.role] = (roles[r.role] ?? 0) + 1;
  console.log("role の分布", roles);
}
writeFileSync("runs-gate-eval2.json", JSON.stringify(out));
