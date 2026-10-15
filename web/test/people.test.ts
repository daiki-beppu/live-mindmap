import { describe, expect, it } from "vitest";
import type { SnapshotNode } from "../../server/src/core/index.ts";
import { personLine, speakerName } from "../src/people.ts";

// Issue #1023: 案の出した人と TODO の担当者を、ノードの本文の後ろに出す 1 行。表示名は speakerName の 1 か所で決める（後の名前の sub-issue はここだけを変える）。

const n = (kind: SnapshotNode["kind"], extra: Partial<SnapshotNode> = {}): SnapshotNode => ({ id: "x", parent: "root", kind, text: "t", evidence: ["r1"], ...extra });

describe("speakerName: 話者の表示名（唯一の決め場所）", () => {
  it("話者なしの相手（「相手」）は出さない（null）", () => expect(speakerName("相手")).toBeNull());
  it.each(["相手 A", "相手 B", "自分"])("ラベル「%s」はそのまま", (label) => expect(speakerName(label)).toBe(label));
});

describe("personLine: 案の出した人", () => {
  it("案は「— 出した人」", () => expect(personLine(n("案", { proposer: "相手 A" }))).toBe("— 相手 A"));
  it("自分の案は「— 自分」", () => expect(personLine(n("案", { proposer: "自分" }))).toBe("— 自分"));
  it("話者なしの相手の案は出さない", () => expect(personLine(n("案", { proposer: "相手" }))).toBeNull());
  it("出した人の無い案（古いログ）は出さない", () => expect(personLine(n("案"))).toBeNull());
  it("却下の案でも出す", () => expect(personLine(n("案", { proposer: "相手 B", planStatus: "却下" }))).toBe("— 相手 B"));
});

describe("personLine: TODO の担当者", () => {
  it("担当の話者と期限は「→ 担当者 · 期限」", () => expect(personLine(n("TODO", { assigneeSpeaker: "自分", due: "10/15" }))).toBe("→ 自分 · 10/15"));
  it("名前の担当者と期限も同じ形", () => expect(personLine(n("TODO", { assignee: "田中", due: "10/15" }))).toBe("→ 田中 · 10/15"));
  it("担当者だけなら「→ 担当者」", () => {
    expect(personLine(n("TODO", { assignee: "田中" }))).toBe("→ 田中");
    expect(personLine(n("TODO", { assigneeSpeaker: "相手 A" }))).toBe("→ 相手 A");
  });
  it("期限だけなら「→ 期限」", () => expect(personLine(n("TODO", { due: "来週" }))).toBe("→ 来週"));
  it("名前と担当の話者が両方あるときは名前を出す", () => expect(personLine(n("TODO", { assignee: "田中", assigneeSpeaker: "相手 A" }))).toBe("→ 田中"));
  it("担当の話者が話者なしの「相手」なら担当者としては出さず、期限だけ出る", () => expect(personLine(n("TODO", { assigneeSpeaker: "相手", due: "来週" }))).toBe("→ 来週"));
  it("担当者も期限も無い TODO は出さない", () => expect(personLine(n("TODO"))).toBeNull());
  it("TODO に出した人は出さない", () => expect(personLine(n("TODO", { proposer: "相手 A" }))).toBeNull());
});

describe("personLine: 論点・課題・決定・要点・議題・会議には人を出さない", () => {
  it.each(["議題", "論点", "課題", "決定", "要点", "会議"] as const)("%s", (kind) => {
    expect(personLine(n(kind, { proposer: "相手 A", assigneeSpeaker: "相手 A", assignee: "田中", due: "来週" }))).toBeNull();
  });
  it("案に担当者があっても出さない", () => expect(personLine(n("案", { assignee: "田中", assigneeSpeaker: "自分", due: "来週" }))).toBeNull());
});
