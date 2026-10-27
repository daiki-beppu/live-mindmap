import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { withFakeClaude } from "./fixtures/readyManagedDeps.ts";
import { ManagedDeps, ManagedDepsFailed } from "../src/managedDeps.ts";
import { StartupDepsMissing } from "../src/startupDepsMissing.ts";

const deps = ManagedDeps.of({
  executable: () => Effect.die("実行ファイル取得は対象外"),
  check: () => Effect.succeed([
    { name: "chromium", need: "required", state: "missing" },
    { name: "claude", need: "optional", state: "missing" },
  ]),
  update: () => Stream.die("更新は対象外"), install: () => Stream.die("確認は導入しない"), load: () => Effect.die("確認は読み込まない"),
});

describe("開始前の公開エラーと偽 updater 用の依存", () => {
  it.effect("偽 updater 用の確認は Claude だけ ready とし Chromium の状態と読込を保持する", () => Effect.gen(function* () {
    const fake = ManagedDeps.of({ ...deps, load: () => Effect.fail(new ManagedDepsFailed({ message: "管理依存の読込を委譲した" })) });
    const service = yield* ManagedDeps.pipe(Effect.provide(withFakeClaude(Layer.succeed(ManagedDeps, fake))));
    expect(yield* service.check(["chromium", "claude"])).toEqual([
      { name: "chromium", need: "required", state: "missing" },
      { name: "claude", need: "optional", state: "ready" },
    ]);
    const result = yield* Effect.result(service.load("chromium"));
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ManagedDepsFailed", message: "管理依存の読込を委譲した" } });
  }));
  it("複数不足を指定の3行に整形する", () => {
    const error = new StartupDepsMissing({ items: [
      { name: "claude", need: "required", state: "missing", size: 224_000_000 },
      { name: "chromium", need: "required", state: "missing" },
    ] });
    expect(error.message).toBe("開始しません。足りないもの: claude（Claude Agent SDK、約 224MB）、chromium（Chromium）\n入れるには: pnpm cli install claude chromium\n利用者に確認してから入れてください");
  });
  it("710-2: Claude と speech-ja の不足はモデルの容量なしで指定の3行に整形する", () => {
    const error = new StartupDepsMissing({ items: [
      { name: "claude", need: "required", state: "missing", size: 224_000_000 },
      { name: "speech-ja", need: "required", state: "missing" },
    ] });
    expect(error.message).toBe("開始しません。足りないもの: claude（Claude Agent SDK、約 224MB）、speech-ja（日本語の音声認識モデル）\n入れるには: pnpm cli install claude speech-ja\n利用者に確認してから入れてください");
  });
  it.each([false, true])("C3: helper 不足は管理依存との同時不足=%s でも導入コマンドを別行で示す", (withClaude) => {
    const error = new StartupDepsMissing({ items: [
      ...(withClaude ? [{ name: "claude" as const, need: "required" as const, state: "missing" as const, install: "pnpm cli install claude" }] : []),
      { name: "helper", need: "required", state: "missing", install: "swift build -c release --package-path helper" },
    ] });
    expect(error.message.split("\n").filter((line) => line.startsWith("入れるには:"))).toEqual([
      ...(withClaude ? ["入れるには: pnpm cli install claude"] : []),
      "入れるには: swift build -c release --package-path helper",
    ]);
  });
});
