import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { exitNaturallyForManagedDeps, reportFailure } from "../bench/entry.ts";
import { command } from "../bench/sttReplay.ts";
import { consoleCapture, runCommand, taggedFailure } from "./benchRun.ts";
import { evalManagedDeps } from "./fixtures/evalManagedDeps.ts";

describe("sttReplay の Command: SDK の不足", () => {
  it.effect("SDK の不足は入力を読む前に StartupDepsMissing となり、stdout 空・失敗の文面を stderr・exit 3 で自然終了する", () => Effect.gen(function* () {
    const managed = evalManagedDeps("missing");
    const { result, stdout, stderr } = yield* runCommand(command, ["unused-items.json"]).pipe(
      Effect.provide(managed.layer),
    );
    const failure = taggedFailure(result);
    expect(failure?._tag).toBe("StartupDepsMissing");

    const cause = Cause.fail(failure);
    const reported = consoleCapture();
    yield* reportFailure(cause).pipe(Effect.provide(reported.layer));
    expect(stdout + reported.stdout.join("")).toBe("");
    expect(stderr + reported.stderr.join("")).toBe(`${failure?.message}\n`);

    const saved = process.exitCode;
    try {
      exitNaturallyForManagedDeps(Exit.failCause(cause), () => { throw new Error("自然終了する必要があります"); });
      expect(process.exitCode).toBe(3);
    } finally {
      process.exitCode = saved;
    }
    expect(managed.install).not.toHaveBeenCalled();
  }));
});
