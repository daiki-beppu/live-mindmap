// bench/entry.ts の reportFailure。BenchFailure の 4 つの class は、それぞれ失敗の 1 行になり、
// それ以外の失敗は describe に回る。
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { InvalidInputFile, MissingSessionDir, ReplaySessionFailed, reportFailure } from "../bench/entry.ts";
import { InvalidTruthFile } from "../src/truthFile.ts";
import { consoleCapture } from "./benchRun.ts";

const report = (failure: unknown) => Effect.gen(function* () {
  const reported = consoleCapture();
  yield* reportFailure(Cause.fail(failure)).pipe(Effect.provide(reported.layer));
  return reported;
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
