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

// 失敗が 1 つだけで isDepsMissing に当たるときは終了コード 3。それ以外は自然終了の規則に任せる
export const depsMissingTeardown = (isDepsMissing: (failure: unknown) => boolean): Runtime.Teardown => (exit, onExit) => {
  if (Exit.isFailure(exit) && exit.cause.reasons.length === 1) {
    const error = Cause.findError(exit.cause);
    if (Result.isSuccess(error) && isDepsMissing(error.success)) {
      process.exitCode = 3;
      return;
    }
  }
  exitNaturally(exit, onExit);
};
