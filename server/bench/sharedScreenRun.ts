// 試作（#183、使い捨て）: 共有画面つきの合成会議を再生し、差分更新に共有画面を添える方式を比べる。
//   node server/bench/sharedScreenRun.ts <none|image|ocr> <出力フォルダ>
// 素材は ~/live-mindmap-samples/synth/screen/（slides.tsv で発言の時刻の画面を引く。取り込みは作らない）。
// 出力フォルダの下にセッションのフォルダ（map.json など）と stats.json を書く
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { openClaudeUpdater, type Screen, type ScreenMode } from "./sharedScreenClaude.ts";

const SAMPLE = join(homedir(), "live-mindmap-samples/synth/screen");
const OCR = join(import.meta.dirname, "sharedScreen");
const [mode, out] = process.argv.slice(2) as [ScreenMode, string];
if (!["none", "image", "ocr"].includes(mode) || !out) throw new Error("usage: sharedScreenRun.ts <none|image|ocr> <出力フォルダ>");

const slides = readFileSync(join(SAMPLE, "slides.tsv"), "utf8").trim().split("\n").slice(1).map((l) => {
  const [start, end, id] = l.split("\t");
  return { start: Number(start), end: Number(end), id: id! };
});
const cache = new Map<string, Screen>();
const screenAt = (t: number): Screen => {
  const id = (slides.find((s) => s.start <= t && t < s.end) ?? slides.at(-1)!).id;
  if (!cache.has(id)) cache.set(id, { id, png: readFileSync(join(SAMPLE, "slides", `${id}.png`)), ocr: readFileSync(join(OCR, `${id}.png.ocr.txt`), "utf8") });
  return cache.get(id)!;
};

const updater = openClaudeUpdater(mode, screenAt);
const started = Date.now();
try {
  await runCli(["play", join(SAMPLE, "meeting.transcript.json")], {
    updater: updater.update, sessionsDir: out, port: 0, capture: async () => {}, stdout: (s) => process.stdout.write(s),
  });
} finally {
  updater.close();
}
const session = readdirSync(out, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().at(-1)!;
writeFileSync(join(out, session, "stats.json"), JSON.stringify({ mode, seconds: (Date.now() - started) / 1000, ...updater.stats }, null, 2));
console.log(mode, join(out, session), `$${updater.stats.cost.toFixed(3)}`);
