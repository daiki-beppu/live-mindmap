import { Deferred, Effect, Layer } from "effect";
import { ReviewBuild } from "../../src/review.ts";
import { Tunnel, TunnelFailed } from "../../src/tunnel.ts";
import { TEMPLATE } from "./review.ts";

// 偽の Tunnel。cloudflared を起動せず、渡されたポートを記録して固定のホスト名を返す。
// 子プロセスの後始末に当たる finalizer が走った回数を closed() で観測する。
export const FAKE_TUNNEL_HOST = "fake-tunnel.trycloudflare.com";

// holdFirstOpen: true のとき、最初の open だけ、ポートを記録して後始末を登録したあと、外から操作されるまでホスト名を返さない。
// reached は待ちに到達したときのポートで完了し、failHeld は待ちを TunnelFailed で終わらせ、succeedHeld は待ちをホスト名の返却で終わらせる。2 回目以降は常に成功する。
// holdFirstCleanup: true のとき、最初の open の後始末は cleanupStarted を完了してから releaseCleanup を待ち、そのあとで closed() を加算する。
// cleanupReached は後始末の開始で完了する。
export const fakeTunnel = (options: { readonly holdFirstOpen?: boolean; readonly holdFirstCleanup?: boolean } = {}) => {
  const opened: number[] = [];
  let closedCount = 0;
  const reached = Deferred.makeUnsafe<number>();
  const held = Deferred.makeUnsafe<void, TunnelFailed>();
  const cleanupStarted = Deferred.makeUnsafe<void>();
  const cleanupGate = Deferred.makeUnsafe<void>();
  let holdNext = options.holdFirstOpen === true;
  let holdCleanup = options.holdFirstCleanup === true;
  const tunnel = Layer.succeed(Tunnel, Tunnel.of({
    open: (port) => Effect.gen(function* () {
      opened.push(port);
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
      return { hostname: FAKE_TUNNEL_HOST, dropped: Effect.never };
    }),
  }));
  const build = Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.succeed(TEMPLATE) }));
  const failHeld = Deferred.fail(held, new TunnelFailed({ message: "偽の Tunnel の起動失敗" }));
  const succeedHeld = Deferred.succeed(held, undefined);
  const cleanupReached = Deferred.await(cleanupStarted);
  const releaseCleanup = Deferred.succeed(cleanupGate, undefined);
  return { viewing: Layer.merge(tunnel, build), opened, closed: () => closedCount, reached: Deferred.await(reached), failHeld, succeedHeld, cleanupReached, releaseCleanup };
};

// 閲覧の共有を使わないテスト用。使われたら die する
export const unusedViewing = Layer.merge(
  Layer.succeed(Tunnel, Tunnel.of({ open: () => Effect.die("このテストでは tunnel を開きません") })),
  Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.die("このテストでは画面をビルドしません") })),
);
