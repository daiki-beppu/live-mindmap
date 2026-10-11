// Tunnel.check（Issue #835）。本物の Tunnel.layer を、管理ディレクトリ（一時ディレクトリ）の上で確かめる。
// cloudflared は起動しない（ChildProcessSpawner は使われたら die する）。
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ManagedDeps } from "../src/managedDeps.ts";
import { CloudflaredMissing, Tunnel } from "../src/tunnel.ts";
import { allowedMails } from "./fixtures/allowedMail.ts";
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


// Tunnel.open（Issue #836）。本物の Tunnel.layer が cloudflared へ渡す引数を、偽の spawner で観測する。cloudflared は起動しない。
describe("Tunnel.open の引数（許可の範囲）", () => {
  const argsFor = (allow: Parameters<(typeof Tunnel)["Service"]["open"]>[1]) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const fixture = yield* archive(dir);
    const options = { root, npm: yield* fakeNpm(dir), cloudflared: {
      resolve: Effect.succeed(fixture.artifact),
      download: (_url: string, destination: string) => Effect.tryPromise(() => copyFile(fixture.path, destination)),
    } };
    const deps = ManagedDeps.layer(options).pipe(Layer.provide(NodeServices.layer));
    yield* Effect.gen(function* () {
      const managed = yield* ManagedDeps;
      yield* Stream.runCollect(managed.install(["cloudflared"]));
    }).pipe(Effect.provide(deps));
    const commands: ChildProcess.StandardCommand[] = [];
    const spawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make((command) => {
      if (ChildProcess.isStandardCommand(command)) commands.push(command);
      return Effect.die("引数を観測したら起動しない");
    }));
    yield* Effect.gen(function* () {
      const tunnel = yield* Tunnel;
      yield* Effect.exit(tunnel.open(4321, allow));
    }).pipe(Effect.scoped, Effect.provide(Tunnel.layer.pipe(Layer.provide(Layer.merge(deps, spawner)))));
    expect(commands).toHaveLength(1);
    return commands[0]!.args;
  }).pipe(Effect.scoped);

  it.live("メール・ドメインがあれば --allowed-mail で全部を渡す", () => Effect.gen(function* () {
    const args = yield* argsFor({ mails: ["a@x.com", "*@example.co.jp"] });
    expect(args).toContain("http://127.0.0.1:4321");
    expect(allowedMails(args)).toEqual(["*@example.co.jp", "a@x.com"]);
  }));

  it.live("誰でもなら --allowed-mail を付けない", () => Effect.gen(function* () {
    const args = yield* argsFor("anyone");
    expect(args).toContain("http://127.0.0.1:4321");
    expect(args).not.toContain("--allowed-mail");
  }));
});
