// PROTOTYPE（#1379、使い捨て）— 合成会議 synth/screen の 14 回の変化を、直前に添えた画面と比べて判定する
// node synth.ts <model> <min> [nth=0]。変化は 28 秒以上離れているので、規則 B は全部を添える。判定で落ちた変化を数える
import { readFileSync } from "node:fs";
import { judge } from "./jev.ts";
const [model, minArg, nthArg = "0"] = process.argv.slice(2);
const MIN = Number(minArg);
const rows = readFileSync(new URL("screen.tsv", import.meta.url), "utf8").trim().split("\n").map((l) => l.split("\t"));
let ref: string | undefined; const ps: number[] = []; let lost = 0;
for (const [, img] of rows) {
  if (ref !== undefined) {
    const a = await judge(model, ref, img, Number(nthArg));
    if (!("p" in a)) throw new Error(a.error);
    ps.push(+a.p.toFixed(3)); if (a.p < MIN) { lost++; continue; }
  }
  ref = img;
}
console.log(JSON.stringify({ model, min: MIN, changes: rows.length, lost, minP: Math.min(...ps), ps }));
