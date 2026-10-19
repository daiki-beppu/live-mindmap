import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Layer, Result } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { reportFailure } from "../bench/entry.ts";
import { createSiblingJudgeCommand } from "../bench/siblingJudge.ts";
import { consoleCapture, runCommand, temporaryDirectory } from "./benchRun.ts";
import { build, childText, kids, parentText, REMARK_TEXT, TITLE, type Built } from "./fixtures/siblingJudgement.ts";

const OUTPUT = "siblingJudge.json";
const SECRETS = [TITLE, REMARK_TEXT, parentText("T"), parentText("A"), ...Array.from({ length: 5 }, (_, i) => childText(`A_${i}`))];

// 議題 T の下の論点 A（案 5 個）。判定対象は A だけ。
const map = (): Built => build([
  { ref: "T", parent: "root", kind: "議題" },
  { ref: "A", parent: "T", kind: "論点" },
  ...kids("A", "案", 5),
]);
const writeLog = (dir: string, events: readonly unknown[]) => writeFileSync(join(dir, "log.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");

function safeCapture() {
  const capture = consoleCapture();
  const noProcess = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(() =>
    Effect.die("偽判定器を注入したCLIはプロセスを起動しない")));
  return { ...capture, layer: Layer.merge(capture.layer, noProcess) };
}

describe("兄弟判定のCLI（軽いIT、判定器は偽物）", () => {
  it.effect("C1・C5: 指定した各フォルダを読み、本文なしのJSONと集計表を出す", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const dirs = [join(root, "a"), join(root, "b")];
    const built = map();
    for (const dir of dirs) {
      mkdirSync(dir);
      writeLog(dir, built.events);
    }
    const prompts: string[] = [];
    const command = createSiblingJudgeCommand((prompt: string) => Effect.sync(() => {
      prompts.push(prompt);
      return `${REMARK_TEXT}\n["別","別","別","具体化","外れ"]`;
    }));
    const run = yield* runCommand(command, dirs, safeCapture());
    expect(Result.isSuccess(run.result)).toBe(true);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).toContain(parentText("A"));
      expect(prompt).toContain(childText("A_0"));
    }
    const rows = run.stdout.split("\n").filter((line) => line.includes("40.0%"));
    expect(rows).toHaveLength(2);
    for (const dir of dirs) {
      const json = readFileSync(join(dir, OUTPUT), "utf8");
      expect(JSON.parse(json).parents).toEqual([{
        parent: built.id("A"),
        children: ["別", "別", "別", "具体化", "外れ"].map((label, i) => ({ id: built.id(`A_${i}`), label })),
      }]);
      expect(readdirSync(dir).sort()).toEqual(["log.jsonl", OUTPUT]);
      for (const secret of SECRETS) expect(json).not.toContain(secret);
    }
    for (const secret of SECRETS) {
      expect(run.stdout).not.toContain(secret);
      expect(run.stderr).not.toContain(secret);
    }
  }).pipe(Effect.scoped));

  it.effect("C2: --parent で指定した親の直下を判定し、保存と表に出す", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const built = build([
      { ref: "T", parent: "root", kind: "議題" },
      { ref: "A", parent: "T", kind: "論点" },
      ...kids("A", "案", 5),
      { ref: "B", parent: "T", kind: "論点" },
      ...kids("B", "案", 3),
    ]);
    writeLog(dir, built.events);
    const command = createSiblingJudgeCommand((prompt: string) => Effect.succeed(
      prompt.includes(parentText("B")) ? '["別","重なり","外れ"]' : '["別","別","別","別","別"]'));
    const run = yield* runCommand(command, ["--parent", built.id("B"), dir], safeCapture());
    expect(Result.isSuccess(run.result)).toBe(true);
    const saved = JSON.parse(readFileSync(join(dir, OUTPUT), "utf8"));
    expect(saved.target).toMatchObject({ parent: built.id("B"), total: 3, notSeparate: 2, counts: { 別: 1, 具体化: 0, 重なり: 1, 外れ: 1 } });
    expect(saved).toMatchObject({ total: 5, notSeparate: 0 });
    expect(run.stdout).toContain(built.id("B"));
    for (const secret of [...SECRETS, parentText("B"), childText("B_0")]) {
      expect(run.stdout).not.toContain(secret);
      expect(JSON.stringify(saved)).not.toContain(secret);
    }
  }).pipe(Effect.scoped));

  it.effect("C5: 判定の形が合わず失敗したら JSON を保存せず、失敗表示に生応答・本文を出さない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    writeLog(dir, map().events);
    const command = createSiblingJudgeCommand(() => Effect.succeed(`${REMARK_TEXT} ["${childText("A_0")}"]`));
    const capture = safeCapture();
    const run = yield* runCommand(command, [dir], capture);
    expect(Result.isFailure(run.result)).toBe(true);
    expect(readdirSync(dir)).toEqual(["log.jsonl"]);
    if (Result.isFailure(run.result)) yield* reportFailure(Cause.fail(run.result.failure)).pipe(Effect.provide(capture.layer));
    expect(capture.stderr.length).toBeGreaterThan(0);
    for (const secret of SECRETS) {
      expect(capture.stdout.join("")).not.toContain(secret);
      expect(capture.stderr.join("")).not.toContain(secret);
    }
  }).pipe(Effect.scoped));

  it.effect.each([
    { name: "JSONL構文エラー", log: '{"type":"start","title":"SYNTHETIC_INVALID_BODY"' },
    { name: "復元スキーマエラー", log: JSON.stringify({ type: "start", title: { text: "SYNTHETIC_INVALID_BODY" } }) },
  ])("C5: $name は失敗表示に入力本文を含めず、判定器を呼ばない", ({ log }) => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    writeFileSync(join(dir, "log.jsonl"), log);
    const command = createSiblingJudgeCommand(() => Effect.die("不正ログで判定器を呼んだ"));
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
