import type { SnapshotNode } from "../../server/src/core/index.ts";

// 種別の色。淡い塗りと枠は、この色から CSS で作る。
export const KIND_COLOR: Record<SnapshotNode["kind"], string> = {
  会議: "#6b7280",
  議題: "#3b82f6",
  論点: "#eab308",
  課題: "#ef4444",
  案: "#a855f7",
  決定: "#22c55e",
  TODO: "#14b8a6",
  要点: "#ec4899",
};

// 印は 論点 ?、決定済みの論点と決定 ✓、TODO ☐ だけ。
export function markOf(node: SnapshotNode): string | null {
  switch (node.kind) {
    case "論点":
      return node.pointStatus === "決定済み" ? "✓" : "?";
    case "決定":
      return "✓";
    case "TODO":
      return "☐";
    default:
      return null;
  }
}
