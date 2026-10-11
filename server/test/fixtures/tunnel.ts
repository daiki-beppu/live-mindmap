import { Deferred, Effect, Layer } from "effect";
import { ReviewBuild } from "../../src/review.ts";
import { quickTunnelArgs } from "../../src/core/index.ts";
import { CloudflaredMissing, Tunnel, TunnelFailed } from "../../src/tunnel.ts";
import { TEMPLATE } from "./review.ts";

// 偽の Tunnel。cloudflared を起動せず、渡されたポートを記録して固定のホスト名を返す。
// 子プロセスの後始末に当たる finalizer が走った回数を closed() で観測する。
export const FAKE_TUNNEL_HOST = "fake-tunnel.trycloudflare.com";

// holdFirstOpen: true のとき、最初の open だけ、ポートを記録して後始末を登録したあと、外から操作されるまでホスト名を返さない。
// reached は待ちに到達したときのポートで完了し、failHeld は待ちを TunnelFailed で終わらせ、succeedHeld は待ちをホスト名の返却で終わらせる。2 回目以降は常に成功する。
// holdFirstCleanup: true のとき、最初の open の後始末は cleanupStarted を完了してから releaseCleanup を待ち、そのあとで closed() を加算する。
// cleanupReached は後始末の開始で完了する。
// distinctHosts: true のとき、n 回目（1 始まり）の open は fake-tunnel-n.trycloudflare.com を返す（開き直しで URL が変わることを観測する）。返したホスト名は hosts に入る。既定は常に FAKE_TUNNEL_HOST。
// drop() は、最後に開いた tunnel の dropped を完了させる（cloudflared が切れたことの再現）。open が一度も無ければ何もしない。
// missing: true のとき、check は CloudflaredMissing で失敗する（cloudflared が管理ディレクトリに無い状態）。checked() は check が呼ばれた回数。
export const fakeTunnel = (options: { readonly holdFirstOpen?: boolean; readonly holdFirstCleanup?: boolean; readonly missing?: boolean; readonly distinctHosts?: boolean } = {}) => {
  const opened: number[] = [];
  const hosts: string[] = [];
  const droppeds: Deferred.Deferred<void>[] = [];
  // open ごとに、cloudflared へ渡す引数（--allowed-mail を含む）。本物の Tunnel と同じ quickTunnelArgs で作る
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
        ? Effect.fail(new CloudflaredMissing({ message: "cloudflared がありません。pnpm cli install cloudflared で入れてから、もう一度 share を打ってください" }))
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

// 閲覧の共有を使わないテスト用。使われたら die する
export const unusedViewing = Layer.merge(
  Layer.succeed(Tunnel, Tunnel.of({ check: Effect.die("このテストでは tunnel を確かめません"), open: () => Effect.die("このテストでは tunnel を開きません") })),
  Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.die("このテストでは画面をビルドしません") })),
);
