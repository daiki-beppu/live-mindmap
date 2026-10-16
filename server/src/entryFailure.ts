// 入口（cli.ts・bench/entry.ts）が共有する、失敗の表示と終了コード。個別の失敗の文面は呼び出し側が持つ。
import { Cause, Console, Effect, Exit, Result, type Runtime } from "effect";
import { CliError } from "effect/cli";
import { exitNaturally } from "./exitNaturally.ts";
import { StartupDepsMissing } from "./startupDepsMissing.ts";
import { describe } from "./truthFile.ts";

// 失敗の表示の共通の前半。失敗が見つからない原因・StartupDepsMissing・CliError（help・引数の誤りは effect/cli が出力済みなので二重に出さない）はここで済ませ、
// それ以外の失敗は呼び出し側の rest が表示する
export const reportEntryFailure = (rest: (failure: unknown) => Effect.Effect<void>) => (cause: Cause.Cause<unknown>): Effect.Effect<void> => {
  const error = Cause.findError(cause);
  if (Result.isFailure(error)) return Console.error(describe(Cause.squash(cause)));
  const failure = error.success;
  if (failure instanceof StartupDepsMissing) return Console.error(failure.message);
  if (CliError.isCliError(failure)) return Effect.void;
  return rest(failure);
};

// 失敗が 1 つだけで exitCodeOf が数を返すときは、その数を終了コードにする（3 = 開始に要るものが未導入、4 = 利用者の確認が要る）。
// それ以外は自然終了の規則に任せる。失敗が複数あるときは、どれかが当たっても使わない
export const exitCodeTeardown = (exitCodeOf: (failure: unknown) => number | undefined): Runtime.Teardown => (exit, onExit) => {
  if (Exit.isFailure(exit) && exit.cause.reasons.length === 1) {
    const error = Cause.findError(exit.cause);
    const code = Result.isSuccess(error) ? exitCodeOf(error.success) : undefined;
    if (code !== undefined) {
      process.exitCode = code;
      return;
    }
  }
  exitNaturally(exit, onExit);
};
