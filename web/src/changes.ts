import type { Snapshot } from "../../server/src/core/index.ts";

// 今回の反映（round が現在値）で変わったノード。赤い枠はここから導く。
// 何もしない反映では round だけが進むので、前回の枠は消える。
export function changedNodeIds(snapshot: Snapshot): Set<string> {
  return new Set(snapshot.changes.filter((c) => c.round === snapshot.round).map((c) => c.node));
}

const pad = (n: number) => String(n).padStart(2, "0");

// 会議の中の秒を mm:ss にする（秒は切り捨て。60 分を超えても分は 60 以上のまま。エクスポートの Markdown と同じ）
export function formatClock(sec: number): string {
  const s = Math.floor(sec);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}
