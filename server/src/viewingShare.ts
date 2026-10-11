// 閲覧の共有（Issue #834）。閲覧の口を開き、Tunnel でその口を公開し、状態を持つ。
// 共有の Scope は、いま live なセッションの Scope の子にする。閉じる経路（close・セッションの終了・server の終了）は
// どれも、この Scope の後始末（Tunnel の子プロセスを止める・閲覧の口の待受けを閉じる・状態を無しに戻す）に合流する。
// http.ts を import しない（循環を避ける）。閲覧の口を開く関数は Layer の引数で受ける。
import { Context, Deferred, Effect, Exit, Layer, Ref, Schema, Scope, Semaphore } from "effect";
import type { ShareAllow, ShareOpenOutcome, ShareStatus } from "./core/index.ts";
import { ReviewBuild } from "./review.ts";
import type { SessionFailure } from "./sessionFailure.ts";
import { Sessions } from "./sessions.ts";
import { CloudflaredMissing, Tunnel } from "./tunnel.ts";
import { Viewers } from "./viewers.ts";

// 閲覧の共有を開けなかった（画面のビルド・待受け・Tunnel のどれかの失敗）。message は原因の文面
export class ShareOpenFailed extends Schema.TaggedError<ShareOpenFailed>()("ShareOpenFailed", { message: Schema.String }) {}

// ローカルモードのセッションでは、閲覧の共有を開かない（会議の中身を Mac の外に出さない）
export class ShareRefusedLocalMode extends Schema.TaggedError<ShareRefusedLocalMode>()("ShareRefusedLocalMode", {
  message: Schema.String,
}) {}

// 許可の範囲が空（メール・ドメインも --anyone も無い）。共有中・セッション無し・ローカル・cloudflared 無しの判定のあとで拒否する
export class ShareScopeEmpty extends Schema.TaggedError<ShareScopeEmpty>()("ShareScopeEmpty", { message: Schema.String }) {}

// 閲覧の口を開いた結果。port は待ち受けているポート。allow は許す Origin のホスト名を 1 つ決める（tunnel のホスト名が出てから呼ぶ）
export type ViewingPort = { readonly port: number; readonly allow: (hostname: string) => Effect.Effect<void> };

export type OpenViewingPort = Effect.Effect<ViewingPort, { readonly message: string }, Viewers | ReviewBuild | Scope.Scope>;

// 開始の途中（opening）は共有の Scope だけを持つ。status を返すのは open になってから
type Current =
  | { readonly phase: "opening"; readonly id: object; readonly scope: Scope.Closeable }
  | { readonly phase: "open"; readonly id: object; readonly scope: Scope.Closeable; readonly status: Extract<ShareStatus, { status: "open" }> };

export class ViewingShare extends Context.Service<ViewingShare, {
  // 閲覧の共有を開く。すでに開いていれば今の状態を返し、新しくは開かない。
  // 新しく開いたか既存を返したかは、ロックの中で決めた outcome で伝える
  open: (allow: ShareAllow | undefined) => Effect.Effect<{ readonly outcome: ShareOpenOutcome; readonly status: Extract<ShareStatus, { status: "open" }> }, ShareOpenFailed | ShareRefusedLocalMode | ShareScopeEmpty | CloudflaredMissing | SessionFailure>;
  // 閉じる。開いていなくても成功する
  close: Effect.Effect<void>;
  status: Effect.Effect<ShareStatus>;
}>()("live-mindmap/server/ViewingShare") {
  static readonly layer = (openViewingPort: OpenViewingPort): Layer.Layer<ViewingShare, never, Sessions | Tunnel | Viewers | ReviewBuild> =>
    Layer.effect(ViewingShare)(Effect.gen(function* () {
      const sessions = yield* Sessions;
      const tunnel = yield* Tunnel;
      const viewers = yield* Viewers;
      const build = yield* ReviewBuild;
      const current = yield* Ref.make<Current | undefined>(undefined);
      // 開く・閉じるは 1 つずつ。二重に開かず、開く途中で閉じる操作と交わらない
      const lock = yield* Semaphore.make(1);

      const open = (allow: ShareAllow | undefined) => lock.withPermit(Effect.gen(function* () {
        const existing = yield* Ref.get(current);
        if (existing?.phase === "open") return { outcome: "already-open", status: existing.status } as const;
        const { scope: sessionScope, local } = yield* sessions.liveSession;
        if (local) {
          return yield* new ShareRefusedLocalMode({ message: "ローカルモードのセッションでは閲覧の共有を開けません。会議の中身を Mac の外に出さないためです" });
        }
        // 閲覧の口やビルドを作る前に、cloudflared が使えるかを確かめる
        yield* tunnel.check.pipe(Effect.catchTag("TunnelFailed", (error) => Effect.fail(new ShareOpenFailed({ message: error.message }))));
        if (allow === undefined) {
          return yield* new ShareScopeEmpty({ message: "閲覧の共有の許可の範囲を指定してください（メール・ドメインを引数で渡すか、LIVE_MINDMAP_SHARE_ALLOW に書くか、誰でも見られてよいなら --anyone）。閉じるときは --stop" });
        }
        const id = {};
        // 共有の Scope の用意。fork・状態の登録・後始末の登録は途中で割り込まれない。
        // 状態の登録を後始末の登録より先に置く（閉じた Scope では後始末がその場で走り、登録した状態を消す）
        const { scope, ended } = yield* Effect.uninterruptible(Effect.gen(function* () {
          const scope = yield* Scope.fork(sessionScope, "sequential");
          yield* Ref.set(current, { phase: "opening", id, scope });
          const ended = yield* Deferred.make<void>();
          // 共有の Scope が閉じたら（どの経路でも）、同じ共有のときだけ状態を無しに戻し、開始途中の処理に知らせる
          yield* Scope.addFinalizer(scope, Effect.andThen(
            Ref.update(current, (now) => now?.id === id ? undefined : now),
            Deferred.succeed(ended, undefined),
          ));
          return { scope, ended };
        }));
        const failed = (message: string) => new ShareOpenFailed({ message });
        const body = Effect.gen(function* () {
          const view = yield* openViewingPort.pipe(Scope.provide(scope), Effect.provideService(Viewers, viewers), Effect.provideService(ReviewBuild, build));
          const opened = yield* tunnel.open(view.port, allow).pipe(Scope.provide(scope));
          yield* view.allow(opened.hostname);
          const status = { status: "open", url: `https://${opened.hostname}`, allow } as const;
          // 開始の途中で閉じられていたら、open を公開しない。閉じ始めると Scope は先に Closed になり、
          // 状態の消去は後始末の最後に走るため、状態が残っていても Closed なら公開しない
          const published = yield* Ref.modify(current, (now): readonly [boolean, Current | undefined] =>
            now?.phase === "opening" && now.id === id && scope.state._tag !== "Closed" ? [true, { phase: "open", id, scope, status }] : [false, now]);
          if (!published) return yield* failed("閲覧の共有は開始の途中で閉じられました");
          return { outcome: "opened", status } as const;
        }).pipe(Effect.mapError((error) => failed(error.message)));
        // 開始の途中で共有の Scope が閉じたら、待ちを打ち切って失敗にする
        const closedDuringOpen = Effect.andThen(Deferred.await(ended), Effect.fail(failed("閲覧の共有は開始の途中で閉じられました")));
        return yield* Effect.raceFirst(body, closedDuringOpen).pipe(
          Effect.onExit((exit) => Exit.isFailure(exit) ? Scope.close(scope, Exit.void) : Effect.void),
        );
      }));

      const close = lock.withPermit(Effect.gen(function* () {
        const existing = yield* Ref.get(current);
        if (existing !== undefined) yield* Scope.close(existing.scope, Exit.void);
      }));

      const status = Effect.map(Ref.get(current), (now): ShareStatus => now?.phase === "open" ? now.status : { status: "off" });

      return ViewingShare.of({ open, close, status });
    }));
}
