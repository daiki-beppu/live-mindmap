import { Context, Deferred, Effect, Exit, Layer, Ref, Schema, Scope, Semaphore } from "effect";
import type { ShareAllow, ShareOpenOutcome, ShareStatus } from "./core/index.ts";
import { ReviewBuild } from "./review.ts";
import type { SessionFailure } from "./sessionFailure.ts";
import { Sessions } from "./sessions.ts";
import { CloudflaredMissing, Tunnel } from "./tunnel.ts";
import { Viewers } from "./viewers.ts";

export class ShareOpenFailed extends Schema.TaggedError<ShareOpenFailed>()("ShareOpenFailed", { message: Schema.String }) {}

export class ShareRefusedLocalMode extends Schema.TaggedError<ShareRefusedLocalMode>()("ShareRefusedLocalMode", {
  message: Schema.String,
}) {}

export class ShareScopeEmpty extends Schema.TaggedError<ShareScopeEmpty>()("ShareScopeEmpty", { message: Schema.String }) {}

export type ViewingPort = { readonly port: number; readonly allow: (hostname: string) => Effect.Effect<void> };

export type OpenViewingPort = Effect.Effect<ViewingPort, { readonly message: string }, Viewers | ReviewBuild | Scope.Scope>;

type Current =
  | { readonly phase: "opening"; readonly id: object; readonly scope: Scope.Closeable }
  | { readonly phase: "open"; readonly id: object; readonly scope: Scope.Closeable; readonly status: Extract<ShareStatus, { status: "open" }> }
  | { readonly phase: "broken"; readonly id: object; readonly scope: Scope.Closeable; readonly status: Extract<ShareStatus, { status: "broken" }> };

export class ViewingShare extends Context.Service<ViewingShare, {
  open: (allow: ShareAllow | undefined) => Effect.Effect<{ readonly outcome: ShareOpenOutcome; readonly status: Extract<ShareStatus, { status: "open" }> }, ShareOpenFailed | ShareRefusedLocalMode | ShareScopeEmpty | CloudflaredMissing | SessionFailure>;
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
      const lock = yield* Semaphore.make(1);

      const open = (allow: ShareAllow | undefined) => lock.withPermit(Effect.gen(function* () {
        const existing = yield* Ref.get(current);
        if (existing?.phase === "open") return { outcome: "already-open", status: existing.status } as const;
        const { scope: sessionScope, local } = yield* sessions.liveSession;
        if (local) {
          return yield* new ShareRefusedLocalMode({ message: "ローカルモードのセッションでは閲覧の共有を開けません。会議の中身を Mac の外に出さないためです" });
        }
        yield* tunnel.check.pipe(Effect.catchTag("TunnelFailed", (error) => Effect.fail(new ShareOpenFailed({ message: error.message }))));
        if (allow === undefined) {
          return yield* new ShareScopeEmpty({ message: "閲覧の共有の許可の範囲を指定してください（メール・ドメインを引数で渡すか、LIVE_MINDMAP_SHARE_ALLOW に書くか、誰でも見られてよいなら --anyone）。閉じるときは --stop" });
        }
        if (existing?.phase === "broken") yield* Scope.close(existing.scope, Exit.void);
        const id = {};
        // 状態の登録を後始末の登録より先に置く（閉じた Scope では後始末がその場で走り、登録した状態を消す）
        const { scope, connection, ended } = yield* Effect.uninterruptible(Effect.gen(function* () {
          const scope = yield* Scope.fork(sessionScope, "sequential");
          yield* Ref.set(current, { phase: "opening", id, scope });
          const ended = yield* Deferred.make<void>();
          yield* Scope.addFinalizer(scope, Effect.andThen(
            Ref.update(current, (now) => now?.id === id ? undefined : now),
            Deferred.succeed(ended, undefined),
          ));
          const connection = yield* Scope.fork(scope, "sequential");
          return { scope, connection, ended };
        }));
        const failed = (message: string) => new ShareOpenFailed({ message });
        const body = Effect.gen(function* () {
          const view = yield* openViewingPort.pipe(Scope.provide(connection), Effect.provideService(Viewers, viewers), Effect.provideService(ReviewBuild, build));
          const opened = yield* tunnel.open(view.port, allow).pipe(Scope.provide(connection));
          yield* view.allow(opened.hostname);
          const status = { status: "open", url: `https://${opened.hostname}`, allow } as const;
          // 開始の途中で閉じられていたら、open を公開しない。閉じ始めると Scope は先に Closed になり、
          // 状態の消去は後始末の最後に走るため、状態が残っていても Closed なら公開しない
          const published = yield* Ref.modify(current, (now): readonly [boolean, Current | undefined] =>
            now?.phase === "opening" && now.id === id && scope.state._tag !== "Closed" ? [true, { phase: "open", id, scope, status }] : [false, now]);
          if (!published) return yield* failed("閲覧の共有は開始の途中で閉じられました");
          yield* Effect.forkIn(Effect.andThen(opened.dropped, lock.withPermit(Effect.uninterruptible(Effect.gen(function* () {
            const swapped = yield* Ref.modify(current, (now): readonly [boolean, Current | undefined] =>
              now?.phase === "open" && now.id === id ? [true, { phase: "broken", id, scope, status: { status: "broken", allow } }] : [false, now]);
            if (swapped) yield* Scope.close(connection, Exit.void);
          })))), scope);
          return { outcome: "opened", status } as const;
        }).pipe(Effect.mapError((error) => failed(error.message)));
        const closedDuringOpen = Effect.andThen(Deferred.await(ended), Effect.fail(failed("閲覧の共有は開始の途中で閉じられました")));
        return yield* Effect.raceFirst(body, closedDuringOpen).pipe(
          Effect.onExit((exit) => Exit.isFailure(exit) ? Scope.close(scope, Exit.void) : Effect.void),
        );
      }));

      const close = lock.withPermit(Effect.gen(function* () {
        const existing = yield* Ref.get(current);
        if (existing !== undefined) yield* Scope.close(existing.scope, Exit.void);
      }));

      const status = Effect.map(Ref.get(current), (now): ShareStatus => now?.phase === "open" || now?.phase === "broken" ? now.status : { status: "off" });

      return ViewingShare.of({ open, close, status });
    }));
}
