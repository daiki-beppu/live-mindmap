import { defaultClaude } from "../src/modelSelection.ts";
import { it as effectIt } from "@effect/vitest";
import { Console, Effect, Exit, FileSystem, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect, vi } from "vitest";
import { claudeUpdaterLayer, prepareUpdaterLayer } from "../src/diffUpdater.ts";
import { AppleIntelligence } from "../src/appleIntelligence.ts";
import { DiffUpdater, emptyMap } from "../src/core/index.ts";

// SDK が利用できない環境でも Apple を使えることを確かめるため、読み込みを記録して失敗させる。
const loaded = vi.hoisted(() => ({ claude: 0, sdk: 0 }));
vi.mock("../src/claude.ts", async (original) => {
  loaded.claude++;
  return await original<typeof import("../src/claude.ts")>();
});
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  loaded.sdk++;
  throw new Error("ローカルモードで SDK を読み込みました");
});

effectIt.effect("claude.ts を import できないと UpdaterUnavailable で失敗する", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(Layer.build(claudeUpdaterLayer(defaultClaude)));
    expect(Exit.isFailure(exit)).toBe(true);
    const err = Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "";
    expect(err).toContain("UpdaterUnavailable");
    expect(loaded.claude).toBeGreaterThan(0);
    expect(loaded.sdk).toBeGreaterThan(0);
  }).pipe(Effect.scoped),
);

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
    Effect.provideService(HttpClient.HttpClient, client), Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})));
  return { prepare, requests };
};

effectIt.effect("Apple の準備と差分更新が成功しても Claude と Agent SDK を読み込まない", () => Effect.gen(function* () {
  const fake = localPreparation(200);
  const before = { ...loaded };
  const layer = yield* fake.prepare;
  const updater = yield* DiffUpdater.pipe(Effect.provide(layer));
  const result = yield* updater.update({ map: emptyMap("定例"), recent: [],
    fresh: [{ id: "r1", track: "相手", start: 0, end: 1, text: "面接官は3人です。" }],
  });
  expect(result.ops).toContainEqual(expect.objectContaining({ op: "add", text: "面接官は3人" }));
  expect(fake.requests).toEqual(["http://127.0.0.1:8766/v1/chat/completions", "http://127.0.0.1:8766/v1/chat/completions"]);
  expect(loaded).toEqual(before);
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
