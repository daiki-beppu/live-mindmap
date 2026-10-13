// PROTOTYPE（#881）— 台本の無い実会議で、確定結果の start・end を「行」とみなして timeline.tsv と lines.json を作る。
// 話し終わりは確定結果の end（音声の時刻）で代える。本文は sim.mjs の CER にだけ使い、出力は外に出さない
// node finalsTimeline.mjs <stt.jsonl> <out.tsv> <out.lines.json>
import { readFileSync, writeFileSync } from "node:fs";
const [sttPath, tsvPath, linesPath] = process.argv.slice(2);
const finals = readFileSync(sttPath, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  .filter((r) => r.isFinal && r.text.trim()).sort((a, b) => a.start - b.start);
writeFileSync(tsvPath, finals.map((r) => `${r.track}\t${r.start.toFixed(2)}\t${r.end.toFixed(2)}\t${r.text.replace(/\s+/g, " ")}`).join("\n") + "\n");
writeFileSync(linesPath, JSON.stringify(finals.map((r) => ({ start: +r.start.toFixed(2), end: +r.end.toFixed(2) }))));
console.log(`finals=${finals.length}`);
