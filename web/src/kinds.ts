import type { SnapshotNode } from "../../server/src/core/index.ts";

export const KIND_COLOR: Record<SnapshotNode["kind"], string> = {
  会議: "#6b7280",
  議題: "#3b82f6",
  論点: "#eab308",
  課題: "#ef4444",
  案: "#a855f7",
  決定: "#22c55e",
  TODO: "#14b8a6",
  補足: "#0f766e",
  要点: "#94a3b8",
};

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
