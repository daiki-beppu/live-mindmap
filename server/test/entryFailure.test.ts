// 入口（cli.ts・bench/entry.ts）が共有する、失敗の表示と終了コード。個別の失敗の文面は呼び出し側が持つ。
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Schema } from "effect";
import { CliError } from "effect/cli";
import { afterEach, beforeEach, vi } from "vitest";
import { exitCodeTeardown, reportEntryFailure } from "../src/entryFailure.ts";
import { StartupDepsMissing } from "../src/startupDepsMissing.ts";
import { consoleCapture } from "./benchRun.ts";

const missing = () => new StartupDepsMissing({ items: [{ name: "helper", need: "required", state: "missing" }] });

describe("reportEntryFailure", () => {
  const report = (cause: Cause.Cause<unknown>, rest: (failure: unknown) => Effect.Effect<void> = () => Effect.die("rest を呼んではならない")) =>
    Effect.gen(function* () {
      const captured = consoleCapture();
      yield* reportEntryFailure(rest)(cause).pipe(Effect.provide(captured.layer));
      return captured;
    });

  it.effect("失敗が見つからない原因（die）は、原因の文面を stderr に出し、rest に任せない", () => Effect.gen(function* () {
    const captured = yield* report(Cause.die(new Error("boom")));
    expect(captured.stderr).toEqual(["boom\n"]);
  }));

  it.effect("StartupDepsMissing は message をそのまま stderr に出し、rest に任せない", () => Effect.gen(function* () {
    const failure = missing();
    const captured = yield* report(Cause.fail(failure));
    expect(captured.stderr).toEqual([`${failure.message}\n`]);
  }));

  it.effect("CliError は何も出さず、rest に任せない", () => Effect.gen(function* () {
    const captured = yield* report(Cause.fail(new CliError.ShowHelp({ commandPath: ["x"], errors: [] })));
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual([]);
  }));

  it.effect("それ以外の失敗は rest に渡し、rest が返した Effect を実行する", () => Effect.gen(function* () {
    const seen: unknown[] = [];
    const failure = new Error("other");
    const captured = yield* report(Cause.fail(failure), (f) => Effect.sync(() => { seen.push(f); }));
    expect(seen).toEqual([failure]);
    expect(captured.stderr).toEqual([]);
  }));
});

describe("exitCodeTeardown", () => {
  let saved: typeof process.exitCode;
  beforeEach(() => { saved = process.exitCode; process.exitCode = undefined; });
  afterEach(() => { process.exitCode = saved; vi.restoreAllMocks(); });

  class NeedsConfirmation extends Error {}
  const codeOf = (failure: unknown) => (Schema.is(StartupDepsMissing)(failure) ? 3 : failure instanceof NeedsConfirmation ? 4 : undefined);

  const run = (exit: Exit.Exit<unknown, unknown>) => {
    const processExit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    exitCodeTeardown(codeOf)(exit, () => { throw new Error("onExit を呼んではならない"); });
    expect(processExit).not.toHaveBeenCalled();
    return process.exitCode;
  };

  it("単独で判定に当たる失敗は、判定が返した終了コード（3 と 4）", () => {
    expect(run(Exit.fail(missing()))).toBe(3);
    process.exitCode = undefined;
    expect(run(Exit.fail(new NeedsConfirmation("x")))).toBe(4);
  });

  it("判定に当たらない失敗は 1、成功は 0、中断は 130（自然終了の規則のまま）", () => {
    expect(run(Exit.fail(new Error("x")))).toBe(1);
    process.exitCode = undefined;
    expect(run(Exit.succeed(undefined))).toBe(0);
    process.exitCode = undefined;
    expect(run(Exit.failCause(Cause.interrupt()))).toBe(130);
  });

  it("失敗が複数あるときは、判定に当たる失敗が含まれても 3 にも 4 にもしない", () => {
    expect(run(Exit.failCause(Cause.combine(Cause.fail(missing()), Cause.fail(new Error("x")))))).toBe(1);
    process.exitCode = undefined;
    expect(run(Exit.failCause(Cause.combine(Cause.fail(new NeedsConfirmation("confirm")), Cause.fail(new Error("other")))))).toBe(1);
  });
});
