// PROTOTYPE（#857、使い捨て）— 3 つのモデルに同じ問いを投げるための入力を作る。
// node prep.mjs → in/node.jsonl・in/role.jsonl・in/roles.json
// 入力は #764 の試作が残した合成会議 screen の判定（in/764.*、prototype/766-hints から写した）。
import { readFileSync, writeFileSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
const read = (f) => JSON.parse(readFileSync(`${here}in/${f}`, "utf8"));

// ---- どのノードの話か: #764 と同じ state・選択肢。正解は Claude がその発言で触ったノード ----
// 1 回 3〜4k トークン前後（2.5k〜4.5k）の全部と、どのノードにも関係しない（Claude が何も触らなかった）2.5k 未満の全部
const cache = read("764.cache.json");
const run764 = read("764.punct.json");
const byMs = new Map(Object.entries(cache).map(([state, v]) => [v.ms, state]));
const nodes = new Map(run764.nodes.map((n) => [n.id, n]));
const topicOf = (id) => { let c = nodes.get(id); while (c && c.kind !== "議題") c = nodes.get(c.parent); return c?.id ?? null; };
const nodeRows = [];
run764.rows.forEach((r, i) => {
  if (r.truth == null) return;
  const inBand = r.tokens >= 2500 && r.tokens <= 4500;
  const outside = r.truth.length === 0 && r.tokens < 2500;
  if (!inBand && !outside) return;
  const state = byMs.get(r.ms);
  const criteria = {};
  for (const line of state.split("\n")) { const m = line.match(/^\[(n\d+)\] (.*)$/); if (m) criteria[m[1]] = m[2].trim(); }
  criteria.new = "マップのどのノードにも当てはまらない新しい話";
  criteria.none = "会議の中身ではない（挨拶・進行・相づち・雑談）";
  nodeRows.push({
    id: `node${i}`, q: "node", state,
    instructions: "いま話している途中の文字列は、現在のマップのどのノードの話か",
    criteria, truth: r.truth, truthTopics: [...new Set(r.truth.map(topicOf).filter(Boolean))],
    jev764: { choice: r.choice, conf: r.conf, ms: r.ms, tokens: r.tokens },
  });
});

// ---- 役割 8 択（docs/knowledge/2026-09-30.md の 8 択）: screen の発言から等間隔に 150 本 ----
const ROLES = {
  idea: "新しい案（やり方・解決策の提案）",
  issue: "課題（困っていること・懸念・リスク）",
  question: "問い（誰かへの質問・確かめたいこと）",
  decision: "決定（決まったこと・合意・結論）",
  todo: "TODO（誰かがやること・依頼・引き受け・期限）",
  detail: "既存の話の補足（説明・理由・事実・意見の付け足し）",
  facilitation: "進行（議題の切り替え・時間・段取り）",
  chat: "雑談（挨拶・相づち・会議の中身と関係ない話）",
};
const items = read("764.screen.punct.out.json").items;
const N = 150, step = items.length / N;
const roleRows = [];
for (let k = 0; k < N; k++) {
  const i = Math.floor(k * step);
  const recent = items.slice(Math.max(0, i - 2), i).map((r) => r.text);
  const state = ["# 直前の発言", ...(recent.length ? recent : ["（なし）"]), "# 判定する発言", items[i].text].join("\n");
  roleRows.push({ id: `role${items[i].id}`, q: "role", remark: items[i].id, state, instructions: "会議の文字起こしで、「判定する発言」の役割はどれか", criteria: ROLES });
}

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
writeFileSync(`${here}in/node.jsonl`, jsonl(nodeRows));
writeFileSync(`${here}in/role.jsonl`, jsonl(roleRows));
// Claude に役割を付けてもらう一覧（label.mjs が読む）
writeFileSync(`${here}in/roles.json`, JSON.stringify(ROLES));
const empty = nodeRows.filter((r) => r.truth.length === 0).length;
console.error(`node ${nodeRows.length}（関係なし ${empty}）・role ${roleRows.length}`);
