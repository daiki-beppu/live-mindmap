// #764 の試作（使い捨て）: measure.mjs の結果を集計する。node analyze.mjs <out.json>...
import { readFileSync } from "node:fs";

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "-");
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };

for (const path of process.argv.slice(2)) {
  const { rows, nodes } = JSON.parse(readFileSync(path, "utf8"));
  const parent = new Map(nodes.map((n) => [n.id, n.parent]));
  const near = (a, truth) => truth.some((t) => parent.get(a) === t || parent.get(t) === a || (parent.get(a) && parent.get(a) === parent.get(t)));
  const isNode = (c) => c !== "new" && c !== "none";
  console.log(`\n## ${path}  （問い ${rows.length} 回、Jev p50 ${Math.round(q(rows.map((r) => r.ms), 0.5))}ms・p90 ${Math.round(q(rows.map((r) => r.ms), 0.9))}ms、入力 ${rows.reduce((t, r) => t + r.tokens, 0)} トークン）`);

  for (const theta of [0, 0.7, 0.9]) {
    const shown = (r) => isNode(r.choice) && (r.conf ?? 0) >= theta;
    const withT = rows.filter((r) => r.truth?.length);
    const noT = rows.filter((r) => r.truth && !r.truth.length);
    const hit = withT.filter((r) => shown(r) && r.truth.includes(r.choice)).length;
    const nearN = withT.filter((r) => shown(r) && !r.truth.includes(r.choice) && near(r.choice, r.truth)).length;
    const wrong = withT.filter((r) => shown(r) && !r.truth.includes(r.choice) && !near(r.choice, r.truth)).length;
    const quiet = withT.length - hit - nearN - wrong;
    const falseShow = noT.filter(shown).length;

    // 発言ごと: 発言になる直前の答え（9/30 と同じ「確定した 1 回」に近い）
    const byRemark = new Map();
    for (const r of rows) if (r.remark) byRemark.set(r.remark, r);
    const lastWithT = [...byRemark.values()].filter((r) => r.truth?.length);
    const lastHit = lastWithT.filter((r) => shown(r) && r.truth.includes(r.choice)).length;

    // 先取り: 正しく光った最初の時刻から、Claude の反映まで
    const firstHit = new Map();
    for (const r of rows) if (r.truth?.length && shown(r) && r.truth.includes(r.choice) && !firstHit.has(r.remark)) firstHit.set(r.remark, r);
    const leads = [...firstHit.values()].map((r) => r.reflectAt - (r.at + r.ms / 1000));
    const remarksWithT = new Set(withT.map((r) => r.remark)).size;

    console.log(`- 確からしさ ≥ ${theta}: 正解あり ${withT.length} 回 → 当たり ${pct(hit, withT.length)}・近い（親子・兄弟） ${pct(nearN, withT.length)}・違うノード ${pct(wrong, withT.length)}・光らない ${pct(quiet, withT.length)} ／ 正解なし ${noT.length} 回 → 光ってしまう ${pct(falseShow, noT.length)}`);
    console.log(`  発言になる直前の答え: 当たり ${lastHit}/${lastWithT.length}（${pct(lastHit, lastWithT.length)}） ／ 一度でも正しく光った発言 ${firstHit.size}/${remarksWithT}、反映より先に光った秒 p50 ${q(leads, 0.5).toFixed(1)}・p90 ${q(leads, 0.9).toFixed(1)}`);
  }
  const noop = rows.filter((r) => r.noop).length;
  console.log(`- 参考: 正解の空き（Claude が既存ノードに触れない発言の問い）${rows.filter((r) => r.truth && !r.truth.length).length} 回のうち noop ${noop} 回。正解の無い問い（以後の発言なし）${rows.filter((r) => !r.truth).length} 回`);
}
