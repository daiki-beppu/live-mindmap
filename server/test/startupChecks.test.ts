import { helperChecks } from "./fixtures/helperCheck.ts";
import { describe, expect, it } from "@effect/vitest";
import { expectTypeOf } from "vitest";
import { Effect, Layer, Result, Stream, type Scope } from "effect";
import { DiffUpdater } from "../src/core/index.ts";
import { Helpers, HelperCheckFailure, type HelperCheck } from "../src/helpers.ts";
import { ManagedDeps, type DepItem } from "../src/managedDeps.ts";
import { defaultClaude } from "../src/modelSelection.ts";
import { StartupChecks } from "../src/startupChecks.ts";
import type { UpdatePlan } from "../src/updatePlan.ts";
import { UpdaterUnavailable } from "../src/updaterUnavailable.ts";
import claudeManifest from "../managed-deps/claude/package.json" with { type: "json" };
import chromiumManifest from "../managed-deps/chromium/package.json" with { type: "json" };

const plan: UpdatePlan = { kind: "single", model: defaultClaude };
const updaterLayer = Layer.succeed(DiffUpdater, DiffUpdater.of({ update: () => Effect.succeed({ ops: [] }) }));
const prepared = Effect.succeed({ layer: updaterLayer });

const helperLayer = (state: HelperCheck | HelperCheckFailure) => Layer.succeed(Helpers, Helpers.of({
  ...helperChecks(state),
  apps: Effect.die("開始前の確かめはアプリを列挙しない"),
  launch: () => Effect.die("開始前の確かめはヘルパーを起動しない"),
}));

const readyHelper: HelperCheck = { microphone: "authorized", screenCapture: true, speechJa: { status: "installed", installedLocales: ["ja-JP"] } };
const depsLayer = (states: Partial<Record<DepItem["name"], DepItem["state"]>>) => Layer.succeed(ManagedDeps, ManagedDeps.of({
  check: (names) => Effect.sync(() => names.map((name): DepItem => {
    if (name !== "claude" && name !== "chromium" && name !== "cloudflared") throw new Error(`未知の依存: ${name}`);
    return { name, need: "optional", state: states[name] ?? "ready", ...(states[name] === "outdated" ? { version: "0.0.0" } : {}) };
  })),
  load: () => Effect.die("確認は管理依存を読み込まない"),
  executable: () => Effect.die("確認は実行ファイルを取得しない"),
  install: () => Stream.die("確認は導入しない"),
  update: () => Stream.die("確認は更新しない"),
}));

const checksLayer = (
  states: Partial<Record<DepItem["name"], DepItem["state"]>> = {},
  helper: HelperCheck | HelperCheckFailure = readyHelper,
  preparation: Effect.Effect<{ readonly layer: Layer.Layer<DiffUpdater, UpdaterUnavailable>; readonly notice?: string }, UpdaterUnavailable, Scope.Scope> = prepared,
) => StartupChecks.layer({ prepareUpdater: (_plan: UpdatePlan) => preparation }).pipe(
  Layer.provideMerge(Layer.mergeAll(depsLayer(states), helperLayer(helper))),
);

const mapRows = [
  { entry: "start", route: "claude", screen: false, plan },
  { entry: "recorded", route: "claude", noMap: false, plan },
  { entry: "play", route: "claude", plan },
] as const;
const rows = [...mapRows, { entry: "resume", route: "claude", screen: false }, { entry: "recorded", noMap: true }] as const;
const nonClaudeRows = [
  { route: "openai-compatible", plan: { kind: "single", model: { name: "remote", route: "openai-compatible", model: "synthetic", url: "http://127.0.0.1:1/v1", local: false } } },
  { route: "chatgpt", plan: { kind: "single", model: { name: "account", route: "chatgpt", model: "synthetic", local: false } } },
  { route: "apple", plan: { kind: "single", model: { name: "apple", route: "apple", local: true } } },
] as const satisfies ReadonlyArray<{ readonly route: "openai-compatible" | "chatgpt" | "apple"; readonly plan: UpdatePlan }>;

describe("開始前の確かめ", () => {
  it.effect("入口ごとの入力と準備結果を型で区別する", () => Effect.gen(function* () {
    const checks = yield* StartupChecks;
    // @ts-expect-error recorded は共有画面の入力を受け取らない
    expectTypeOf(() => checks.report({ entry: "recorded", route: "claude", noMap: false, screen: true }));
    // @ts-expect-error play は共有画面の入力を受け取らない
    expectTypeOf(() => checks.report({ entry: "play", route: "claude", screen: false }));
    // @ts-expect-error noMap は recorded だけの入力
    expectTypeOf(() => checks.report({ entry: "start", route: "claude", screen: true, noMap: true }));
    // @ts-expect-error resume は updater を準備しない
    expectTypeOf(() => checks.prepare({ entry: "resume", route: "claude", screen: true, plan }));
    // @ts-expect-error noMap は updater を準備しない
    expectTypeOf(() => checks.prepare({ entry: "recorded", noMap: true, plan }));
    const map = yield* checks.prepare(mapRows[0]);
    expectTypeOf(map.updaterLayer).toExtend<Layer.Layer<DiffUpdater, UpdaterUnavailable>>();
    const resume = yield* checks.prepare({ entry: "resume", route: "claude", screen: false });
    // @ts-expect-error resume の戻り値は warnings だけ
    expectTypeOf(resume.updaterLayer);
    const noMap = yield* checks.prepare({ entry: "recorded", noMap: true });
    // @ts-expect-error noMap の戻り値は warnings だけ
    expectTypeOf(noMap.updaterLayer);
  }).pipe(Effect.provide(checksLayer())));

  it.effect.each([
    { status: "installed", locales: [], state: "ready" },
    { status: "supported", locales: [], state: "missing" },
    { status: "supported", locales: ["ja-JP", "ja_JP"], state: "missing" },
    { status: "downloading", locales: ["ja-JP"], state: "missing" },
    { status: "unsupported", locales: [], state: "missing" },
  ] as const)("speech-ja $status / $locales は $state として報告と準備が一致する", ({ status, locales, state }) => Effect.gen(function* () {
    const checks = yield* StartupChecks;
    const report = yield* checks.report(mapRows[0]);
    expect(report.items.filter((item) => item.name === "speech-ja")).toEqual([
      { name: "speech-ja", need: "required", state, install: "pnpm cli install speech-ja" },
    ]);
    expect(report.ready).toBe(state === "ready");
    expect(Result.isSuccess(yield* Effect.result(checks.prepare(mapRows[0])))).toBe(report.ready);
  }).pipe(Effect.provide(checksLayer({}, { ...readyHelper, speechJa: { status, installedLocales: locales } }))));

  it.effect("準備で取得した資源はサービス構築時でなく呼び出し元の Scope で閉じる", () => Effect.gen(function* () {
    const state = { opened: 0, closed: 0 };
    const checks = yield* StartupChecks.pipe(Effect.provide(checksLayer({}, readyHelper, Effect.acquireRelease(
      Effect.sync(() => { state.opened++; return { layer: updaterLayer }; }),
      () => Effect.sync(() => { state.closed++; }),
    ))));
    expect(state).toEqual({ opened: 0, closed: 0 });
    for (const attempt of [1, 2]) {
      yield* Effect.scoped(Effect.gen(function* () {
        yield* checks.prepare(mapRows[0]).pipe(Effect.provide(helperLayer(readyHelper)));
        expect(state).toEqual({ opened: attempt, closed: attempt - 1 });
      }));
      expect(state).toEqual({ opened: attempt, closed: attempt });
    }
  }));

  it.effect.each(rows)("$entry の行は必須がそろえば ready と準備の成功が一致する", (input) => Effect.gen(function* () {
    const checks = yield* StartupChecks;
    const report = yield* checks.report(input);
    expect(report.ready).toBe(true);
    expect(yield* checks.prepare(input)).toMatchObject({ warnings: [] });
  }).pipe(Effect.provide(checksLayer())));

  it.effect.each(mapRows)("$entry のマップを作る行は updaterLayer を返す", (input) => Effect.gen(function* () {
    const result = yield* (yield* StartupChecks).prepare(input);
    expect(result.warnings).toEqual([]);
    expect(Layer.isLayer(result.updaterLayer)).toBe(true);
  }).pipe(Effect.provide(checksLayer())));

  it.effect.each([
    { entry: "resume", route: "claude", screen: false },
    { entry: "recorded", noMap: true },
  ] as const)("$entry の updater を組まない行は warnings だけを返す", (input) => Effect.gen(function* () {
    expect(yield* (yield* StartupChecks).prepare(input)).toEqual({ warnings: [] });
  }).pipe(Effect.provide(checksLayer({}, readyHelper, Effect.fail(new UpdaterUnavailable({ message: "準備は不要" }))))));

  it.effect("報告は updater の準備失敗に影響されず items を返す", () => Effect.gen(function* () {
    const report = yield* (yield* StartupChecks).report({ entry: "start", route: "claude", screen: true });
    expect(report).toMatchObject({ ready: true, items: expect.arrayContaining([
      { name: "microphone", need: "optional", state: "ready" },
      { name: "screen-capture", need: "optional", state: "ready" },
    ]) });
  }).pipe(Effect.provide(checksLayer({}, readyHelper, Effect.fail(new UpdaterUnavailable({ message: "報告は準備しない" }))))));

  it.effect("必須不足をすべてまとめ、任意不足や準備失敗で置き換えない", () => Effect.gen(function* () {
    const checks = yield* StartupChecks;
    const input = { entry: "start", route: "claude", screen: true, plan } as const;
    expect((yield* checks.report(input)).ready).toBe(false);
    const result = yield* Effect.result(checks.prepare(input));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({ _tag: "StartupDepsMissing" });
      if (result.failure._tag === "StartupDepsMissing") {
        expect(result.failure.items.map((item) => ({ name: item.name, need: item.need, state: item.state })))
          .toEqual([{ name: "claude", need: "required", state: "missing" }, { name: "speech-ja", need: "required", state: "missing" }]);
      }
    }
  }).pipe(Effect.provide(checksLayer({ claude: "missing", chromium: "missing" }, {
    microphone: "denied", screenCapture: false, speechJa: { status: "supported", installedLocales: [] },
  }, Effect.fail(new UpdaterUnavailable({ message: "準備より先に不足を返す" }))))));

  it.effect.each(["missing", "absent"] as const)("claude の %s は必須不足で止まる", (state) => Effect.gen(function* () {
    const result = yield* Effect.result((yield* StartupChecks).prepare(mapRows[0]));
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "StartupDepsMissing", items: [expect.objectContaining({ name: "claude", state, need: "required" })] } });
  }).pipe(Effect.provide(checksLayer({ claude: state }))));

  it.effect.each(nonClaudeRows)("$route の start は claude の欠けを報告に残し、補足なしの通知を一度だけ返す", ({ route, plan }) => Effect.gen(function* () {
    const checks = yield* StartupChecks;
    const input = { entry: "start", route, screen: false } as const;
    expect(yield* checks.report(input)).toMatchObject({ ready: true, items: expect.arrayContaining([
      { name: "claude", need: "optional", state: "missing", size: 224_000_000, install: "pnpm cli install claude" },
    ]) });
    const result = yield* checks.prepare({ ...input, plan });
    expect(result.warnings).toEqual([
      "警告: chromium（Chromium、約 211MB） がありません。入れるには: pnpm cli install chromium",
      "補足なしで始めます",
    ]);
    expect(Layer.isLayer(result.updaterLayer)).toBe(true);
  }).pipe(Effect.provide(checksLayer({ claude: "missing", chromium: "missing" }))));

  it.effect.each(nonClaudeRows)("$route の start は claude の版違いを警告せず、補足なしの通知を一度だけ返す", ({ route, plan }) => Effect.gen(function* () {
    const result = yield* (yield* StartupChecks).prepare({ entry: "start", route, screen: false, plan });
    expect(result.warnings).toEqual(["補足なしで始めます"]);
    expect(Layer.isLayer(result.updaterLayer)).toBe(true);
  }).pipe(Effect.provide(checksLayer({ claude: "outdated" }))));

  it.effect.each(nonClaudeRows)("$route の play は補足なしの通知と既存の判定通知を一度ずつ返す", ({ route, plan }) => Effect.gen(function* () {
    const result = yield* (yield* StartupChecks).prepare({ entry: "play", route, plan });
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.filter((warning) => warning === "補足なしで始めます")).toEqual(["補足なしで始めます"]);
    expect(result.warnings.filter((warning) => warning === "判定の鍵がありません")).toEqual(["判定の鍵がありません"]);
  }).pipe(Effect.provide(checksLayer({}, readyHelper, Effect.succeed({ layer: updaterLayer, notice: "判定の鍵がありません" })))));

  it.effect.each(["start", "resume"] as const)("%s は共有画面なしなら画面収録の item も警告も返さない", (entry) => Effect.gen(function* () {
    const checks = yield* StartupChecks;
    const input = { entry, route: "claude", screen: false } as const;
    expect((yield* checks.report(input)).items.map((item) => item.name)).toEqual(["chromium", "claude", "helper", "microphone", "speech-ja"]);
    const result = yield* (entry === "start" ? checks.prepare({ ...input, entry, plan }) : checks.prepare({ ...input, entry }));
    expect(result.warnings).toEqual([]);
  }).pipe(Effect.provide(checksLayer({}, { ...readyHelper, screenCapture: false }))));

  it.effect.each(["start", "resume"] as const)("%s は画面収録の許可なしでも警告して通る", (entry) => Effect.gen(function* () {
    const checks = yield* StartupChecks;
    const input = { entry, route: "claude", screen: true } as const;
    expect(yield* checks.report(input)).toMatchObject({ ready: true, items: expect.arrayContaining([{ name: "screen-capture", need: "optional", state: "absent" }]) });
    const result = yield* (entry === "start" ? checks.prepare({ ...input, entry, plan }) : checks.prepare({ ...input, entry }));
    expect(result.warnings).toEqual(["画面収録の許可がありません。共有画面は読まず、音声だけで始めます"]);
  }).pipe(Effect.provide(checksLayer({}, { ...readyHelper, screenCapture: false }))));

  it.effect.each([
    { microphone: "denied", warning: "マイクの許可がありません。自分の声が入りません" },
    { microphone: "notDetermined", warning: "マイクの許可が未決定です。開始時に許可のダイアログが出ます" },
  ] as const)("マイク $microphone は start と resume を止めない", ({ microphone, warning }) => Effect.gen(function* () {
    const checks = yield* StartupChecks;
    expect((yield* checks.prepare(mapRows[0])).warnings).toEqual([warning]);
    expect(yield* checks.prepare({ entry: "resume", route: "claude", screen: false })).toEqual({ warnings: [warning] });
  }).pipe(Effect.provide(checksLayer({}, { ...readyHelper, microphone }))));

  it.effect.each(rows)("$entry の helper 失敗は読めない speech-ja や権限を補わない", (input) => Effect.gen(function* () {
    const checks = yield* StartupChecks;
    const report = yield* checks.report(input);
    if (input.entry === "play") {
      expect(report).toMatchObject({ ready: true });
      expect(report.items.map((item) => item.name)).toEqual(["chromium", "claude"]);
      const result = yield* checks.prepare(input);
      expect(result.warnings).toEqual([]);
      expect(Layer.isLayer(result.updaterLayer)).toBe(true);
    } else {
      expect(report.ready).toBe(false);
      expect(report.items.filter((item) => !["chromium", "claude"].includes(item.name)))
        .toEqual([{ name: "helper", need: "required", state: "missing", install: "swift build -c release --package-path helper" }]);
      expect(yield* Effect.result(checks.prepare(input))).toMatchObject({ _tag: "Failure", failure: { _tag: "StartupDepsMissing", items: [expect.objectContaining({ name: "helper" })] } });
    }
  }).pipe(Effect.provide(checksLayer({}, new HelperCheckFailure({ message: "helper がない" })))));

  it.effect.each([false, true])("recorded noMap=%s はマイクと画面収録の許可を問わない", (noMap) => Effect.gen(function* () {
    const checks = yield* StartupChecks;
    const input = noMap ? { entry: "recorded", noMap: true } as const : mapRows[1];
    expect((yield* checks.report(input)).items.map((item) => item.name)).toEqual(noMap ? ["helper", "speech-ja"] : ["chromium", "claude", "helper", "speech-ja"]);
    expect((yield* checks.prepare(input)).warnings).toEqual([]);
  }).pipe(Effect.provide(checksLayer({}, { ...readyHelper, microphone: "denied", screenCapture: false }))));

  it.effect("noMap は管理依存がなくても helper と speech-ja だけで通る", () => Effect.gen(function* () {
    const checks = yield* StartupChecks;
    const input = { entry: "recorded", noMap: true } as const;
    expect(yield* checks.report(input)).toMatchObject({ ready: true, items: [expect.objectContaining({ name: "helper" }), expect.objectContaining({ name: "speech-ja" })] });
    expect(yield* checks.prepare(input)).toEqual({ warnings: [] });
  }).pipe(Effect.provide(checksLayer({ claude: "missing", chromium: "missing" }))));

  it.effect.each([false, true])("recorded noMap=%s は speech-ja がなければ止まる", (noMap) => Effect.gen(function* () {
    const checks = yield* StartupChecks;
    const input = noMap ? { entry: "recorded", noMap: true } as const : mapRows[1];
    expect((yield* checks.report(input)).ready).toBe(false);
    expect(yield* Effect.result(checks.prepare(input))).toMatchObject({ _tag: "Failure", failure: { _tag: "StartupDepsMissing", items: [expect.objectContaining({ name: "speech-ja", state: "missing" })] } });
  }).pipe(Effect.provide(checksLayer({}, { ...readyHelper, speechJa: { status: "supported", installedLocales: [] } }))));

  it.effect.each([...mapRows, { entry: "resume", route: "claude", screen: false }] as const)("$entry の Chromium 不足は警告して通る", (input) => Effect.gen(function* () {
    expect((yield* (yield* StartupChecks).prepare(input)).warnings).toEqual(["警告: chromium（Chromium、約 211MB） がありません。入れるには: pnpm cli install chromium"]);
  }).pipe(Effect.provide(checksLayer({ chromium: "missing" }))));

  it.effect("Chromium の版違いは警告して通る", () => Effect.gen(function* () {
    const checks = yield* StartupChecks;
    expect((yield* checks.report(mapRows[0])).ready).toBe(true);
    expect((yield* checks.prepare(mapRows[0])).warnings).toEqual([
      `警告: chromium（Chromium、約 211MB） が版違いです（入っている版 0.0.0、固定版 ${chromiumManifest.dependencies["playwright-core"]}）。そろえるには: pnpm cli update chromium`,
    ]);
  }).pipe(Effect.provide(checksLayer({ chromium: "outdated" }))));

  it.effect("必須 claude の版違いは ready と準備成功が一致し、版付きの警告になる", () => Effect.gen(function* () {
    const checks = yield* StartupChecks;
    expect((yield* checks.report(mapRows[0])).ready).toBe(true);
    expect((yield* checks.prepare(mapRows[0])).warnings).toEqual([
      `警告: claude（Claude Agent SDK、約 224MB） が版違いです（入っている版 0.0.0、固定版 ${claudeManifest.dependencies["@anthropic-ai/claude-agent-sdk"]}）。そろえるには: pnpm cli update claude`,
    ]);
  }).pipe(Effect.provide(checksLayer({ claude: "outdated" }))));

  it.effect.each(mapRows)("$entry の notice は依存警告と権限警告の後ろに一度だけ付く", (input) => Effect.gen(function* () {
    const result = yield* (yield* StartupChecks).prepare(input.entry === "start" ? { ...input, screen: true } : input);
    expect(result.warnings).toEqual([
      "警告: chromium（Chromium、約 211MB） がありません。入れるには: pnpm cli install chromium",
      ...(input.entry === "start" ? [
        "マイクの許可がありません。自分の声が入りません",
        "画面収録の許可がありません。共有画面は読まず、音声だけで始めます",
      ] : []),
      "判定の鍵がありません",
    ]);
  }).pipe(Effect.provide(checksLayer({ chromium: "missing" }, { ...readyHelper, microphone: "denied", screenCapture: false }, Effect.succeed({ layer: updaterLayer, notice: "判定の鍵がありません" })))));

  it.effect.each([
    { failure: new UpdaterUnavailable({ message: "読込失敗", dependency: "claude" }), expected: { _tag: "StartupDepsMissing", items: [expect.objectContaining({ name: "claude", need: "required", state: "missing", size: 224_000_000, install: "pnpm cli install claude" })] } },
    { failure: new UpdaterUnavailable({ message: "接続失敗" }), expected: { _tag: "UpdaterUnavailable", message: "接続失敗" } },
  ])("準備失敗 $failure.message は dependency の有無で変換する", ({ failure, expected }) => Effect.gen(function* () {
    const result = yield* Effect.result((yield* StartupChecks).prepare(mapRows[0]));
    expect(result).toMatchObject({ _tag: "Failure", failure: expected });
  }).pipe(Effect.provide(checksLayer({}, readyHelper, Effect.fail(failure)))));
});
