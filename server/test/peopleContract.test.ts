import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { buildPrompt, OUTPUT_SCHEMA, SYSTEM } from "../src/claudePrompt.ts";
import { applyOps, type DiffInput, DiffOutput, DiffUpdater, emptyMap, LogEvent, type MeetingMap, type Op } from "../src/core/index.ts";

// Issue #1023: 案の出した人（サーバーが決める）と TODO の担当の話者（AI が書く）の、AI の出力の契約・ログの形・プロンプトの文面。

type JsonObject = { properties: Record<string, { description?: string; type?: string }>; required: string[] };
const variants = (OUTPUT_SCHEMA as unknown as { properties: { ops: { items: { anyOf: (JsonObject & { properties: { op: { enum: string[] } } })[] } } } }).properties.ops.items.anyOf;
const variant = (name: string) => variants.find((v) => v.properties.op.enum[0] === name)!;

describe("Claude の出力契約（OUTPUT_SCHEMA）", () => {
  it("add に assigneeSpeaker（任意の文字列）が出る", () => {
    const add = variant("add");
    expect(add.properties.assigneeSpeaker).toMatchObject({ type: "string" });
    expect(add.required).not.toContain("assigneeSpeaker");
  });

  it("update に assignee と assigneeSpeaker（どちらも任意の文字列）が出る", () => {
    const update = variant("update");
    expect(update.properties.assignee).toMatchObject({ type: "string" });
    expect(update.properties.assigneeSpeaker).toMatchObject({ type: "string" });
    expect(update.required).not.toContain("assignee");
    expect(update.required).not.toContain("assigneeSpeaker");
  });

  it("出した人（proposer）は AI の出力の契約に出さない", () => {
    for (const v of variants) expect(Object.keys(v.properties), v.properties.op.enum[0]).not.toContain("proposer");
    expect(JSON.stringify(OUTPUT_SCHEMA)).not.toContain("proposer");
  });

  it("AI が返した値の decode は assigneeSpeaker を受け取り、proposer は黙って落とす（AI に出した人を選ばせない）", () => {
    const decoded = Schema.decodeUnknownSync(DiffOutput)({
      ops: [
        { op: "add", ref: "t1", parent: "root", kind: "案", text: "案", evidence: ["r1"], proposer: "相手 B" },
        { op: "add", ref: "t2", parent: "root", kind: "TODO", text: "やる", evidence: ["r1"], assigneeSpeaker: "相手 A" },
        { op: "update", node: "n2", evidence: ["r1"], assignee: "田中", assigneeSpeaker: "自分" },
      ],
    });
    expect(decoded.ops[0]).not.toHaveProperty("proposer");
    expect(decoded.ops[1]).toMatchObject({ assigneeSpeaker: "相手 A" });
    expect(decoded.ops[2]).toMatchObject({ assignee: "田中", assigneeSpeaker: "自分" });
  });
});

describe("Claude のプロンプト", () => {
  it("出した人は AI に見せない（プロンプトにも出さない）", () => {
    expect(SYSTEM).not.toContain("proposer");
    const map: MeetingMap = applyOps(emptyMap("定例"), [
      { op: "add", ref: "a", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
      { op: "add", ref: "p", parent: "a", kind: "案", text: "月 1", evidence: ["r1"], proposer: "相手 Q" },
    ], new Set(["r1"]), { round: 1, at: 0 }, new Map()).map;
    expect(buildPrompt({ map, recent: [], fresh: [] })).not.toContain("相手 Q");
  });

  const todoMap = (extra: Partial<Extract<Op, { op: "add" }>>): MeetingMap =>
    applyOps(emptyMap("定例"), [
      { op: "add", ref: "a", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
      { op: "add", ref: "t", parent: "a", kind: "TODO", text: "求人票を直す", evidence: ["r1"], ...extra },
    ], new Set(["r1"]), { round: 1, at: 0 }, new Map()).map;
  const todoLine = (map: MeetingMap) => buildPrompt({ map, recent: [], fresh: [] }).split("\n").find((l) => /n2 TODO:/.test(l))!;

  it("TODO の行に、名前が無く担当の話者があればその話者が出る（期限も）", () => {
    const row = todoLine(todoMap({ assigneeSpeaker: "相手 A", due: "来週" }));
    expect(row).toContain("担当の話者 相手 A");
    expect(row).toContain("来週");
  });

  it("名前があれば名前だけが出る", () => {
    const row = todoLine(todoMap({ assignee: "田中", assigneeSpeaker: "相手 A" }));
    expect(row).toContain("田中");
    expect(row).not.toContain("相手 A");
  });
});
describe("log.jsonl の diff の行", () => {
  const diff = (ops: unknown[]) => ({ type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0 }, ops, dropped: [] });

  it("proposer（案の add）と assigneeSpeaker（TODO の add・update）を持つ行を、値を保ったまま decode できる", () => {
    const ops = [
      { op: "add", ref: "t1", parent: "root", kind: "案", text: "案", evidence: ["r1"], proposer: "相手 A" },
      { op: "add", ref: "t2", parent: "root", kind: "TODO", text: "やる", evidence: ["r1"], assigneeSpeaker: "相手 A" },
      { op: "update", node: "n2", evidence: ["r1"], assignee: "田中" },
      { op: "update", node: "n2", evidence: ["r1"], assigneeSpeaker: "自分" },
    ];
    const decoded = Schema.decodeUnknownSync(LogEvent)(diff(ops));
    expect(decoded).toMatchObject({ ops });
  });

  it("人の欄が無い古い行も、そのまま decode できる（無しとして読む）", () => {
    const ops = [
      { op: "add", ref: "t1", parent: "root", kind: "案", text: "案", evidence: ["r1"] },
      { op: "add", ref: "t2", parent: "root", kind: "TODO", text: "やる", evidence: ["r1"], assignee: "田中", due: "来週" },
      { op: "update", node: "n1", text: "x", evidence: ["r1"] },
    ];
    const decoded = Schema.decodeUnknownSync(LogEvent)(diff(ops));
    expect(decoded).toMatchObject({ ops });
    for (const op of (decoded as { ops: object[] }).ops) {
      expect(op).not.toHaveProperty("proposer");
      expect(op).not.toHaveProperty("assigneeSpeaker");
    }
  });
});
