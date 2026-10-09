// 親が存在しない の親を分類する。使い方: node drops.mjs <session dir>...
import { readFileSync, readdirSync } from "node:fs";
for (const dir of process.argv.slice(2)) {
  const lines = readFileSync(`${dir}/${readdirSync(dir).find(f=>!f.startsWith("."))}/log.jsonl`, "utf8").trim().split("\n").map(JSON.parse);
  const prevRefs = new Set(); const c = {}; const reasons = {};
  for (const l of lines.filter((l) => l.type === "diff")) {
    const refsHere = l.ops.filter((o) => o.op === "add").map((o) => o.ref);
    const droppedRefs = new Set(l.dropped.filter((d) => d.op.op === "add").map((d) => d.op.ref));
    const all = [...l.ops, ...l.dropped.map((d) => d.op)];
    for (const d of l.dropped) {
      reasons[d.reason] = (reasons[d.reason] ?? 0) + 1;
      if (d.reason !== "親が存在しない") continue;
      const p = d.op.parent;
      const k = droppedRefs.has(p) ? "連鎖（親も捨てられた）" : prevRefs.has(p) ? "前の応答の仮 ID" : /^n\d+$/.test(p) ? "存在しない n ID" : "どこにも無い仮 ID";
      c[k] = (c[k] ?? 0) + 1;
    }
    for (const o of all) if (o.op === "add") prevRefs.add(o.ref);
  }
  console.log(dir.split("/").pop(), JSON.stringify(reasons), JSON.stringify(c));
}
