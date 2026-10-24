import type { SnapshotNode } from "./snapshot.ts";

export type PersonNode = Pick<SnapshotNode, "kind" | "proposer" | "assignee" | "assigneeSpeaker" | "due">;

export type SpeakerNames = Readonly<Record<string, string>>;

export function speakerName(speaker: string, names: SpeakerNames = {}): string | null {
  return speaker === "相手" ? null : (Object.hasOwn(names, speaker) ? names[speaker]! : speaker);
}

export function todoAssignee(node: PersonNode, names: SpeakerNames = {}): string | null {
  return node.assignee ?? (node.assigneeSpeaker === undefined ? null : speakerName(node.assigneeSpeaker, names));
}

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
