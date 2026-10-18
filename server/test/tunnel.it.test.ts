// Tunnel.check（Issue #835）。本物の Tunnel.layer を、管理ディレクトリ（一時ディレクトリ）の上で確かめる。
// cloudflared は起動しない（ChildProcessSpawner は使われたら die する）。
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { ManagedDeps } from "../src/managedDeps.ts";
import { CloudflaredMissing, Tunnel } from "../src/tunnel.ts";
import { archive } from "./fixtures/cloudflared.ts";
import { fakeNpm, temporaryDeps } from "./fixtures/managedDeps.ts";

const INSTALL_HOW = "pnpm cli install cloudflared";

describe("Tunnel.check（cloudflared の有無）", () => {
  const layerOn = (options: Parameters<typeof ManagedDeps.layer>[0], spawned: string[]) => {
    const spawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(() =>
      Effect.sync(() => { spawned.push("spawn"); }).pipe(Effect.andThen(Effect.die("check は cloudflared を起動しない")))));
    const deps = ManagedDeps.layer(options).pipe(Layer.provide(NodeServices.layer));
    return Tunnel.layer.pipe(Layer.provide(Layer.merge(deps, spawner)));
  };

  it.live("未導入なら CloudflaredMissing で失敗し、入れ方を示し、子プロセスを起動しない", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const spawned: string[] = [];
    const layer = layerOn({ root: join(dir, "deps"), npm: yield* fakeNpm(dir) }, spawned);
    const result = yield* Effect.gen(function* () {
      const tunnel = yield* Tunnel;
      return yield* Effect.result(tunnel.check);
    }).pipe(Effect.provide(layer));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(CloudflaredMissing);
      expect(result.failure.message).toContain(INSTALL_HOW);
      // 導入はセッション中には断られるので、先にセッションを終えることを示す
      expect(result.failure.message).toContain("cli stop でセッションを終えてから");
    }
    expect(spawned).toEqual([]);
  }).pipe(Effect.scoped));

  it.live("導入した後なら成功し、子プロセスを起動しない", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const fixture = yield* archive(dir);
    const options = { root, npm: yield* fakeNpm(dir), cloudflared: {
      resolve: Effect.succeed(fixture.artifact),
      download: (_url: string, destination: string) => Effect.tryPromise(() => copyFile(fixture.path, destination)),
    } };
    const spawned: string[] = [];
    yield* Effect.gen(function* () {
      const deps = yield* ManagedDeps;
      yield* Stream.runCollect(deps.install(["cloudflared"]));
    }).pipe(Effect.provide(ManagedDeps.layer(options).pipe(Layer.provide(NodeServices.layer))));
    const result = yield* Effect.gen(function* () {
      const tunnel = yield* Tunnel;
      return yield* Effect.result(tunnel.check);
    }).pipe(Effect.provide(layerOn(options, spawned)));
    expect(Result.isSuccess(result)).toBe(true);
    expect(spawned).toEqual([]);
  }).pipe(Effect.scoped));
});
