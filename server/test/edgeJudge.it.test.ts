import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Layer, Result } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { createEdgeJudgeCommand } from "../bench/edgeJudge.ts";
import { reportFailure } from "../bench/entry.ts";
import { consoleCapture, runCommand, temporaryDirectory } from "./benchRun.ts";
import { childText, edgeEvents, PARENT_TEXT, REMARK_TEXT, TITLE } from "./fixtures/edgeJudgement.ts";

const OUTPUT = "edgeJudge.json";

function safeCapture() {
  const capture = consoleCapture();
  const noProcess = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(() =>
    Effect.die("偽判定器を注入したCLIはプロセスを起動しない")));
  return { ...capture, layer: Layer.merge(capture.layer, noProcess) };
}

describe("辺判定のCLI（軽いIT、判定器は偽物）", () => {
  it.effect("C2・C3・C4: 指定した各フォルダを読み、本文なしのJSONと集計表を出す", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const dirs = [join(root, "a"), join(root, "b")];
    for (const dir of dirs) {
      mkdirSync(dir);
      writeFileSync(join(dir, "log.jsonl"), edgeEvents(1).map((e) => JSON.stringify(e)).join("\n") + "\n");
    }
    const prompts: string[] = [];
    const command = createEdgeJudgeCommand((prompt: string) => Effect.sync(() => {
      prompts.push(prompt);
      return `${REMARK_TEXT}\n["なし"]`;
    }));
    const run = yield* runCommand(command, dirs, safeCapture());
    expect(Result.isSuccess(run.result)).toBe(true);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).toContain(PARENT_TEXT);
      expect(prompt).toContain(childText(0));
    }
    const rows = run.stdout.split("\n").filter((line) => line.includes("100.0%"));
    expect(rows).toHaveLength(2);
    for (const row of run.stdout.split("\n")) expect(row).not.toMatch(/synthetic|secret/i);
    for (const dir of dirs) {
      const json = readFileSync(join(dir, OUTPUT), "utf8");
      expect(JSON.parse(json)).toEqual([{ id: "n2", parent: "n1", label: "なし" }]);
      expect(readdirSync(dir).sort()).toEqual([OUTPUT, "log.jsonl"]);
      for (const secret of [TITLE, PARENT_TEXT, childText(0), REMARK_TEXT]) expect(json).not.toContain(secret);
    }
    for (const secret of [TITLE, PARENT_TEXT, childText(0), REMARK_TEXT]) {
      for (const row of run.stdout.split("\n")) expect(row).not.toContain(secret);
      expect(run.stderr).not.toContain(secret);
    }
  }).pipe(Effect.scoped));

  it.effect("C3: 後のバッチが失敗したら途中のJSONを保存せず、失敗表示に生応答を出さない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    writeFileSync(join(dir, "log.jsonl"), edgeEvents(41).map((e) => JSON.stringify(e)).join("\n"));
    let calls = 0;
    const command = createEdgeJudgeCommand(() => Effect.sync(() => {
      calls++;
      return calls === 1 ? JSON.stringify(Array.from({ length: 40 }, () => "答え")) : `["${childText(40)}"]`;
    }));
    const capture = safeCapture();
    const run = yield* runCommand(command, [dir], capture);
    expect(Result.isFailure(run.result)).toBe(true);
    expect(readdirSync(dir)).toEqual(["log.jsonl"]);
    if (Result.isFailure(run.result)) yield* reportFailure(Cause.fail(run.result.failure)).pipe(Effect.provide(capture.layer));
    expect(capture.stderr.length).toBeGreaterThan(0);
    for (const secret of [TITLE, PARENT_TEXT, childText(40), REMARK_TEXT]) {
      expect(capture.stdout.join("")).not.toContain(secret);
      expect(capture.stderr.join("")).not.toContain(secret);
    }
  }).pipe(Effect.scoped));

  it.effect.each([
    { name: "JSONL構文エラー", log: '{"type":"start","title":"SYNTHETIC_INVALID_BODY"' },
    { name: "復元スキーマエラー", log: JSON.stringify({ type: "start", title: { text: "SYNTHETIC_INVALID_BODY" } }) },
  ])("C3: $name は失敗表示に入力本文を含めない", ({ log }) => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    writeFileSync(join(dir, "log.jsonl"), log);
    const command = createEdgeJudgeCommand(() => Effect.die("不正ログで判定器を呼んだ"));
    const capture = safeCapture();
    const run = yield* runCommand(command, [dir], capture);
    expect(Result.isFailure(run.result)).toBe(true);
    if (Result.isFailure(run.result)) yield* reportFailure(Cause.fail(run.result.failure)).pipe(Effect.provide(capture.layer));
    expect(capture.stderr.length).toBeGreaterThan(0);
    expect(readdirSync(dir)).toEqual(["log.jsonl"]);
    expect(capture.stderr.join("")).not.toContain("SYNTHETIC_INVALID_BODY");
    expect(capture.stdout.join("")).not.toContain("SYNTHETIC_INVALID_BODY");
  }).pipe(Effect.scoped));
});
