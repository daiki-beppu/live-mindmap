import type { Snapshot } from "../../server/src/core/index.ts";

export function changedNodeIds(snapshot: Snapshot): Set<string> {
  return new Set(snapshot.changes.filter((c) => c.round === snapshot.round).map((c) => c.node));
}

const pad = (n: number) => String(n).padStart(2, "0");

export function formatClock(sec: number): string {
  const s = Math.floor(sec);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}
