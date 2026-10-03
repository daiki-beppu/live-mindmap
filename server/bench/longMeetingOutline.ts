// 長い会議の計測（issue #127 の調査用）: スナップショットを、根拠の発言の時刻つきのアウトラインで出す。
//   node bench/longMeetingOutline.ts <スナップショット.json> <log.jsonl>
// 各ノードに [根拠の最初の発言の分–最後の発言の分 / 根拠の数] を付ける。後半の話題が新しい議題になったか、既存ノードに足されたかを見る
import { readFileSync } from "node:fs";
import type { Remark, Snapshot } from "../src/core/index.ts";

const [snapFile, logFile] = process.argv.slice(2);
if (!snapFile || !logFile) throw new Error("usage: node bench/longMeetingOutline.ts <スナップショット.json> <log.jsonl>");
const snap: Snapshot = JSON.parse(readFileSync(snapFile, "utf8"));
const remarks = new Map<string, Remark>();
for (const l of readFileSync(logFile, "utf8").trim().split("\n")) {
  const e = JSON.parse(l);
  if (e.type === "remark") remarks.set(e.remark.id, e.remark);
}
const byParent = new Map<string | undefined, typeof snap.nodes>();
for (const n of snap.nodes) byParent.set(n.parent ?? undefined, [...(byParent.get(n.parent ?? undefined) ?? []), n]);
const min = (s: number) => Math.round(s / 60);
const walk = (parent: string | undefined, depth: number) => {
  for (const n of byParent.get(parent) ?? []) {
    const ts = n.evidence.map((id) => remarks.get(id)).filter((r): r is Remark => !!r);
    const span = ts.length ? `${min(Math.min(...ts.map((r) => r.start)))}–${min(Math.max(...ts.map((r) => r.end)))}分/${ts.length}` : "-";
    console.log(`${"  ".repeat(depth)}- ${n.id} ${n.kind}: ${n.text} [${span}]`);
    walk(n.id, depth + 1);
  }
};
walk(undefined, 0);
