import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Console, Effect, Layer, Result, Stream } from "effect";
import { vi } from "vitest";
import { runCli } from "../src/cli.ts";
import { ManagedDeps, type DepItem } from "../src/managedDeps.ts";
import type { AgentSdk } from "../src/claude.ts";
import manifest from "../managed-deps/claude/package.json" with { type: "json" };
import { unusedApple } from "./fixtures/appleIntelligence.ts";
import { runCliEntry } from "./fixtures/cliEntry.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { managedLayer, temporaryDeps } from "./fixtures/managedDeps.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";

const fixture = join(import.meta.dirname, "fixtures/short.transcript.json");
const refusal = "開始しません。足りないもの: claude（Claude Agent SDK、約 224MB）\n入れるには: pnpm cli install claude\n利用者に確認してから入れてください\n";
type Item = DepItem;

const localCli = (root: string, args: string[]) => runCliEntry(args, Layer.mergeAll(
  managedLayer(join(root, "deps")), NodeServices.layer, unusedApple, NodeHttpClient.layerUndici, fakeExportServices(), fakeScreenJpeg().layer,
  ConfigProvider.layer(ConfigProvider.fromEnvRecord({
    HOME: join(root, "home"), LIVE_MINDMAP_CONFIG: join(root, "config.json"), LIVE_MINDMAP_JUDGE: "off", LIVE_MINDMAP_MODEL: "claude",
    LIVE_MINDMAP_SESSIONS: join(root, "sessions"), LIVE_MINDMAP_DEPS: join(root, "deps"), LIVE_MINDMAP_PORT: "0",
  })),
));

const dependencies = (root: string, items: Item[]) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const query = vi.fn((params: { prompt: AsyncIterable<unknown> }) => Object.assign((async function* () {
    for await (const _message of params.prompt) yield { type: "result", subtype: "success", structured_output: { ops: [] } };
  })(), { close: () => {} })) as unknown as AgentSdk["Service"]["query"];
  const check = vi.fn((names: ReadonlyArray<string>) => Effect.succeed(items.filter((item) => names.includes(item.name))));
  const load = vi.fn((_name: string) => Effect.succeed({ query }));
  const install = vi.fn(() => Stream.die("再生の確かめでは導入しません"));
  const managed = Layer.succeed(ManagedDeps, ManagedDeps.of({ executable: () => Effect.die("実行ファイル取得は対象外"), check, install, update: () => Stream.die("更新は対象外"), load: load as unknown as ManagedDeps["Service"]["load"] }));
  const layer = Layer.mergeAll(
    managed, NodeServices.layer, unusedApple, NodeHttpClient.layerUndici, fakeExportServices(), fakeScreenJpeg().layer,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: join(root, "home"), LIVE_MINDMAP_CONFIG: join(root, "config.json"), LIVE_MINDMAP_JUDGE: "off",
      LIVE_MINDMAP_SESSIONS: join(root, "sessions"), LIVE_MINDMAP_PORT: "0" })),
    Layer.succeed(Console.Console, { ...console,
      log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ") + "\n"); },
      error: (...args: unknown[]) => { stderr.push(args.map(String).join(" ") + "\n"); },
    }),
  );
  return { layer, stdout, stderr, check, load, install, query };
};

describe("サーバーを使わない再生の開始前の確かめ", () => {
  it.live("CLI play は Claude 未導入を3行の stderr と exit 3 にする", () => Effect.gen(function* () {
    const root = yield* temporaryDeps;
    const result = yield* localCli(root, ["play", fixture]);
    expect(result).toEqual({ code: 3, stdout: "", stderr: refusal });
    expect(existsSync(join(root, "sessions"))).toBe(false);
  }).pipe(Effect.scoped));

  it.live("Issue #983: play --judge は知らない名前を依存の確かめより前に断る", () => Effect.gen(function* () {
    const root = yield* temporaryDeps;
    const result = yield* localCli(root, ["play", fixture, "--judge", "missing"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("判定のモデル missing が設定にありません");
    expect(result.stderr).not.toContain("足りないもの");
    expect(existsSync(join(root, "sessions"))).toBe(false);
  }).pipe(Effect.scoped));

  it.live("check --for play はサーバーなしで JSON と exit 3 を返す", () => Effect.gen(function* () {
    const root = yield* temporaryDeps;
    const result = yield* localCli(root, ["check", "--for", "play"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ ready: false, items: [
      { name: "chromium", need: "optional", state: "missing", size: 211_000_000, install: "pnpm cli install chromium" },
      { name: "claude", need: "required", state: "missing", size: 224_000_000, install: "pnpm cli install claude" },
    ] });
    expect(existsSync(join(root, "sessions"))).toBe(false);
  }).pipe(Effect.scoped));

  it.live("play は偽 ManagedDeps の必須不足を SDK 読込・書き出しより前に拒否する", () => Effect.gen(function* () {
    const root = yield* temporaryDeps;
    const deps = dependencies(root, [{ name: "claude", need: "optional", state: "missing" }, { name: "chromium", need: "optional", state: "ready" }]);
    const result = yield* Effect.result(runCli(["play", fixture]).pipe(Effect.provide(deps.layer)));
    expect(Result.isFailure(result)).toBe(true);
    expect(deps.load).not.toHaveBeenCalled();
    expect(deps.stdout).toEqual([]);
    expect(existsSync(join(root, "sessions"))).toBe(false);
    expect(deps.install).not.toHaveBeenCalled();
  }).pipe(Effect.scoped));

  it.live("Chromium だけの欠けは警告し、偽の管理 SDK で再生を完了して成果物を出す", () => Effect.gen(function* () {
    const root = yield* temporaryDeps;
    const deps = dependencies(root, [{ name: "claude", need: "optional", state: "ready" }, { name: "chromium", need: "optional", state: "missing" }]);
    yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));
    expect(deps.stderr.join("")).toContain("chromium");
    expect(deps.load).toHaveBeenCalledExactlyOnceWith("claude");
    expect(deps.query).toHaveBeenCalled();
    const paths = deps.stdout.join("").trim().split("\n");
    expect(paths.some((path) => path.endsWith("/map.json"))).toBe(true);
    for (const path of paths) expect(existsSync(path)).toBe(true);
    const log = yield* Effect.tryPromise(() => readFile(join(dirname(paths[0]!), "log.jsonl"), "utf8"));
    expect(log.trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.type === "start")).toHaveLength(1);
    expect(deps.install).not.toHaveBeenCalled();
  }).pipe(Effect.scoped));

  it.live.each([
    { name: "remote", route: "claude", definition: { route: "claude", model: "synthetic" }, need: "required", ready: false },
    { name: "claude", route: "openai-compatible", definition: { route: "openai-compatible", model: "synthetic", url: "http://127.0.0.1:1/v1" }, need: "optional", ready: true },
    { name: "account", route: "chatgpt", definition: { route: "chatgpt", model: "synthetic" }, need: "optional", ready: true },
    { name: "apple", route: "apple", definition: undefined, need: "optional", ready: true },
  ] as const)("check --for play は名前でなく $route の必要度をローカルで回答する", ({ name, definition, need, ready }) => Effect.gen(function* () {
    const root = yield* temporaryDeps;
    yield* Effect.tryPromise(() => writeFile(join(root, "config.json"), JSON.stringify({ default: name, ...(definition === undefined ? {} : { models: { [name]: definition } }) })));
    const deps = dependencies(root, [{ name: "chromium", need: "optional", state: "missing" }, { name: "claude", need: "optional", state: "missing" }]);
    const result = yield* Effect.result(runCli(["check", "--for", "play"]).pipe(Effect.provide(deps.layer)));
    expect(Result.isSuccess(result)).toBe(ready);
    expect(deps.stdout.join("")).toMatch(/^\{"ready":/);
    expect(JSON.parse(deps.stdout.join(""))).toEqual({ ready, items: [
      { name: "chromium", need: "optional", state: "missing", size: 211_000_000, install: "pnpm cli install chromium" },
      { name: "claude", need, state: "missing", size: 224_000_000, install: "pnpm cli install claude" },
    ] });
    expect(deps.load).not.toHaveBeenCalled();
    expect(deps.install).not.toHaveBeenCalled();
    expect(deps.stderr).toEqual([]);
  }).pipe(Effect.scoped));

  it.live("状態確認が ready でも壊れた SDK の読込失敗は play を exit 3 にする", () => Effect.gen(function* () {
    const root = yield* temporaryDeps;
    const version = manifest.dependencies["@anthropic-ai/claude-agent-sdk"];
    const entity = join(root, "deps/claude/entity");
    const pkg = join(entity, "node_modules/@anthropic-ai/claude-agent-sdk");
    const binaryPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    yield* Effect.tryPromise(async () => {
      await mkdir(pkg, { recursive: true });
      await mkdir(join(entity, "node_modules", binaryPackage), { recursive: true });
      await writeFile(join(entity, "package.json"), JSON.stringify(manifest));
      await writeFile(join(entity, ".ready.json"), JSON.stringify({ version, installedAt: "2026-10-11T00:00:00Z", hashes: {} }));
      await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version, type: "module", main: "index.js" }));
      await writeFile(join(pkg, "index.js"), "throw new Error('合成 SDK の読込失敗');");
      await writeFile(join(entity, "node_modules", binaryPackage, process.platform === "win32" ? "claude.exe" : "claude"), "synthetic binary");
      await symlink("entity", join(root, "deps/claude/current"));
    });
    const report = yield* Effect.gen(function* () { return yield* (yield* ManagedDeps).check(["claude"]); }).pipe(Effect.provide(managedLayer(join(root, "deps"))));
    expect(report).toEqual([{ name: "claude", need: "optional", state: "ready" }]);
    const result = yield* localCli(root, ["play", fixture]);
    expect(result).toEqual({ code: 3, stdout: "", stderr: refusal });
    expect(existsSync(join(root, "sessions"))).toBe(false);
  }).pipe(Effect.scoped));
});
