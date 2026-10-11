// Tunnel サービス（Issue #834）。cloudflared（管理依存）の quick tunnel を子プロセスとして起動し、公開のホスト名を返す。
// 子プロセスの寿命は open を呼んだ Scope に結ぶ（Scope を閉じると kill）。
// cloudflared の出力は URL を含むので、server の標準エラー・ログ・配信へ中継しない。ホスト名を取り出すためだけに読み、
// パイプが詰まらないよう最後まで読み続ける。
import { Context, Deferred, Effect, Layer, Schema, Stream, type Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { quickTunnelArgs, quickTunnelHostname, type ShareAllow } from "./core/index.ts";
import { ManagedDeps } from "./managedDeps.ts";

// SIGTERM を送ってから SIGKILL に切り替えるまでの待ち時間
const TUNNEL_STOP_TIMEOUT_MS = 5_000;

export class TunnelFailed extends Schema.TaggedError<TunnelFailed>()("TunnelFailed", { message: Schema.String }) {}

// cloudflared が管理ディレクトリに無い。message は入れ方を含む
export class CloudflaredMissing extends Schema.TaggedError<CloudflaredMissing>()("CloudflaredMissing", { message: Schema.String }) {}

export type OpenedTunnel = {
  // https:// を含まない公開のホスト名
  hostname: string;
  // tunnel が切れたときに完了する（切れたことを知らせる口。ViewingShare が待って、状態を切れたにする）
  dropped: Effect.Effect<void>;
};

export class Tunnel extends Context.Service<Tunnel, {
  // cloudflared が使える状態かを確かめる。起動はしない。無ければ CloudflaredMissing
  check: Effect.Effect<void, CloudflaredMissing | TunnelFailed>;
  // port の 127.0.0.1 を公開する tunnel を開く（allow がメール・ドメインなら --allowed-mail で絞る）。ホスト名が出るまで待つ。子プロセスは呼び出し側の Scope で止まる
  open: (port: number, allow: ShareAllow) => Effect.Effect<OpenedTunnel, TunnelFailed, Scope.Scope>;
}>()("live-mindmap/server/Tunnel") {
  static readonly layer: Layer.Layer<Tunnel, never, ManagedDeps | ChildProcessSpawner.ChildProcessSpawner> = Layer.effect(Tunnel)(
    Effect.gen(function* () {
      const deps = yield* ManagedDeps;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const open = Effect.fnUntraced(function* (port: number, allow: ShareAllow): Effect.fn.Return<OpenedTunnel, TunnelFailed, Scope.Scope> {
        const scope = yield* Effect.scope;
        const binary = yield* deps.executable("cloudflared").pipe(Effect.mapError((error) => new TunnelFailed({ message: error.message })));
        const handle = yield* spawner
          .spawn(ChildProcess.make(binary, quickTunnelArgs(port, allow), { stdin: "ignore", forceKillAfter: TUNNEL_STOP_TIMEOUT_MS }))
          .pipe(Effect.mapError((error) => new TunnelFailed({ message: `cloudflared を起動できません: ${error.message}` })));
        // stdout と stderr のどちらにホスト名が出てもよい。1 本の Fiber が最後まで読み続け（パイプが詰まらない）、
        // 最初のホスト名だけを取り出す。読んだ行はそれ以外どこにも出さない
        const found = yield* Deferred.make<string, TunnelFailed>();
        const ended = yield* Deferred.make<void>();
        const reading = Stream.merge(handle.stdout, handle.stderr).pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runForEach((line) => {
            const hostname = quickTunnelHostname(line);
            return hostname === undefined ? Effect.void : Deferred.succeed(found, hostname);
          }),
        );
        yield* Effect.forkIn(
          reading.pipe(
            Effect.ignore,
            Effect.andThen(handle.exitCode),
            Effect.ignore,
            Effect.andThen(Deferred.fail(found, new TunnelFailed({ message: "cloudflared がホスト名を出す前に終了しました" }))),
            Effect.andThen(Deferred.succeed(ended, undefined)),
          ),
          scope,
        );
        const hostname = yield* Deferred.await(found);
        return { hostname, dropped: Deferred.await(ended) };
      });
      const check = deps.check(["cloudflared"]).pipe(
        Effect.mapError((error) => new TunnelFailed({ message: error.message })),
        Effect.flatMap(([item]) => item?.state === "ready"
          ? Effect.void
          : Effect.fail(new CloudflaredMissing({ message: "cloudflared がありません。pnpm cli install cloudflared で入れてから、もう一度 share を打ってください" }))),
      );
      return Tunnel.of({ check, open });
    }),
  );
}
