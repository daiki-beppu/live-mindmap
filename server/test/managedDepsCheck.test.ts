import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { withFakeClaude } from "./fixtures/readyManagedDeps.ts";
import { readyHelperChecks, readyHelperItems } from "./fixtures/helperCheck.ts";
import { ManagedDeps, ManagedDepsFailed } from "../src/managedDeps.ts";
import { checkManagedDeps, requireStartupDeps, startupPreparationFailure } from "../src/managedDepsCheck.ts";
import { StartupDepsMissing } from "../src/startupDepsMissing.ts";
import { UpdaterUnavailable } from "../src/updaterUnavailable.ts";

const deps = (state: "ready" | "missing" | "outdated" | "absent") => ManagedDeps.of({
  check: () => Effect.succeed([
    { name: "chromium", need: "required", state: "missing" },
    { name: "claude", need: "optional", state },
  ]),
  install: () => Stream.die("確認は導入しない"), load: () => Effect.die("確認は読み込まない"),
});

const liveCheck = { screen: true, check: readyHelperChecks.check };

describe("入口とモデル経路による管理依存の必要度", () => {
  it.effect("偽 updater 用の確認は Claude だけ ready とし Chromium の状態と読込を保持する", () => Effect.gen(function* () {
    const fake = ManagedDeps.of({ ...deps("missing"), load: () => Effect.fail(new ManagedDepsFailed({ message: "管理依存の読込を委譲した" })) });
    const service = yield* ManagedDeps.pipe(Effect.provide(withFakeClaude(Layer.succeed(ManagedDeps, fake))));
    expect(yield* service.check(["chromium", "claude"])).toEqual([
      { name: "chromium", need: "required", state: "missing" },
      { name: "claude", need: "optional", state: "ready" },
    ]);
    const result = yield* Effect.result(service.load("chromium"));
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ManagedDepsFailed", message: "管理依存の読込を委譲した" } });
  }));
  it.effect.each(["start", "resume", "play"] as const)("入口 %s は Claude を必須とし Chromium は任意にする", (entry) =>
    Effect.gen(function* () {
      const report = yield* (entry === "play" ? checkManagedDeps(entry, "claude") : checkManagedDeps(entry, "claude", liveCheck)).pipe(Effect.provideService(ManagedDeps, deps("missing")));
      expect(report).toEqual({ ready: false, items: [
        { name: "chromium", need: "optional", state: "missing", size: 211_000_000, install: "pnpm cli install chromium" },
        { name: "claude", need: "required", state: "missing", size: 224_000_000, install: "pnpm cli install claude" },
        ...(entry === "play" ? [] : readyHelperItems),
      ] });
    }));
  it.effect.each(["openai-compatible", "chatgpt", "apple"] as const)("経路 %s は Claude 不足でも ready", (route) =>
    Effect.gen(function* () {
      const report = yield* checkManagedDeps("start", route, liveCheck).pipe(Effect.provideService(ManagedDeps, deps("missing")));
      expect(report.ready).toBe(true);
      expect(report.items.filter((item) => item.name === "claude" || item.name === "chromium").every((item) => item.need === "optional")).toBe(true);
      expect(report.items.filter((item) => item.name === "helper")).toEqual([readyHelperItems[0]]);
    }));
  it.effect.each(["missing", "outdated", "absent"] as const)("Claude の %s では警告を返さず必須不足になる", (state) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(requireStartupDeps("play", "claude").pipe(Effect.provideService(ManagedDeps, deps(state))));
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "StartupDepsMissing", items: [{ name: "claude", state }] } });
    }));
  it.effect("必須が ready なら任意不足の警告を返す", () => Effect.gen(function* () {
    const warnings = yield* requireStartupDeps("start", "claude", liveCheck).pipe(Effect.provideService(ManagedDeps, deps("ready")));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("chromium");
  }));
  it("読込失敗は識別情報で変換し、一般の準備失敗は保持する", () => {
    expect(startupPreparationFailure(new UpdaterUnavailable({ message: "import failed", dependency: "claude" })))
      .toMatchObject({ _tag: "StartupDepsMissing", items: [{ name: "claude", need: "required", state: "missing", size: 224_000_000 }] });
    expect(startupPreparationFailure(new UpdaterUnavailable({ message: "接続失敗" }))).toMatchObject({ _tag: "UpdaterUnavailable", message: "接続失敗" });
  });
  it("複数不足を指定の3行に整形する", () => {
    const error = new StartupDepsMissing({ items: [
      { name: "claude", need: "required", state: "missing", size: 224_000_000 },
      { name: "chromium", need: "required", state: "missing" },
    ] });
    expect(error.message).toBe("開始しません。足りないもの: claude（Claude Agent SDK、約 224MB）、chromium（Chromium）\n入れるには: pnpm cli install claude chromium\n利用者に確認してから入れてください");
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
