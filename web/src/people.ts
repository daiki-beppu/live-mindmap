// 案の出した人と TODO の担当者を、ノードの本文の後ろに出す 1 行（Issue #1023）。純粋な関数だけで、view が毎回ここから導く。
import type { SnapshotNode } from "../../server/src/core/index.ts";

// 話者の表示名。表示名を決めるのはここだけ（話者の名前が付いたら、ここだけを変える）。
// 話者なしの相手（"相手"）は出さないので null
export function speakerName(speaker: string): string | null {
  return speaker === "相手" ? null : speaker;
}

// 案は「— 出した人」、TODO は「→ 担当者 · 期限」。出すものが無ければ null。案と TODO 以外には出さない
export function personLine(node: SnapshotNode): string | null {
  if (node.kind === "案") {
    const name = node.proposer === undefined ? null : speakerName(node.proposer);
    return name === null ? null : `— ${name}`;
  }
  if (node.kind === "TODO") {
    const who = node.assignee ?? (node.assigneeSpeaker === undefined ? null : speakerName(node.assigneeSpeaker));
    const parts = [who, node.due].filter((part): part is string => part !== null && part !== undefined);
    return parts.length === 0 ? null : `→ ${parts.join(" · ")}`;
  }
  return null;
}
