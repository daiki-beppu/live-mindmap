import { StartupChecks } from "../src/startupChecks.ts";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Schema, Stream } from "effect";
import { StdoutIsTty } from "../src/consoleText.ts";
import { runCliEntry } from "./fixtures/cliEntry.ts";
import { forbiddenManagedDeps } from "./fixtures/forbiddenManagedDeps.ts";
import { unusedApple } from "./fixtures/appleIntelligence.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";
import { vi } from "vitest";
import { Helpers, HelperCheckFailure, type HelperCheck } from "../src/helpers.ts";
import { CheckReport } from "../src/managedDepsProtocol.ts";
import { helperChecks, readyHelperItems } from "./fixtures/helperCheck.ts";
import { ManagedDeps, ManagedDepsFailed, type DepItem } from "../src/managedDeps.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { temporaryDeps } from "./fixtures/managedDeps.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";
import { startedServer } from "./fixtures/startedServer.ts";

type CheckItem = DepItem;
const states = ["ready", "missing", "outdated", "absent"] as const;
const chromium = (need: CheckItem["need"], state: CheckItem["state"]): CheckItem => ({ name: "chromium", need, state });
const claudeMissing = { name: "claude", need: "required", state: "missing" } as const;
const responseFor = (ready: boolean, item: CheckItem) => ({ ready, items: [{ ...item, size: item.name === "claude" ? 224_000_000 : 211_000_000, install: `pnpm cli install ${item.name}` }, ...readyHelperItems] });

const fakeDeps = (result: Effect.Effect<ReadonlyArray<CheckItem>, ManagedDepsFailed>) => {
  const check = vi.fn((_names: ReadonlyArray<string>) => result);
  const install = vi.fn((_names: ReadonlyArray<string>) => Stream.die("check は導入しない"));
  const load = vi.fn((_name: string) => Effect.die("check は読み込まない"));
  return { service: ManagedDeps.of({ executable: () => Effect.die("実行ファイル取得は対象外"), check, install, update: () => Stream.die("更新は対象外"), load }), check, install };
};

const serverWith = Effect.fnUntraced(function* (dir: string, deps: ManagedDeps["Service"], helperState?: HelperCheck | HelperCheckFailure) {
  const launch = vi.fn(() => Effect.die("check はセッションを開始しない"));
  const helper = helperChecks(helperState);
  const check = vi.fn(helper.check);
  const prepareUpdater = vi.fn(() => Effect.succeed({ layer: updaterLayer(() => Effect.succeed({ ops: [] })) }));
  const server = yield* startedServer({ port: 0, sessionsDir: join(dir, "sessions") }, {
    helpers: Layer.succeed(Helpers, Helpers.of({ ...helper, check, apps: Effect.die("apps は対象外"), launch })),
    sessionSinks: SessionSinks.layer.pipe(Layer.provide(fakeExportServices())), startupChecks: StartupChecks.layer({ prepareUpdater }).pipe(Layer.provide(fakeExportServices())),
    managedDeps: Layer.succeed(ManagedDeps, deps),
  });
  return { ...server, launch, check, prepareUpdater };
});

const runCheck = (dir: string, port: number, model: string | null = "claude", args: string[] = []) => runCliEntry(["check", ...args], Layer.mergeAll(
  forbiddenManagedDeps, NodeServices.layer, unusedApple, NodeHttpClient.layerUndici, fakeExportServices(), fakeScreenJpeg().layer,
  Layer.succeed(StdoutIsTty, false),
  ConfigProvider.layer(ConfigProvider.fromEnvRecord({
    HOME: join(dir, "home"), LIVE_MINDMAP_PORT: String(port), LIVE_MINDMAP_DEPS: join(dir, "deps"), LIVE_MINDMAP_SESSIONS: join(dir, "sessions"),
    LIVE_MINDMAP_CONFIG: join(dir, "absent.config.json"), LIVE_MINDMAP_JUDGE: "off", ...(model === null ? {} : { LIVE_MINDMAP_MODEL: model }),
  })),
));

const recordedHelper: HelperCheck = {
  microphone: "denied", screenCapture: false, speechJa: { status: "installed", installedLocales: ["ja-JP"] },
};
const recordedHelperItems = readyHelperItems.filter((item) => item.name === "helper" || item.name === "speech-ja");
const recordedCases = [
  ...[false, true].flatMap((noMap) => [
    { label: `noMap=${noMap} の helper 不足`, noMap, model: "claude", helper: new HelperCheckFailure({ message: "helper がない" }),
      helperItems: [{ ...readyHelperItems[0], state: "missing" }], claudeNeed: "required", claudeState: "ready", ready: false },
    { label: `noMap=${noMap} の speech-ja 不足`, noMap, model: "claude", helper: { ...recordedHelper, speechJa: { status: "supported", installedLocales: [] } },
      helperItems: recordedHelperItems.map((item) => item.name === "speech-ja" ? { ...item, state: "missing" } : item), claudeNeed: "required", claudeState: "ready", ready: false },
  ] satisfies ReadonlyArray<{
    label: string; noMap: boolean; model: string; helper: HelperCheck | HelperCheckFailure;
    helperItems: ReadonlyArray<typeof CheckReport.Type.items[number]>; claudeNeed: "required"; claudeState: "ready"; ready: boolean;
  }>),
  { label: "マップありの Claude 不足", noMap: undefined, model: "claude", helper: recordedHelper,
    helperItems: recordedHelperItems, claudeNeed: "required", claudeState: "missing", ready: false },
  { label: "マップありの非 Claude 経路", noMap: undefined, model: "apple", helper: recordedHelper,
    helperItems: recordedHelperItems, claudeNeed: "optional", claudeState: "missing", ready: true },
  { label: "noMap は管理依存とモデル設定がなくても確認できる", noMap: true, model: "unknown-model", helper: recordedHelper,
    helperItems: recordedHelperItems, claudeNeed: "required", claudeState: "missing", ready: true },
] as const;

describe.each(["HTTP", "CLI"] as const)("recorded の開始前の確かめ（%s）", (entry) => {
  it.live.each(recordedCases)("$label の JSON を返し、開始・導入しない", (testCase) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const deps = fakeDeps(Effect.succeed([chromium("optional", "missing"), { ...claudeMissing, state: testCase.claudeState }]));
    const server = yield* serverWith(dir, deps.service, testCase.helper);
    let report: typeof CheckReport.Type;
    if (entry === "HTTP") {
      const query = new URLSearchParams({ for: "recorded", route: testCase.model === "unknown-model" ? "invalid" : testCase.model });
      if (testCase.noMap !== undefined) query.set("noMap", String(testCase.noMap));
      const response = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/check?${query}`));
      expect(response.status).toBe(200);
      report = yield* Schema.decodeUnknownEffect(CheckReport)(yield* Effect.tryPromise(() => response.json()));
    } else {
      const result = yield* runCheck(dir, server.port, testCase.model, ["--for", "recorded", ...(testCase.noMap ? ["--no-map"] : [])]);
      expect(result.code).toBe(testCase.ready ? 0 : 3);
      expect(result.stderr).toBe("");
      report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CheckReport))(result.stdout);
    }
    expect(report).toEqual({ ready: testCase.ready, items: [
      ...(testCase.noMap ? [] : [
        { name: "chromium", need: "optional", state: "missing", size: 211_000_000, install: "pnpm cli install chromium" },
        { name: "claude", need: testCase.claudeNeed, state: testCase.claudeState, size: 224_000_000, install: "pnpm cli install claude" },
      ]),
      ...testCase.helperItems,
    ] });
    expect(server.check).toHaveBeenCalledExactlyOnceWith({ screen: false });
    if (testCase.noMap) expect(deps.check).not.toHaveBeenCalled();
    else expect(deps.check).toHaveBeenCalledExactlyOnceWith(["chromium", "claude"]);
    expect(deps.install).not.toHaveBeenCalled();
    expect(server.launch).not.toHaveBeenCalled();
    expect(server.prepareUpdater).not.toHaveBeenCalled();
  }).pipe(Effect.scoped));
});

it.live("HTTP recorded は不正な noMap を確認前に拒否する", () => Effect.gen(function* () {
  const dir = yield* temporaryDeps;
  const deps = fakeDeps(Effect.succeed([]));
  const server = yield* serverWith(dir, deps.service);
  const valid = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/check?for=recorded&noMap=true`));
  expect(valid.status).toBe(200);
  expect(yield* Effect.tryPromise(() => valid.json())).toEqual({ ready: true, items: recordedHelperItems });
  server.check.mockClear();
  const response = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/check?for=recorded&noMap=invalid`));
  expect(response.status).toBe(400);
  expect(deps.check).not.toHaveBeenCalled();
  expect(server.check).not.toHaveBeenCalled();
}).pipe(Effect.scoped));

describe("開始せずに確かめる CLI check", () => {
  it.live("HTTP は不正なモデル経路を状態確認前に拒否する", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const deps = fakeDeps(Effect.succeed([claudeMissing]));
    const server = yield* serverWith(dir, deps.service);
    const response = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/check?route=invalid`));
    expect(response.status).toBe(400);
    expect(deps.check).not.toHaveBeenCalled();
  }).pipe(Effect.scoped));
  it.live("モデル判定を渡さない HTTP check は既定の Claude を必須として返す", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const deps = fakeDeps(Effect.succeed([chromium("optional", "missing"), claudeMissing]));
    const server = yield* serverWith(dir, deps.service);
    const response = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/check`));
    expect(response.status).toBe(200);
    expect(yield* Effect.tryPromise(() => response.json())).toEqual({ ready: false, items: [
      { name: "chromium", need: "optional", state: "missing", size: 211_000_000, install: "pnpm cli install chromium" },
      { name: "claude", need: "required", state: "missing", size: 224_000_000, install: "pnpm cli install claude" },
      ...readyHelperItems,
    ] });
  }).pipe(Effect.scoped));

  it.live.each([
    { selected: null, default: "apple", need: "optional", code: 0 },
    { selected: "remote", default: "apple", need: "required", code: 3 },
  ] as const)("設定 default=$default と環境モデル $selected を開始時と同じ優先順位で使う", ({ selected, default: defaultModel, need, code }) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    yield* Effect.tryPromise(() => writeFile(join(dir, "absent.config.json"), JSON.stringify({ default: defaultModel, models: { remote: { route: "claude", model: "synthetic-model" } } })));
    const deps = fakeDeps(Effect.succeed([chromium("optional", "missing"), claudeMissing]));
    const server = yield* serverWith(dir, deps.service);
    const result = yield* runCheck(dir, server.port, selected);
    expect(result.code).toBe(code);
    const report = JSON.parse(result.stdout);
    expect(report.items.find((item: { name: string }) => item.name === "claude")).toMatchObject({ name: "claude", state: "missing", need });
  }).pipe(Effect.scoped));

  it.live.each([
    { model: "remote", route: "claude", state: "missing", need: "required", ready: false, code: 3 },
    { model: "remote", route: "claude", state: "ready", need: "required", ready: true, code: 0 },
    { model: "claude", route: "openai-compatible", state: "missing", need: "optional", ready: true, code: 0 },
    { model: "account", route: "chatgpt", state: "missing", need: "optional", ready: true, code: 0 },
    { model: "apple", route: "apple", state: "missing", need: "optional", ready: true, code: 0 },
  ] as const)("$model / $route の Claude $state は $need として exit $code を返す", ({ model, route, state, need, ready, code }) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const config = route === "apple" ? {} : { models: { [model]: { route, model: "synthetic-model", ...(route === "openai-compatible" ? { url: "http://127.0.0.1:1/v1" } : {}) } } };
    yield* Effect.tryPromise(() => writeFile(join(dir, "absent.config.json"), JSON.stringify(config)));
    const deps = fakeDeps(Effect.succeed([chromium("optional", "missing"), { ...claudeMissing, state }]));
    const server = yield* serverWith(dir, deps.service);
    const result = yield* runCheck(dir, server.port, model);
    expect(result.code).toBe(code);
    expect(JSON.parse(result.stdout)).toEqual({ ready, items: [
      { name: "chromium", need: "optional", state: "missing", size: 211_000_000, install: "pnpm cli install chromium" },
      { name: "claude", need, state, size: 224_000_000, install: "pnpm cli install claude" },
      ...readyHelperItems,
    ] });
    expect(deps.check).toHaveBeenCalledExactlyOnceWith(["chromium", "claude"]);
    expect(deps.install).not.toHaveBeenCalled();
    expect(server.launch).not.toHaveBeenCalled();
  }).pipe(Effect.scoped));
  it.live.each(states)("HTTP は任意 chromium の %s と容量・導入コマンドを返す", (state) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const item = chromium("optional", state);
    const deps = fakeDeps(Effect.succeed([item]));
    const server = yield* serverWith(dir, deps.service);
    const response = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/check`));
    expect(response.status).toBe(200);
    expect(yield* Effect.tryPromise(() => response.json())).toEqual(responseFor(true, item));
    expect(deps.check).toHaveBeenCalledExactlyOnceWith(["chromium", "claude"]);
  }).pipe(Effect.scoped));

  it.live.each([
    { need: "optional", state: "ready", ready: true, code: 0 },
    { need: "optional", state: "missing", ready: true, code: 0 },
    { need: "optional", state: "outdated", ready: true, code: 0 },
    { need: "optional", state: "absent", ready: true, code: 0 },
    { need: "required", state: "ready", ready: true, code: 0 },
    { need: "required", state: "missing", ready: false, code: 3 },
    { need: "required", state: "outdated", ready: true, code: 0 },
    { need: "required", state: "absent", ready: false, code: 3 },
  ] as const)("CLI は $need / $state の JSON を出して exit $code を返す", ({ need, state, ready, code }) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const item = { name: need === "required" ? "claude" as const : "chromium" as const, need, state, ...(state === "outdated" ? { version: "0.0.0" } : {}) };
    const deps = fakeDeps(Effect.succeed([item]));
    const server = yield* serverWith(dir, deps.service);
    const result = yield* runCheck(dir, server.port);
    expect(result.code).toBe(code);
    expect(JSON.parse(result.stdout)).toEqual(responseFor(ready, item));
    expect(deps.check).toHaveBeenCalledExactlyOnceWith(["chromium", "claude"]);
    expect(result.stderr).toBe("");
  }).pipe(Effect.scoped));

  it.live("ManagedDepsFailed は成功 JSON を出さず exit 1 になる", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const deps = fakeDeps(Effect.fail(new ManagedDepsFailed({ message: "状態確認に失敗しました" })));
    const server = yield* serverWith(dir, deps.service);
    const result = yield* runCheck(dir, server.port);
    expect(deps.check).toHaveBeenCalledExactlyOnceWith(["chromium", "claude"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("状態確認に失敗しました\n");
  }).pipe(Effect.scoped));

  it.live("正常な check の後も導入・セッションの開始・既存ファイルの削除を行わない", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const files = [join(dir, "deps/chromium/.work-retained/keep"), join(dir, "sessions/saved/keep")];
    yield* Effect.tryPromise(async () => {
      await mkdir(join(dir, "deps/chromium/.work-retained"), { recursive: true });
      await mkdir(join(dir, "sessions/saved"), { recursive: true });
      for (const file of files) await writeFile(file, "保存済みの内容");
    });
    const item = chromium("optional", "missing");
    const deps = fakeDeps(Effect.succeed([item]));
    const server = yield* serverWith(dir, deps.service);
    const response = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/check`));
    expect(response.status).toBe(200);
    expect(yield* Effect.tryPromise(() => response.json())).toEqual(responseFor(true, item));
    const result = yield* runCheck(dir, server.port);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(responseFor(true, item));
    expect(deps.check.mock.calls).toEqual([[["chromium", "claude"]], [["chromium", "claude"]]]);
    expect(deps.install).not.toHaveBeenCalled();
    expect(server.launch).not.toHaveBeenCalled();
    for (const file of files) expect(yield* Effect.tryPromise(() => readFile(file, "utf8"))).toBe("保存済みの内容");
  }).pipe(Effect.scoped));
});
