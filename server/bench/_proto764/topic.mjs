// #764 の試作（使い捨て）: 光らせる単位を「議題・論点」に上げたときの当たり。node topic.mjs <out.json>...
import { readFileSync } from "node:fs";
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "-");
for (const path of process.argv.slice(2)) {
  const { rows, nodes } = JSON.parse(readFileSync(path, "utf8"));
  const N = new Map(nodes.map((n) => [n.id, n]));
  // 自分か祖先のうち、いちばん近い論点か議題（root の直下の会議全体の議題 n1 は除く）
  const up = (id, kinds) => { let c = N.get(id); while (c && !(kinds.includes(c.kind) && c.parent !== "root")) c = N.get(c.parent); return c?.id ?? null; };
  const isNode = (c) => c !== "new" && c !== "none";
  for (const [label, kinds] of [["論点か議題", ["論点", "議題"]], ["議題", ["議題"]]]) {
    for (const theta of [0, 0.7]) {
      const withT = rows.filter((r) => r.truth?.length);
      const shown = (r) => isNode(r.choice) && (r.conf ?? 0) >= theta && up(r.choice, kinds);
      const hit = withT.filter((r) => shown(r) && r.truth.some((t) => up(t, kinds) === up(r.choice, kinds))).length;
      const anyT = withT.filter((r) => r.truth.some((t) => up(t, kinds))).length;
      const shownN = withT.filter(shown).length;
      const noT = rows.filter((r) => r.truth && !r.truth.length);
      console.log(`${path} ${label} ≥${theta}: 光った ${shownN}/${withT.length} 回、そのうち当たり ${pct(hit, shownN)}（正解に${label}がある問い ${anyT}）／ 正解なしで光る ${pct(noT.filter(shown).length, noT.length)}`);
    }
  }
}
