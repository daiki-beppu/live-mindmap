// 案の出した人と TODO の担当者を、ノードの本文の後ろに出す 1 行（Issue #1023）。純粋な関数だけで、画面と書き出し（map.md・map.drawnix）が毎回ここから導く。
import type { SnapshotNode } from "./snapshot.ts";

// 人の 1 行に要るノードの欄。SnapshotNode も書き出しのノード（ExportNode）も渡せる
export type PersonNode = Pick<SnapshotNode, "kind" | "proposer" | "assignee" | "assigneeSpeaker" | "due">;

// 話者の名前の表（話者のラベル → 名前。Issue #1026）。サーバーの speaker-names フレームの全体で、ブラウザは持ち替えずに毎回ここから表示名を導く
export type SpeakerNames = Readonly<Record<string, string>>;

// 話者の表示名。表示名を決めるのはここだけ。名前が付いたラベルは名前、付いていなければラベルのまま。
// 話者なしの相手（"相手"）は出さないので null。名前は表示だけを変え、ノードの話者（ラベル）は変えない
export function speakerName(speaker: string, names: SpeakerNames = {}): string | null {
  return speaker === "相手" ? null : (Object.hasOwn(names, speaker) ? names[speaker]! : speaker);
}

// TODO の担当者。名前（assignee）があればそれ、無ければ担当の話者の表示名。無ければ null（話者なしの相手も null）
export function todoAssignee(node: PersonNode, names: SpeakerNames = {}): string | null {
  return node.assignee ?? (node.assigneeSpeaker === undefined ? null : speakerName(node.assigneeSpeaker, names));
}

// 案は「— 出した人」、TODO は「→ 担当者 · 期限」。出すものが無ければ null。案と TODO 以外には出さない
export function personLine(node: PersonNode, names: SpeakerNames = {}): string | null {
  if (node.kind === "案") {
    const name = node.proposer === undefined ? null : speakerName(node.proposer, names);
    return name === null ? null : `— ${name}`;
  }
  if (node.kind === "TODO") {
    const who = todoAssignee(node, names);
    const parts = [who, node.due].filter((part): part is string => part !== null && part !== undefined);
    return parts.length === 0 ? null : `→ ${parts.join(" · ")}`;
  }
  return null;
}
