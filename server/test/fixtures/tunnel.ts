import { Deferred, Effect, Layer } from "effect";
import { ReviewBuild } from "../../src/review.ts";
import { quickTunnelArgs } from "../../src/core/index.ts";
import { CloudflaredMissing, Tunnel, TunnelFailed } from "../../src/tunnel.ts";
import { TEMPLATE } from "./review.ts";

export const FAKE_TUNNEL_HOST = "fake-tunnel.trycloudflare.com";

export const fakeTunnel = (options: { readonly holdFirstOpen?: boolean; readonly holdFirstCleanup?: boolean; readonly missing?: boolean; readonly distinctHosts?: boolean } = {}) => {
  const opened: number[] = [];
  const hosts: string[] = [];
  const droppeds: Deferred.Deferred<void>[] = [];
  const args: (readonly string[])[] = [];
  let checkedCount = 0;
  let closedCount = 0;
  const reached = Deferred.makeUnsafe<number>();
  const held = Deferred.makeUnsafe<void, TunnelFailed>();
  const cleanupStarted = Deferred.makeUnsafe<void>();
  const cleanupGate = Deferred.makeUnsafe<void>();
  let holdNext = options.holdFirstOpen === true;
  let holdCleanup = options.holdFirstCleanup === true;
  const tunnel = Layer.succeed(Tunnel, Tunnel.of({
    check: Effect.suspend(() => {
      checkedCount += 1;
      return options.missing === true
        ? Effect.fail(new CloudflaredMissing({ message: "cloudflared がありません。管理依存はセッション中には入れられないので、cli stop でセッションを終えてから pnpm cli install cloudflared で入れてください（share は次のセッションから使えます）" }))
        : Effect.void;
    }),
    open: (port, allow) => Effect.gen(function* () {
      opened.push(port);
      args.push(quickTunnelArgs(port, allow));
      const hold = holdCleanup;
      holdCleanup = false;
      yield* Effect.addFinalizer(() => hold
        ? Effect.andThen(Deferred.succeed(cleanupStarted, undefined), Effect.andThen(Deferred.await(cleanupGate), Effect.sync(() => { closedCount += 1; })))
        : Effect.sync(() => { closedCount += 1; }));
      if (holdNext) {
        holdNext = false;
        yield* Deferred.succeed(reached, port);
        yield* Deferred.await(held);
      }
      const hostname = options.distinctHosts === true ? `fake-tunnel-${opened.length}.trycloudflare.com` : FAKE_TUNNEL_HOST;
      hosts.push(hostname);
      const dropped = Deferred.makeUnsafe<void>();
      droppeds.push(dropped);
      return { hostname, dropped: Deferred.await(dropped) };
    }),
  }));
  const build = Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.succeed(TEMPLATE) }));
  const failHeld = Deferred.fail(held, new TunnelFailed({ message: "偽の Tunnel の起動失敗" }));
  const succeedHeld = Deferred.succeed(held, undefined);
  const cleanupReached = Deferred.await(cleanupStarted);
  const releaseCleanup = Deferred.succeed(cleanupGate, undefined);
  const drop = Effect.suspend(() => droppeds.length === 0 ? Effect.void : Deferred.succeed(droppeds[droppeds.length - 1]!, undefined).pipe(Effect.asVoid));
  return { viewing: Layer.merge(tunnel, build), opened, hosts, drop, args, closed: () => closedCount, checked: () => checkedCount, reached: Deferred.await(reached), failHeld, succeedHeld, cleanupReached, releaseCleanup };
};

export const unusedViewing = Layer.merge(
  Layer.succeed(Tunnel, Tunnel.of({ check: Effect.die("このテストでは tunnel を確かめません"), open: () => Effect.die("このテストでは tunnel を開きません") })),
  Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.die("このテストでは画面をビルドしません") })),
);
