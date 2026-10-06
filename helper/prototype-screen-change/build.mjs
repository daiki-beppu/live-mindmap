// PROTOTYPE（使い捨て、issue #252）: record の出力（frames.jsonl）を viewer が読む data.js にする。
// 使い方: node build.mjs <record の出力先> → <出力先>/index.html を開く
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
const dir = process.argv[2];
const { t0 } = JSON.parse(readFileSync(path.join(dir, "t0.json"), "utf8"));
const lines = readFileSync(path.join(dir, "frames.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
let title = "";
const frames = [];
for (const r of lines) {
  const t = +((r.t - t0) / 1000).toFixed(3);
  if (r.event === "title") { title = r.title; continue; }
  if (r.status !== "complete") { frames.push({ t, status: r.status, title }); continue; }
  const area = (r.dirty ?? []).reduce((a, [, , w, h]) => a + w * h, 0);
  frames.push({ t, status: r.status, title, sig: r.sig, thumb: r.thumb, dirty: +(area * 100).toFixed(2) });
}
writeFileSync(path.join(dir, "data.js"), `const DATA = ${JSON.stringify({ frames })};\n`);
for (const f of ["viewer.html", "detector.js"]) copyFileSync(path.join(import.meta.dirname, f), path.join(dir, f === "viewer.html" ? "index.html" : f));
console.log(frames.length, "frames →", path.join(dir, "index.html"));
