import { defaultClaude } from "../src/modelSelection.ts";
import { it as effectIt } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { expect, vi } from "vitest";
import { claudeUpdaterLayer, UpdaterUnavailable } from "../src/diffUpdater.ts";

// claude.ts（Agent SDK）を読み込めない環境を、factory が投げることで再現する
vi.mock("../src/claude.ts", () => {
  throw new Error("sdk を読み込めない");
});

effectIt.effect("claude.ts を import できないと UpdaterUnavailable で失敗する", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(Layer.build(claudeUpdaterLayer(defaultClaude)));
    expect(Exit.isFailure(exit)).toBe(true);
    const err = Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "";
    expect(err).toContain("UpdaterUnavailable");
    expect(new UpdaterUnavailable({ message: "x" })._tag).toBe("UpdaterUnavailable");
  }).pipe(Effect.scoped),
);
