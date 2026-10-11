import { defaultClaude } from "../src/modelSelection.ts";
import { it as effectIt } from "@effect/vitest";
import { Console, Effect, FileSystem, Layer, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect, vi } from "vitest";
import { claudeUpdaterLayer, prepareUpdaterLayer } from "../src/diffUpdater.ts";
import { AppleIntelligence } from "../src/appleIntelligence.ts";
import { DiffUpdater, emptyMap } from "../src/core/index.ts";
import { ManagedDeps, ManagedDepsFailed } from "../src/managedDeps.ts";
import type { AgentSdk } from "../src/claude.ts";
import { unusedApple } from "./fixtures/appleIntelligence.ts";

// 置換前の通常依存経路でも、本物の Claude を呼ばない。
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: () => { throw new Error("通常依存の SDK を呼びました"); } }));
const load = vi.fn((_name: string) => Effect.fail(new ManagedDepsFailed({ message: "管理 SDK がありません" })));
const managedDeps = Layer.succeed(ManagedDeps, ManagedDeps.of({
  check: () => Effect.die("状態確認は対象外"), install: () => Stream.die("導入は対象外"), load,
}));

effectIt.effect("管理 SDK を読めないと UpdaterUnavailable で失敗する", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(Layer.build(claudeUpdaterLayer(defaultClaude).pipe(Layer.provide(managedDeps))));
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "UpdaterUnavailable", message: "管理 SDK がありません" } });
  }).pipe(Effect.scoped),
);

effectIt.effect("Claude の準備で取得した SDK を再読込せず、更新の query を消費側 Scope で閉じる", () => Effect.gen(function* () {
  const close = vi.fn();
  const query = vi.fn(() => Object.assign((async function* () {
    yield { type: "result", subtype: "success", structured_output: { ops: [{ op: "noop", reason: "管理 SDK の応答" }] } };
  })(), { close })) as unknown as AgentSdk["Service"]["query"];
  const loaded = vi.fn((_name: string) => Effect.succeed({ query }));
  const deps = Layer.succeed(ManagedDeps, ManagedDeps.of({
    check: () => Effect.die("状態確認は対象外"), install: () => Stream.die("導入は対象外"),
    load: loaded as unknown as ManagedDeps["Service"]["load"],
  }));
  const layer = yield* prepareUpdaterLayer(defaultClaude).pipe(Effect.provide(Layer.mergeAll(
    deps, unusedApple,
    Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => Effect.die("Claude は HTTP 準備を使いません"))),
    Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({})),
  )));
  expect(loaded).toHaveBeenCalledExactlyOnceWith("claude");
  expect(query).not.toHaveBeenCalled();
  yield* Effect.gen(function* () {
    const updater = yield* DiffUpdater;
    const result = yield* updater.update({ map: emptyMap("定例"), recent: [],
      fresh: [{ id: "r1", track: "相手", start: 0, end: 1, text: "合成の発言" }],
    });
    expect(result.ops).toEqual([{ op: "noop", reason: "管理 SDK の応答" }]);
    expect(query).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  }).pipe(Effect.provide(layer));
  expect(loaded).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledOnce();
}));

const localModel = { name: "apple" as const, route: "apple" as const, local: true as const };
const localPreparation = (status: number) => {
  const requests: string[] = [];
  const apple = Layer.succeed(AppleIntelligence, AppleIntelligence.of({
    availability: Effect.succeed({ osVersion: "27.0", availability: { status: "available" } }),
    launch: Effect.succeed({ url: "http://127.0.0.1:8766/v1", pid: 4242, exited: Effect.never }),
  }));
  const client = HttpClient.make((request) => Effect.sync(() => {
    requests.push(request.url);
    return HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      議題: { id: "新しい議題", 題: "採用" }, 文: [{ 種類: "説明", text: "面接官は3人" }], 済み: "なし",
    }) } }] }), { status, headers: { "content-type": "application/json" } }));
  }));
  const prepare = prepareUpdaterLayer(localModel).pipe(Effect.provide(apple),
    Effect.provide(managedDeps), Effect.provideService(HttpClient.HttpClient, client), Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})));
  return { prepare, requests };
};

effectIt.effect("Apple の準備と差分更新が成功しても管理 SDK を読み込まない", () => Effect.gen(function* () {
  const fake = localPreparation(200);
  const before = load.mock.calls.length;
  const layer = yield* fake.prepare;
  const updater = yield* DiffUpdater.pipe(Effect.provide(layer));
  const result = yield* updater.update({ map: emptyMap("定例"), recent: [],
    fresh: [{ id: "r1", track: "相手", start: 0, end: 1, text: "面接官は3人です。" }],
  });
  expect(result.ops).toContainEqual(expect.objectContaining({ op: "add", text: "面接官は3人" }));
  expect(fake.requests).toEqual(["http://127.0.0.1:8766/v1/chat/completions", "http://127.0.0.1:8766/v1/chat/completions"]);
  expect(load.mock.calls.length).toBe(before);
}));

effectIt.effect("Apple の準備成功時に子の PID・宛先と試験的の二行を標準エラーへ一度出す", () => Effect.gen(function* () {
  const output: string[] = [];
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
  const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { output.push(args.map(String).join(" ") + "\n"); });
  try {
    const fake = localPreparation(200);
    yield* fake.prepare.pipe(Effect.provideService(Console.Console, { ...console, error }));
    expect(fake.requests).toHaveLength(1);
    const lines = output.join("").split("\n");
    expect(lines.filter((line) => line === "ローカルモード: Apple Intelligence（子プロセス PID 4242、宛先 http://127.0.0.1:8766/v1）")).toHaveLength(1);
    expect(lines.filter((line) => line === "Apple Intelligence は試験的で、決定・TODO を拾いすぎ・取りこぼしがあります")).toHaveLength(1);
  } finally {
    stderr.mockRestore();
    error.mockRestore();
  }
}));

effectIt.effect("Apple の接続確認が失敗したらローカルモードの成功ログを出さない", () => Effect.gen(function* () {
  const output: string[] = [];
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
  const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { output.push(args.map(String).join(" ") + "\n"); });
  try {
    const fake = localPreparation(500);
    const result = yield* Effect.result(fake.prepare.pipe(Effect.provideService(Console.Console, { ...console, error })));
    expect(result._tag).toBe("Failure");
    expect(fake.requests).toHaveLength(1);
    expect(output.join("")).not.toContain("ローカルモード:");
  } finally {
    stderr.mockRestore();
    error.mockRestore();
  }
}));
