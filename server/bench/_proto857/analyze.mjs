// PROTOTYPE（#857、使い捨て）— measure.mjs の答えを集計する。本文は出さない。
// node analyze.mjs [jev clef-flash clef]
import { readFileSync, existsSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
const models = process.argv.slice(2).length ? process.argv.slice(2) : ["jev", "clef-flash", "clef"];
const PRICE = { jev: 0.042, "clef-flash": 0.038, clef: 0.24 }; // 入力 100 万トークンあたりの $（出力は無料）
const lines = (p) => readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const rows = new Map([...lines(`${here}in/role.jsonl`), ...lines(`${here}in/node.jsonl`)].map((r) => [r.id, r]));
const roleTruth = JSON.parse(readFileSync(`${here}in/role.truth.json`, "utf8"));
const nodes = new Map(JSON.parse(readFileSync(`${here}in/764.punct.json`, "utf8")).nodes.map((n) => [n.id, n]));
const topicOf = (id) => { let c = nodes.get(id); while (c && c.kind !== "議題") c = nodes.get(c.parent); return c?.id ?? null; };
// 1 時間あたりの呼び出し数: screen（23 分）で、役割は発言ごと（772 本）、ノードは #764 の途中結果ごと（397 回）
const PER_HOUR = { role: (772 / 23) * 60, node: (397 / 23) * 60 };

const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%（${a}/${b}）` : "—");
const ms = (x) => (x == null ? "—" : `${Math.round(x)}`);

const data = Object.fromEntries(models.filter((m) => existsSync(`${here}out/${m}.jsonl`)).map((m) => [m, lines(`${here}out/${m}.jsonl`)]));
const answer = (m, id, order) => data[m]?.find((r) => r.id === id && r.order === order);

// 3 社がそろって答えた問いだけで比べる（枠切れで欠けた分を混ぜない）
const ids = [...rows.keys()].filter((id) => Object.keys(data).every((m) => answer(m, id, "fwd") && answer(m, id, "rev")));
const roleIds = ids.filter((id) => rows.get(id).q === "role");
const nodeIds = ids.filter((id) => rows.get(id).q === "node");
console.log(`3 社がそろった問い: 役割 ${roleIds.length}・ノード ${nodeIds.length}（うち関係なし ${nodeIds.filter((id) => !rows.get(id).truth.length).length}）\n`);

const out = [];
for (const m of Object.keys(data)) {
  const fwd = (id) => answer(m, id, "fwd").answer;
  const rev = (id) => answer(m, id, "rev").answer;
  const roleHit = roleIds.filter((id) => fwd(id).choice === roleTruth[id]).length;
  const key = roleIds.filter((id) => ["decision", "todo"].includes(roleTruth[id]));
  const keyHit = key.filter((id) => fwd(id).choice === roleTruth[id]).length;
  const keyFalse = roleIds.filter((id) => !["decision", "todo"].includes(roleTruth[id]) && ["decision", "todo"].includes(fwd(id).choice)).length;
  const inMap = nodeIds.filter((id) => rows.get(id).truth.length);
  const outside = nodeIds.filter((id) => !rows.get(id).truth.length);
  const nodeHit = inMap.filter((id) => rows.get(id).truth.includes(fwd(id).choice)).length;
  const topicHit = inMap.filter((id) => rows.get(id).truthTopics.includes(topicOf(fwd(id).choice))).length;
  const outsideHit = outside.filter((id) => ["new", "none"].includes(fwd(id).choice)).length;
  const flipped = (xs) => xs.filter((id) => fwd(id).choice !== rev(id).choice).length;
  const all = data[m].filter((r) => ids.includes(r.id));
  const t = (qq) => all.filter((r) => r.q === qq);
  const lat = (rs) => rs.map((r) => r.ms);
  const tok = (rs) => rs.reduce((s, r) => s + r.usage.input_tokens, 0) / (rs.length || 1);
  const perHour = PER_HOUR.role * tok(t("role")) + PER_HOUR.node * tok(t("node"));
  out.push({
    m, roleHit: pct(roleHit, roleIds.length), keyHit: pct(keyHit, key.length), keyFalse,
    nodeHit: pct(nodeHit, inMap.length), topicHit: pct(topicHit, inMap.length), outsideHit: pct(outsideHit, outside.length),
    flipRole: pct(flipped(roleIds), roleIds.length), flipNode: pct(flipped(nodeIds), nodeIds.length),
    role: lat(t("role")), node: lat(t("node")), tokRole: Math.round(tok(t("role"))), tokNode: Math.round(tok(t("node"))),
    cost: (perHour * PRICE[m]) / 1e6,
  });
}

console.log("## 精度（選択肢の順は「そのまま」）\n");
console.log("| モデル | 役割 8 択の一致 | うち決定・TODO | 決定・TODO でないのに決定・TODO | ノードの当たり | 議題単位の当たり | 関係なしを new/none |");
console.log("| --- | --- | --- | --- | --- | --- | --- |");
for (const o of out) console.log(`| ${o.m} | ${o.roleHit} | ${o.keyHit} | ${o.keyFalse} | ${o.nodeHit} | ${o.topicHit} | ${o.outsideHit} |`);
console.log("\n## 選択肢の順を逆にして答えが変わった問い\n");
console.log("| モデル | 役割 | ノード |\n| --- | --- | --- |");
for (const o of out) console.log(`| ${o.m} | ${o.flipRole} | ${o.flipNode} |`);
console.log("\n## 速さ（ms、手元から 1 問ずつ順に）\n");
console.log("| モデル | 役割 p50 / p90 / p99 / 最大 | ノード p50 / p90 / p99 / 最大 |\n| --- | --- | --- |");
for (const o of out) console.log(`| ${o.m} | ${[0.5, 0.9, 0.99].map((p) => ms(q(o.role, p))).join(" / ")} / ${ms(Math.max(...o.role))} | ${[0.5, 0.9, 0.99].map((p) => ms(q(o.node, p))).join(" / ")} / ${ms(Math.max(...o.node))} |`);
console.log("\n## トークンと費用（各社の usage で数えた入力。60 分あたりは screen の呼び出し頻度で、役割は発言ごと・ノードは途中結果ごと）\n");
console.log("| モデル | 役割 1 回 | ノード 1 回 | 60 分あたり |\n| --- | --- | --- | --- |");
for (const o of out) console.log(`| ${o.m} | ${o.tokRole} | ${o.tokNode} | $${o.cost.toFixed(3)} |`);
