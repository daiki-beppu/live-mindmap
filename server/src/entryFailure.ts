import { Cause, Console, Effect, Exit, Result, Schema, type Runtime } from "effect";
import { CliError } from "effect/cli";
import { exitNaturally } from "./exitNaturally.ts";
import { StartupDepsMissing } from "./startupDepsMissing.ts";
import { describe } from "./truthFile.ts";

export const reportEntryFailure = (rest: (failure: unknown) => Effect.Effect<void>) => (cause: Cause.Cause<unknown>): Effect.Effect<void> => {
  const error = Cause.findError(cause);
  if (Result.isFailure(error)) return Console.error(describe(Cause.squash(cause)));
  const failure = error.success;
  if (Schema.is(StartupDepsMissing)(failure)) return Console.error(failure.message);
  if (CliError.isCliError(failure)) return Effect.void;
  return rest(failure);
};

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
