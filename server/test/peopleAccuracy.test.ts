import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { PeopleTruth, createPeopleScorer } from "../bench/peopleAccuracy.ts";
import type { ExportNode, JsonExport } from "../src/core/export.ts";
import type { Remark } from "../src/core/remark.ts";
import type { SpeakerNameLogEvent } from "../src/core/speakerNames.ts";

const item = (word: string) => ({ from: 0, to: 30, keywords: [word] });
const remark = (speaker: string, start: number, end: number): Remark => ({
  id: `r${start}`, track: speaker === "自分" ? "自分" : "相手", start, end, text: "根拠", speaker,
});
const node = (id: string, kind: "案" | "TODO", people: Partial<Pick<ExportNode, "proposer" | "assignee" | "assigneeSpeaker">>): ExportNode => ({
  id, kind, text: id, evidence: [remark("相手 A", 0, 1)], children: [], ...people,
});
const exported = (children: ExportNode[]): JsonExport => ({
  root: { id: "root", kind: "会議", text: "会議", evidence: [], children },
  speakerNames: { "相手 A": "乙", "相手 B": "甲" },
});
const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
const logged = (speaker: string, start: number, end: number, seconds: number) => ({
  type: "remark" as const, remark: remark(speaker, start, end), at: at(seconds),
});
const named = (label: string, name: string, seconds: number, source: SpeakerNameLogEvent["source"]) => ({
  type: "speaker-name" as const, label, name, source, at: at(seconds),
});
const timeline = [
  { speaker: "甲", start: 0, end: 10, text: "台本甲" },
  { speaker: "乙", start: 10, end: 20, text: "台本乙" },
  { speaker: "司会", start: 20, end: 30, text: "台本自分" },
];
const log = [logged("相手 A", 0, 10, 0), logged("相手 B", 10, 20, 10), logged("自分", 20, 30, 20)];
const decode = Schema.decodeUnknownSync(PeopleTruth);
function scorePeople({ log, exp, truth, ...input }: Parameters<typeof createPeopleScorer>[0] & {
  log: readonly Parameters<ReturnType<typeof createPeopleScorer>["add"]>[0][];
  exp: JsonExport;
  truth: PeopleTruth;
}) {
  const scorer = createPeopleScorer(input);
  for (const event of log) scorer.add(event);
  return scorer.score({ exp, truth });
}

describe("人の正解ファイル", () => {
  it("任意の案・担当と出した人を読み、採点へ渡す値に残す", () => {
    const truth = { 決定: [], TODO: [{ ...item("仕事"), 担当: "なし" }, item("対象外")], 案: [{ ...item("提案"), 出した人: "甲" }] };
    expect(decode(truth)).toEqual(truth);
    expect(decode({ 決定: [], TODO: [] })).toMatchObject({ 決定: [], TODO: [] });
  });

  it.each([
    { 決定: [], TODO: [{ ...item("仕事"), 担当: 1 }] },
    { 決定: [], TODO: [], 案: [item("提案")] },
    { 決定: [], TODO: [{ ...item("仕事"), from: 2, to: 1, 担当: "甲" }] },
  ])("人の欄の不正な型・出した人の欠落・逆転した時刻を拒否する", (truth) => {
    expect(() => decode(truth)).toThrow();
  });
});

describe("出した人の採点", () => {
  it("組になった案だけを分母にし、正しい人・誤った人・人なしを区別する", () => {
    const proposals = [
      node("correct", "案", { proposer: "相手 A" }),
      node("wrong", "案", { proposer: "相手 B" }),
      node("missing", "案", {}),
      node("generic", "案", { proposer: "相手" }),
      node("unknown", "案", { proposer: "相手 Z" }),
      node("self", "案", { proposer: "自分" }),
    ];
    const truth = decode({ 決定: [], TODO: [], 案: [
      ...["correct", "wrong", "missing", "generic", "unknown", "unmatched"].map((word) => ({ ...item(word), 出した人: "甲" })),
      { ...item("self"), 出した人: "司会" },
    ] });
    const result = scorePeople({ self: "司会", timeline, log, exp: exported(proposals), truth });
    expect(result.ideas).toMatchObject({ recall: { hit: 6, total: 7 }, correct: 2, none: 3 });
    expect(result.ideas.rates.correct).toBeCloseTo(2 / 6);
    expect(result.ideas.rates.none).toBeCloseTo(3 / 6);
  });

  it("ラベルごとの最多重複先ではなく、会議全体の一対一対応で人を決める", () => {
    const overlappingLog = [logged("相手 A", 0, 19, 0), logged("相手 B", 0, 8, 1)];
    const truth = decode({ 決定: [], TODO: [], 案: [
      { ...item("first"), 出した人: "乙" }, { ...item("second"), 出した人: "甲" },
    ] });
    const result = scorePeople({ self: "司会", timeline, log: overlappingLog, truth, exp: exported([
      node("first", "案", { proposer: "相手 A" }), node("second", "案", { proposer: "相手 B" }),
    ]) });
    expect(result.ideas).toMatchObject({ recall: { hit: 2, total: 2 }, correct: 2, none: 0 });
  });

  it("汎用の相手は区間が人と重なっていても出した人なしに数える", () => {
    const truth = decode({ 決定: [], TODO: [], 案: [{ ...item("generic"), 出した人: "甲" }] });
    const result = scorePeople({
      self: "司会", timeline, log: [logged("相手", 0, 10, 0)], truth,
      exp: exported([node("generic", "案", { proposer: "相手" })]),
    });
    expect(result.ideas).toMatchObject({ recall: { hit: 1, total: 1 }, correct: 0, none: 1 });
  });
});

describe("TODOの担当の採点", () => {
  it.each([
    { name: "名前が一致", expected: "甲", people: { assignee: "甲" }, correct: 1, none: 0 },
    { name: "話者が一致", expected: "甲", people: { assigneeSpeaker: "相手 A" }, correct: 1, none: 0 },
    { name: "自分が一致", expected: "司会", people: { assigneeSpeaker: "自分" }, correct: 1, none: 0 },
    { name: "名前が誤りでも話者で救済しない", expected: "甲", people: { assignee: "乙", assigneeSpeaker: "相手 A" }, correct: 0, none: 0 },
    { name: "話者が誤り", expected: "甲", people: { assigneeSpeaker: "相手 B" }, correct: 0, none: 0 },
    { name: "属性が両方ない", expected: "甲", people: {}, correct: 0, none: 1 },
    { name: "対応しない話者は属性欠落ではない", expected: "甲", people: { assigneeSpeaker: "相手 Z" }, correct: 0, none: 0 },
    { name: "なしの正解で両属性がない", expected: "なし", people: {}, correct: 1, none: 0 },
    { name: "なしの正解に名前がある", expected: "なし", people: { assignee: "甲" }, correct: 0, none: 0 },
    { name: "なしの正解に話者がある", expected: "なし", people: { assigneeSpeaker: "相手 A" }, correct: 0, none: 0 },
  ])("$name", ({ expected, people, correct, none }) => {
    const truth = decode({ 決定: [], TODO: [{ ...item("task"), 担当: expected }] });
    const result = scorePeople({ self: "司会", timeline, log, truth, exp: exported([node("task", "TODO", people)]) });
    expect(result.todos).toMatchObject({ recall: { hit: 1, total: 1 }, correct, none, rates: { correct, none } });
  });

  it("担当のない正解を照合から除き、未再現の担当つき正解を人なしへ加えない", () => {
    const truth = decode({ 決定: [], TODO: [item("task"), { ...item("task"), 担当: "甲" }, { ...item("unmatched"), 担当: "乙" }] });
    const result = scorePeople({ self: "司会", timeline, log, truth, exp: exported([node("task", "TODO", { assignee: "甲" })]) });
    expect(result.todos).toMatchObject({ recall: { hit: 1, total: 2 }, correct: 1, none: 0, rates: { correct: 1, none: 0 } });
  });
});

describe("推定名の採点", () => {
  const truth = () => decode({ 決定: [], TODO: [] });

  it("最後の推定名で正しさを判定し、最初の推定までの秒数を数える", () => {
    const result = scorePeople({ self: "司会", timeline, exp: exported([]), truth: truth(), log: [
      log[0]!, named("相手 A", "乙", 2, "推定"), named("相手 A", "甲", 5, "推定"), named("相手 A", "誤った手入力", 6, "手入力"),
    ] });
    expect(result.names).toMatchObject({ labels: 1, correct: 1, wrong: 0, rate: 1, medianSeconds: 2 });
  });

  it("手入力だけのラベルを推定件数にも時間にも含めない", () => {
    const result = scorePeople({ self: "司会", timeline, exp: exported([]), truth: truth(), log: [
      log[0]!, named("相手 A", "甲", 2, "手入力"),
    ] });
    expect(result.names).toMatchObject({ labels: 0, correct: 0, wrong: 0 });
    expect(result.names.medianSeconds).toBeUndefined();
  });

  it("誤りと未対応ラベルを誤った名前へ数え、偶数個の時間差は中央二値を平均する", () => {
    const result = scorePeople({ self: "司会", timeline, exp: exported([]), truth: truth(), log: [
      named("相手 A", "甲", 0.5, "手入力"), ...log,
      named("相手 A", "乙", 2, "推定"), named("相手 B", "乙", 16, "推定"),
      named("相手 Z", "甲", 30, "推定"),
    ] });
    expect(result.names).toMatchObject({ labels: 3, correct: 1, wrong: 2, medianSeconds: 4 });
    expect(result.names.rate).toBeCloseTo(1 / 3);
  });
});
