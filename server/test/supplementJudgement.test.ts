import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import type { Judge } from "../bench/claudeJudge.ts";
import { judgeSupplements } from "../bench/supplementJudgement.ts";
import type { LogEvent } from "../src/core/index.ts";

const parentText = (i: number) => `SYNTHETIC_PARENT_${i}`;
const supplementText = (i: number) => `SYNTHETIC_SUPPLEMENT_${i}`;
const remarkText = (i: number) => `SYNTHETIC_REMARK_${i}`;
const contextText = (i: number) => `SYNTHETIC_CONTEXT_${i}`;

function eventsOf(count: number, withSupplements: boolean): LogEvent[] {
  return [
    { type: "start", title: "SYNTHETIC_TITLE" },
    ...Array.from({ length: count }, (_, i): LogEvent[] => [
      { type: "remark", remark: { id: `r${i}`, track: "相手", start: i, end: i + 1, text: remarkText(i) } },
      { type: "remark", remark: { id: `context${i}`, track: "自分", start: i, end: i + 1, text: contextText(i) } },
    ]).flat(),
    {
      type: "diff", input: { recent: [], fresh: Array.from({ length: count }, (_, i) => [`r${i}`, `context${i}`]).flat(), nodeCount: 0 }, dropped: [],
      ops: Array.from({ length: count }, (_, i) => ({
        op: "add", ref: `parent${i}`, parent: "root", kind: "案", text: parentText(i), evidence: [`r${i}`, `context${i}`],
      })),
    },
    ...(withSupplements ? Array.from({ length: count }, (_, i): LogEvent => ({
      type: "supplement", category: "背景", ms: 1, reflectedAt: count,
      op: { op: "add", parent: `n${i + 1}`, text: supplementText(i), evidence: [`r${i}`], origin: "会議の外" },
    })) : []),
  ];
}

describe("補足ごとの判定とラベル集計", () => {
  it.effect("補足6件を個別に判定し、全5ラベルの件数と補足総数を分母にした割合を返す", () => Effect.gen(function* () {
    const labels = ["要る", "要らない", "誤り", "根拠なし", "出どころ違い", "要る"];
    const prompts: string[] = [];
    const judge: Judge<never, never> = (prompt) => Effect.sync(() => {
      prompts.push(prompt);
      const index = labels.findIndex((_, i) => prompt.includes(supplementText(i)));
      if (index < 0) throw new Error("補足本文が判定器に届いていない");
      return JSON.stringify([labels[index]]);
    });
    const events: LogEvent[] = [...eventsOf(6, true), {
      type: "diff", input: { recent: [], fresh: ["r0"], nodeCount: 13 }, dropped: [],
      ops: [{ op: "add", ref: "withoutSupplement", parent: "root", kind: "案", text: "SYNTHETIC_WITHOUT_SUPPLEMENT", evidence: ["r0"] }],
    }];
    const result = yield* judgeSupplements(events, judge);
    expect(prompts).toHaveLength(6);
    expect(result).toEqual({
      supplements: labels.map((label, i) => ({ id: `n${i + 7}`, parent: `n${i + 1}`, label })),
      total: 6,
      counts: { 要る: 2, 要らない: 1, 誤り: 1, 根拠なし: 1, 出どころ違い: 1 },
      ratios: { 要る: 2 / 6, 要らない: 1 / 6, 誤り: 1 / 6, 根拠なし: 1 / 6, 出どころ違い: 1 / 6 },
    });
  }));

  it.effect("通常ノードだけなら判定器を呼ばず、全ラベルの件数と割合を0にする", () => Effect.gen(function* () {
    const judge: Judge<never, never> = () => Effect.die("補足がないときに判定器を呼んだ");
    const result = yield* judgeSupplements(eventsOf(2, false), judge);
    expect(result).toEqual({
      supplements: [], total: 0,
      counts: { 要る: 0, 要らない: 0, 誤り: 0, 根拠なし: 0, 出どころ違い: 0 },
      ratios: { 要る: 0, 要らない: 0, 誤り: 0, 根拠なし: 0, 出どころ違い: 0 },
    });
  }));

  it.effect.each(["会議の中", "会議の外"] as const)("親・補足・対応する発言本文・出どころ %s を判定器へ渡す", (origin) => Effect.gen(function* () {
    const events: LogEvent[] = [...eventsOf(2, true), {
      type: "supplement", category: "背景", ms: 1, reflectedAt: 3,
      op: { op: "update", node: "n3", text: supplementText(0), evidence: ["r0"], origin },
    }];
    const prompts: string[] = [];
    const judge: Judge<never, never> = (prompt) => Effect.sync(() => {
      prompts.push(prompt);
      return '["要る"]';
    });
    yield* judgeSupplements(events, judge);
    expect(prompts).toHaveLength(2);
    for (const i of [0, 1]) {
      const prompt = prompts.find((p) => p.includes(supplementText(i)));
      expect(prompt).toBeDefined();
      const input: unknown = JSON.parse(prompt!.slice(prompt!.indexOf("\n\n") + 2));
      expect(input).toMatchObject({
        parent: { id: `n${i + 1}`, kind: "案", text: parentText(i), evidence: [`r${i}`, `context${i}`] },
        supplement: { id: `n${i + 3}`, text: supplementText(i), origin: i === 0 ? origin : "会議の外", evidence: [`r${i}`] },
        remarks: expect.arrayContaining([
          expect.objectContaining({ id: `r${i}`, text: remarkText(i) }),
          expect.objectContaining({ id: `context${i}`, text: contextText(i) }),
        ]),
      });
    }
  }));

  it.effect("更新後の補足だけを判定し、削除済みと反映拒否された補足を数えない", () => Effect.gen(function* () {
    const latest = "SYNTHETIC_UPDATED_SUPPLEMENT";
    const rejected = "SYNTHETIC_REJECTED_SUPPLEMENT";
    const events: LogEvent[] = [...eventsOf(2, true),
      { type: "supplement", category: "背景", ms: 1, reflectedAt: 3,
        op: { op: "update", node: "n3", text: latest, evidence: ["context0"], origin: "会議の中" } },
      { type: "supplement", category: null, ms: 1, reflectedAt: 3, op: { op: "delete", node: "n4" } },
      { type: "supplement", category: "背景", ms: 1, reflectedAt: 3,
        op: { op: "add", parent: "n1", text: rejected, evidence: ["r0"], origin: "会議の外" } },
    ];
    const prompts: string[] = [];
    const judge: Judge<never, never> = (prompt) => Effect.sync(() => {
      prompts.push(prompt);
      return '["要る"]';
    });
    const result = yield* judgeSupplements(events, judge);
    expect(result.supplements).toEqual([{ id: "n3", parent: "n1", label: "要る" }]);
    expect(result.total).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(latest);
    expect(prompts[0]).toContain("会議の中");
    for (const text of [supplementText(0), supplementText(1), rejected]) expect(prompts[0]).not.toContain(text);
  }));

  it.effect.each([
    { name: "JSONがない", response: "not-json" },
    { name: "壊れたJSON", response: '["要る",]' },
    { name: "ラベルが0件", response: "[]" },
    { name: "ラベルが2件", response: '["要る","誤り"]' },
    { name: "未知ラベル", response: '["その他"]' },
  ])("$name の応答を集計せず、3回目の正常な判定を採用する", ({ response }) => Effect.gen(function* () {
    let calls = 0;
    const judge: Judge<never, never> = () => Effect.sync(() => ++calls < 3 ? response : '["誤り"]');
    const result = yield* judgeSupplements(eventsOf(1, true), judge);
    expect(calls).toBe(3);
    expect(result.counts).toEqual({ 要る: 0, 要らない: 0, 誤り: 1, 根拠なし: 0, 出どころ違い: 0 });
    expect(result.ratios).toEqual({ 要る: 0, 要らない: 0, 誤り: 1, 根拠なし: 0, 出どころ違い: 0 });
  }));

  it.effect("不正応答が3回続いたら失敗し、本文と生応答をエラーに含めない", () => Effect.gen(function* () {
    let calls = 0;
    const raw = "SYNTHETIC_RAW_RESPONSE";
    const judge: Judge<never, never> = (prompt) => Effect.sync(() => {
      calls++;
      return `${prompt}\n${raw}`;
    });
    const result = yield* Effect.result(judgeSupplements(eventsOf(1, true), judge));
    expect(calls).toBe(3);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      const error = JSON.stringify(result.failure) + String(result.failure);
      for (const value of [raw, parentText(0), supplementText(0), remarkText(0), contextText(0)]) expect(error).not.toContain(value);
    }
  }));

  it.effect("判定器自体の失敗は再試行せず、判定器が返す本文をエラーから除く", () => Effect.gen(function* () {
    let calls = 0;
    const judge: Judge<{ message: string }, never> = (prompt) => {
      calls++;
      return Effect.fail({ message: prompt });
    };
    const result = yield* Effect.result(judgeSupplements(eventsOf(1, true), judge));
    expect(calls).toBe(1);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      const error = JSON.stringify(result.failure) + String(result.failure);
      for (const value of [parentText(0), supplementText(0), remarkText(0), contextText(0)]) expect(error).not.toContain(value);
    }
  }));

  it.effect("復元できないログは判定器を呼ばず、入力本文を含まない失敗にする", () => Effect.gen(function* () {
    const secret = "SYNTHETIC_INVALID_BODY";
    const result = yield* Effect.result(judgeSupplements([{ type: "start", title: { text: secret } }], () => Effect.die("不正ログで判定器を呼んだ")));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(JSON.stringify(result.failure) + String(result.failure)).not.toContain(secret);
  }));
});
