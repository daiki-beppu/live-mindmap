import { Effect, Fiber, Ref, Scope, Semaphore } from "effect";

const MEETING_TAB_NOTICE_DELAY_MS = 60_000;
const MISSING_MEETING_TAB = "会議のタブが前面にありません。共有画面を取り込めていません（マップは別のウィンドウで開いてください）";
const RESTORED_MEETING_TAB = "会議のタブが前面に戻りました。共有画面の取り込みを再開しました";

export const isScreenBrowser = (app: string): boolean => [
  "com.google.Chrome", "com.microsoft.edgemac", "com.apple.Safari",
  "company.thebrowser.Browser", "com.brave.Browser", "org.mozilla.firefox",
].includes(app);

type NoticeState =
  | { kind: "idle" | "notified" | "closed" }
  | { kind: "waiting"; token: symbol; fiber: Fiber.Fiber<void> };

export const makeMeetingTabNotice = Effect.fnUntraced(function* (options: {
  enabled: boolean;
  notify: (text: string) => Effect.Effect<void>;
}) {
  const scope = yield* Effect.scope;
  const state = yield* Ref.make<NoticeState>({ kind: options.enabled ? "idle" : "closed" });
  const latestStart = yield* Ref.make<number | undefined>(undefined);
  const lock = yield* Semaphore.make(1);

  const transition = (change: Effect.Effect<Fiber.Fiber<void> | undefined>) =>
    lock.withPermit(change).pipe(
      Effect.flatMap((stopped) => stopped === undefined ? Effect.void : Fiber.interrupt(stopped)),
      Effect.uninterruptible,
    );

  const clear = (kind: "idle" | "closed") =>
    transition(Effect.gen(function* () {
      const current = yield* Ref.get(state);
      if (current.kind !== "closed") yield* Ref.set(state, { kind });
      yield* Ref.set(latestStart, undefined);
      return current.kind === "waiting" ? current.fiber : undefined;
    }));

  const screen = ({ start, hasImage, meetingTabTitle }: {
    start: number;
    hasImage: boolean;
    meetingTabTitle: string | undefined;
  }) =>
    transition(Effect.gen(function* () {
      const current = yield* Ref.get(state);
      if (current.kind === "closed") return;
      const previousStart = yield* Ref.get(latestStart);
      if (previousStart !== undefined && start < previousStart) return;
      yield* Ref.set(latestStart, start);
      if (hasImage) {
        yield* Ref.set(state, { kind: "idle" });
        if (current.kind === "notified") yield* options.notify(RESTORED_MEETING_TAB);
        return current.kind === "waiting" ? current.fiber : undefined;
      }
      if (current.kind !== "idle") return;
      const token = Symbol();
      const timer = Effect.gen(function* () {
        yield* Effect.sleep(MEETING_TAB_NOTICE_DELAY_MS);
        yield* lock.withPermit(Effect.gen(function* () {
          const latest = yield* Ref.get(state);
          if (latest.kind !== "waiting" || latest.token !== token) return;
          yield* Ref.set(state, { kind: "notified" });
          yield* options.notify(meetingTabTitle === undefined ? MISSING_MEETING_TAB
            : `会議のタブ（${meetingTabTitle}）が前面にありません。共有画面を取り込めていません（マップは別のウィンドウで開いてください）`);
        }).pipe(Effect.uninterruptible));
      });
      const fiber = yield* Effect.forkIn(Effect.interruptible(timer), scope);
      yield* Ref.set(state, { kind: "waiting", token, fiber });
    }));

  const stop = clear("closed");
  yield* Scope.addFinalizer(scope, stop);
  return { screen, reset: clear("idle"), stop };
});
