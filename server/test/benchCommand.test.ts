// bench の sessionStats を effect/cli の Command として走らせたとき、位置引数が無ければ引数の読み取りで失敗すること。
// ファイルもプロセスも使わない
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { command as statsCommand } from "../bench/sessionStats.ts";
import { runCommand, taggedFailure } from "./benchRun.ts";

describe("sessionStats の Command", () => {
  it.effect("位置引数が無ければ CliError（タグ付きの失敗ではない）", () => Effect.gen(function* () {
    const { result } = yield* runCommand(statsCommand, ["--no-audio"]);
    expect(result._tag).toBe("Failure");
    expect(taggedFailure(result)).toBeUndefined();
  }));
});
