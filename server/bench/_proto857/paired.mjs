// PROTOTYPE（#857、使い捨て）— 同じ問いで、片方だけ当たった数（勝ち・負け）と、時間のかかった呼び出しの時刻を数える。本文は出さない。
import { readFileSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
const L = (p) => readFileSync(`${here}${p}`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const rows = new Map([...L("in/role.jsonl"), ...L("in/node.jsonl")].map((r) => [r.id, r]));
const roleTruth = JSON.parse(readFileSync(`${here}in/role.truth.json`, "utf8"));
const nodes = new Map(JSON.parse(readFileSync(`${here}in/764.punct.json`, "utf8")).nodes.map((n) => [n.id, n]));
const topicOf = (id) => { let c = nodes.get(id); while (c && c.kind !== "議題") c = nodes.get(c.parent); return c?.id ?? null; };
const A = Object.fromEntries(["jev", "clef-flash", "clef"].map((m) => [m, new Map(L(`out/${m}.jsonl`).filter((r) => r.order === "fwd").map((r) => [r.id, r]))]));
const tests = {
  役割: (r, a) => r.q === "role" ? a.choice === roleTruth[r.id] : null,
  決定TODO: (r, a) => r.q === "role" && ["decision", "todo"].includes(roleTruth[r.id]) ? a.choice === roleTruth[r.id] : null,
  ノード: (r, a) => r.q === "node" && r.truth.length ? r.truth.includes(a.choice) : null,
  議題: (r, a) => r.q === "node" && r.truth.length ? r.truthTopics.includes(topicOf(a.choice)) : null,
  関係なし: (r, a) => r.q === "node" && !r.truth.length ? ["new", "none"].includes(a.choice) : null,
};
for (const [x, y] of [["jev", "clef"], ["jev", "clef-flash"], ["clef-flash", "clef"]]) {
  const parts = Object.entries(tests).map(([name, f]) => {
    let w = 0, l = 0;
    for (const r of rows.values()) { const a = f(r, A[x].get(r.id).answer), b = f(r, A[y].get(r.id).answer); if (a == null) continue; if (a && !b) w++; if (!a && b) l++; }
    return `${name} ${w}-${l}`;
  });
  console.log(`${x} 対 ${y}（${x} だけ当たり-${y} だけ当たり）: ${parts.join("・")}`);
}
for (const m of Object.keys(A)) {
  const all = L(`out/${m}.jsonl`);
  const slow = all.filter((r) => r.ms > 2000).map((r) => r.at.slice(11, 19));
  console.log(`${m}: 2 秒超 ${slow.length} 回 ${slow.join(" ")}（全 ${all.length} 回 ${all[0].at.slice(11, 19)}〜${all.at(-1).at.slice(11, 19)} UTC）`);
}
