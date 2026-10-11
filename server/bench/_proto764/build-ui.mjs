// #764 の試作（使い捨て）: 見返し画面で光らせ方を見比べるためのデータを作る。
// node build-ui.mjs <measure.mjs の out.json> <素材のフォルダ> <web/proto764>
// - events: セッションのログ。diff に実測の反映時刻（proto764At、会議の秒）を足す（見返しは本来、発言の終わりで反映させる）
// - interim: 途中結果（字幕を本番と同じ速さで出すため）
// - highlights: 議題単位・確からしさ 0.7 以上の Jev の答え（2 秒ごと）
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const [measuredPath, sampleDir, outDir] = process.argv.slice(2);
const THETA = 0.7;
const GAP = 2;

const measured = JSON.parse(readFileSync(measuredPath, "utf8"));
const run = JSON.parse(readFileSync(measured.run, "utf8"));
const log = readFileSync(`${run.dir}/log.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
let d = 0;
const events = log.map((e) => (e.type === "diff" ? { ...e, proto764At: run.diffEnds[d++] } : e));

const interim = readFileSync(measured.interim, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  .map((e) => ({ at: e.arrival, start: e.start, text: e.text }));

const N = new Map(measured.nodes.map((n) => [n.id, n]));
const topicOf = (id) => { let c = N.get(id); while (c && !(c.kind === "議題" && c.parent !== "root")) c = N.get(c.parent); return c?.id ?? null; };
const last = {};
const highlights = [];
for (const r of measured.rows) {
  if (last[r.segStart] !== undefined && r.at - last[r.segStart] < GAP) continue;
  last[r.segStart] = r.at;
  if ((r.conf ?? 0) < THETA) continue; // 自信がなければ前の答えのまま
  const topic = r.choice === "new" || r.choice === "none" ? null : topicOf(r.choice);
  highlights.push({ at: r.at + r.ms / 1000, topic, hit: topic && r.truth ? r.truth.some((t) => topicOf(t) === topic) : null });
}

mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/data.json`, JSON.stringify({ events, interim, highlights }));
copyFileSync(`${sampleDir}/meeting.m4a`, `${outDir}/meeting.m4a`);
console.error(`events ${events.length}, interim ${interim.length}, highlights ${highlights.length} → ${outDir}`);
