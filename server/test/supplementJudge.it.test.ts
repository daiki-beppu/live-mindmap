import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Layer, Result } from "effect";
import { ChildProcessSpawner } from "effect/process";
import type { Judge } from "../bench/claudeJudge.ts";
import { reportFailure } from "../bench/entry.ts";
import { createSupplementJudgeCommand } from "../bench/supplementJudge.ts";
import type { LogEvent } from "../src/core/index.ts";
import { consoleCapture, runCommand, temporaryDirectory } from "./benchRun.ts";
import { childText, edgeEvents, REMARK_TEXT } from "./fixtures/edgeJudgement.ts";

const OUTPUT = "supplementJudge.json";
const SUPPLEMENT_TEXT = "SYNTHETIC_SUPPLEMENT_BODY";

function logOf(count: number): string {
  const events: LogEvent[] = [
    ...edgeEvents(count),
    ...Array.from({ length: count }, (_, i): LogEvent => ({
      type: "supplement", category: "背景", ms: 1, reflectedAt: 1,
      op: { op: "add", parent: `n${i + 2}`, text: `${SUPPLEMENT_TEXT}_${i}`, evidence: ["r1"], origin: "会議の外" },
    })),
  ];
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

function safeCapture() {
  const capture = consoleCapture();
  const noProcess = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(() =>
    Effect.die("注入した判定器で実プロセスを起動した")));
  return { ...capture, layer: Layer.merge(capture.layer, noProcess) };
}

describe("補足判定のCLI（軽いIT、判定器は偽物）", () => {
  it.effect("各フォルダのログを読み、低い評価でも成功し、本文なしのJSONと全ラベルの集計表を出す", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const dirs = [join(root, "a"), join(root, "b")];
    for (const dir of dirs) {
      mkdirSync(dir);
      writeFileSync(join(dir, "log.jsonl"), logOf(1));
    }
    const prompts: string[] = [];
    const judge: Judge<never, never> = (prompt) => Effect.sync(() => {
      prompts.push(prompt);
      return '["誤り"]';
    });
    const run = yield* runCommand(createSupplementJudgeCommand(judge), dirs, safeCapture());
    expect(Result.isSuccess(run.result)).toBe(true);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      for (const text of [childText(0), SUPPLEMENT_TEXT, REMARK_TEXT, "会議の外"]) expect(prompt).toContain(text);
    }
    for (const label of ["要る", "要らない", "誤り", "根拠なし", "出どころ違い"]) expect(run.stdout).toContain(label);
    const rows = run.stdout.split("\n").filter((line) => /^\| [ab] \|/.test(line));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toContain("100.0%");
      expect(row).toContain("0.0%");
      expect(row).not.toMatch(/通す|通さない|合格|不合格|\bpass\b|\bfail\b/i);
    }
    for (const dir of dirs) {
      const json: unknown = JSON.parse(readFileSync(join(dir, OUTPUT), "utf8"));
      expect(json).toEqual({
        supplements: [{ id: "n3", parent: "n2", label: "誤り" }], total: 1,
        counts: { 要る: 0, 要らない: 0, 誤り: 1, 根拠なし: 0, 出どころ違い: 0 },
        ratios: { 要る: 0, 要らない: 0, 誤り: 1, 根拠なし: 0, 出どころ違い: 0 },
      });
    }
    for (const line of [...run.stdout.split("\n"), ...run.stderr.split("\n")]) expect(line).not.toMatch(/SYNTHETIC/i);
  }).pipe(Effect.scoped));

  it.effect("途中の補足判定が失敗しても既存結果を上書きせず、失敗表示に本文を含めない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    writeFileSync(join(dir, "log.jsonl"), logOf(2));
    const previous = '{"previous":true}\n';
    writeFileSync(join(dir, OUTPUT), previous);
    let calls = 0;
    const judge: Judge<{ message: string }, never> = (prompt) => {
      calls++;
      return calls === 1 ? Effect.succeed('["要る"]') : Effect.fail({ message: prompt });
    };
    const capture = safeCapture();
    const run = yield* runCommand(createSupplementJudgeCommand(judge), [dir], capture);
    expect(calls).toBe(2);
    expect(Result.isFailure(run.result)).toBe(true);
    expect(readFileSync(join(dir, OUTPUT), "utf8")).toBe(previous);
    if (Result.isFailure(run.result)) yield* reportFailure(Cause.fail(run.result.failure)).pipe(Effect.provide(capture.layer));
    expect(capture.stderr.length).toBeGreaterThan(0);
    for (const line of [...capture.stdout, ...capture.stderr]) expect(line).not.toMatch(/SYNTHETIC/i);
  }).pipe(Effect.scoped));

  it.effect.each([
    { name: "不正なJSONL", log: '{"type":"start","title":"SYNTHETIC_INVALID_BODY"' },
    { name: "復元できないイベント", log: JSON.stringify({ type: "start", title: { text: "SYNTHETIC_INVALID_BODY" } }) },
  ])("$name は結果を保存せず、本文のない診断を出す", ({ log }) => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    writeFileSync(join(dir, "log.jsonl"), log);
    const capture = safeCapture();
    const run = yield* runCommand(createSupplementJudgeCommand(() => Effect.die("不正ログで判定器を呼んだ")), [dir], capture);
    expect(Result.isFailure(run.result)).toBe(true);
    expect(readdirSync(dir)).toEqual(["log.jsonl"]);
    if (Result.isFailure(run.result)) yield* reportFailure(Cause.fail(run.result.failure)).pipe(Effect.provide(capture.layer));
    expect(capture.stderr.length).toBeGreaterThan(0);
    for (const line of [...capture.stdout, ...capture.stderr]) expect(line).not.toMatch(/SYNTHETIC/i);
  }).pipe(Effect.scoped));
});
