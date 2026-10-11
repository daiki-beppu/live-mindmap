import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { withFakeClaude } from "./fixtures/readyManagedDeps.ts";
import { readyHelperChecks, readyHelperItems } from "./fixtures/helperCheck.ts";
import { ManagedDeps, ManagedDepsFailed } from "../src/managedDeps.ts";
import { checkManagedDeps, requireStartupDeps, startupPreparationFailure } from "../src/managedDepsCheck.ts";
import { StartupDepsMissing } from "../src/startupDepsMissing.ts";
import { HelperCheckFailure } from "../src/helpers.ts";
import { UpdaterUnavailable } from "../src/updaterUnavailable.ts";
import claudeManifest from "../managed-deps/claude/package.json" with { type: "json" };

const deps = (state: "ready" | "missing" | "outdated" | "absent") => ManagedDeps.of({
  executable: () => Effect.die("実行ファイル取得は対象外"),
  check: () => Effect.succeed([
    { name: "chromium", need: "required", state: "missing" },
    { name: "claude", need: "optional", state },
  ]),
  update: () => Stream.die("更新は対象外"), install: () => Stream.die("確認は導入しない"), load: () => Effect.die("確認は読み込まない"),
});

const liveCheck = { screen: true, check: readyHelperChecks.check };

describe("入口とモデル経路による管理依存の必要度", () => {
  it.effect("831 C6: start は cloudflared を確認も導入もせず既存依存だけで開始できる", () => Effect.gen(function* () {
    const checked: ReadonlyArray<string>[] = [];
    const service = ManagedDeps.of({
      ...deps("ready"),
      check: (names) => Effect.sync(() => {
        checked.push(names);
        return names.map((name) => {
          if (name !== "chromium" && name !== "claude") throw new Error(`開始前の対象外依存: ${name}`);
          return { name, need: "optional" as const, state: "ready" as const };
        });
      }),
    });
    const warnings = yield* requireStartupDeps("start", "claude", liveCheck)
      .pipe(Effect.provideService(ManagedDeps, service));
    expect(checked).toEqual([["chromium", "claude"]]);
    expect(warnings).toEqual([]);
  }));
  it.effect.each([
    { entry: "resume", route: "claude" },
    { entry: "play", route: "claude" },
    { entry: "start", route: "apple" },
  ] as const)("711-2: $entry / $route は SDK の版違いを不足扱いせず版付きの警告を返す", ({ entry, route }) => Effect.gen(function* () {
    const service = {
      ...deps("outdated"),
      check: () => Effect.succeed([
        { name: "chromium" as const, need: "optional" as const, state: "ready" as const },
        { name: "claude" as const, need: "optional" as const, state: "outdated" as const, version: "0.0.0" },
      ]),
    };
    const warnings = yield* (entry === "play" ? requireStartupDeps(entry, route) : requireStartupDeps(entry, route, liveCheck))
      .pipe(Effect.provideService(ManagedDeps, ManagedDeps.of(service)));
    expect(warnings).toEqual([`警告: claude（Claude Agent SDK、約 224MB） が版違いです（入っている版 0.0.0、固定版 ${claudeManifest.dependencies["@anthropic-ai/claude-agent-sdk"]}）。そろえるには: pnpm cli update claude`]);
  }));
  it.effect.each([
    { status: "installed", locales: [], state: "ready" },
    { status: "supported", locales: [], state: "missing" },
    { status: "supported", locales: ["ja-JP", "ja_JP"], state: "missing" },
    { status: "downloading", locales: ["ja-JP"], state: "missing" },
    { status: "unsupported", locales: [], state: "missing" },
  ] as const)("710-1: speech-ja $status / $locales は $state で容量・版を持たない", ({ status, locales, state }) => Effect.gen(function* () {
    const report = yield* checkManagedDeps("start", "apple", { screen: false, check: Effect.succeed({
      microphone: "authorized", speechJa: { status, installedLocales: [...locales] },
    }) }).pipe(Effect.provideService(ManagedDeps, deps("ready")));
    expect(report.items.filter((item) => item.name === "speech-ja")).toEqual([
      { name: "speech-ja", need: "required", state, install: "pnpm cli install speech-ja" },
    ]);
    expect(report.ready).toBe(state === "ready");
  }));
  it.effect("710-1: helper 確認失敗は speech-ja の状態を捏造しない", () => Effect.gen(function* () {
    const report = yield* checkManagedDeps("resume", "claude", { screen: false,
      check: Effect.fail(new HelperCheckFailure({ message: "確認失敗" })),
    }).pipe(Effect.provideService(ManagedDeps, deps("ready")));
    expect(report.items.filter((item) => !["claude", "chromium"].includes(item.name))).toEqual([
      { name: "helper", need: "required", state: "missing", install: "swift build -c release --package-path helper" },
    ]);
    expect(report.ready).toBe(false);
  }));
  it.effect("710-5: play はライブ確認なしで ready となり speech-ja を返さない", () => Effect.gen(function* () {
    const report = yield* checkManagedDeps("play", "claude").pipe(Effect.provideService(ManagedDeps, deps("ready")));
    expect(report.ready).toBe(true);
    expect(report.items.map((item) => item.name)).toEqual(["chromium", "claude"]);
  }));
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
  it.effect.each(["missing", "absent"] as const)("Claude の %s では警告を返さず必須不足になる", (state) =>
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
