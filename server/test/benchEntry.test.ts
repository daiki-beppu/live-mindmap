// bench/entry.ts の reportFailure。BenchFailure の 4 つの class は、それぞれ失敗の 1 行になり、
// それ以外の失敗は describe に回る。
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { afterEach, beforeEach, vi } from "vitest";
import * as benchEntry from "../bench/entry.ts";
import { InvalidInputFile, MissingSessionDir, ReplaySessionFailed, reportFailure } from "../bench/entry.ts";
import { InvalidTruthFile } from "../src/truthFile.ts";
import { consoleCapture } from "./benchRun.ts";

const report = (failure: unknown) => Effect.gen(function* () {
  const reported = consoleCapture();
  yield* reportFailure(Cause.fail(failure)).pipe(Effect.provide(reported.layer));
  return reported;
});

describe("sttReplay の終了処理: 既存の自然終了を保持する", () => {
  let saved: typeof process.exitCode;
  beforeEach(() => { saved = process.exitCode; process.exitCode = undefined; });
  afterEach(() => { process.exitCode = saved; vi.restoreAllMocks(); });

  it.each([
    { name: "成功", exit: Exit.succeed(undefined), code: 0 },
    { name: "一般の失敗", exit: Exit.fail(new Error("boom")), code: 1 },
    { name: "中断", exit: Exit.failCause(Cause.interrupt()), code: 130 },
  ])("$name は終了コード $code で自然に終わる", ({ exit, code }) => {
    const processExit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    benchEntry.exitNaturally(exit, () => { throw new Error("onExit を呼んではならない"); });
    expect(process.exitCode).toBe(code);
    expect(processExit).not.toHaveBeenCalled();
  });
});

describe("bench の入口: reportFailure", () => {
  it.effect.each([
    { failure: new InvalidInputFile({ path: "in.json", reason: "r1" }), line: "in.json: 入力ファイルを読めないか、形が違います（r1）\n" },
    { failure: new MissingSessionDir({ path: "dir", reason: "r2" }), line: "dir: セッションのフォルダが無いか、読めません（r2）\n" },
    { failure: new InvalidTruthFile({ path: "t.json", reason: "r3" }), line: "t.json: 正解ファイルが不正です（r3）\n" },
    { failure: new ReplaySessionFailed({ path: "p", reason: "r4" }), line: "p: 再生のセッションを作れないか、そのログを読めません（r4）\n" },
  ])("$failure._tag は <パス>: <説明>（<理由>）の 1 行を stderr にだけ出す", ({ failure, line }) => Effect.gen(function* () {
    const reported = yield* report(failure);
    expect(reported.stdout).toEqual([]);
    expect(reported.stderr).toEqual([line]);
  }));

  it.effect("知らない失敗（Error）は describe の文面（メッセージ）で出す", () => Effect.gen(function* () {
    const reported = yield* report(new Error("boom"));
    expect(reported.stderr).toEqual(["boom\n"]);
  }));
});
