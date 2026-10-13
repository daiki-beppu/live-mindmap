// PROTOTYPE（#881）— 台本の無い実会議で、音声の無音区間（ffmpeg silencedetect）から「行」（声のある区間）を作る。
// 行の end（無音が始まった時刻）を話し終わりとみなす。本文は持たない（sim.mjs の CER は意味を持たない）
// node vadTimeline.mjs <audio> <out.tsv> <out.lines.json> [noise dB=-35] [d 秒=0.4]
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const [audio, tsvPath, linesPath, noise = "-35", d = "0.4"] = process.argv.slice(2);
const { stderr } = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-i", audio, "-af", `silencedetect=noise=${noise}dB:d=${d}`, "-f", "null", "-"], { encoding: "utf8", maxBuffer: 1 << 28 });
const lines = []; let voiceFrom = 0;
for (const m of stderr.matchAll(/silence_(start|end): ([0-9.]+)/g)) {
  const t = +m[2];
  if (m[1] === "start") { if (t - voiceFrom >= 0.2) lines.push({ start: +voiceFrom.toFixed(2), end: +t.toFixed(2) }); }
  else voiceFrom = t;
}
writeFileSync(tsvPath, lines.map((l) => `相手\t${l.start}\t${l.end}\t-`).join("\n") + "\n");
writeFileSync(linesPath, JSON.stringify(lines));
console.log(`lines=${lines.length}`);
