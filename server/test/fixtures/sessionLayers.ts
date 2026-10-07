import { Effect, Layer } from "effect";
import { DiffUpdater, SessionLog, type DiffInput, type DiffOutput, type LogEvent } from "../../src/core/index.ts";

// core の Service（DiffUpdater・SessionLog）の偽物を Layer にする。偽物は Service.of で作り、Layer.succeed で渡す。

// DiffUpdater.update の失敗の型（core は構造型で受ける）
export type UpdateFailure = { readonly _tag: string; readonly message: string };

export const updaterLayer = (update: (input: DiffInput) => Effect.Effect<DiffOutput, UpdateFailure>) =>
  Layer.succeed(DiffUpdater, DiffUpdater.of({ update }));

export const logLayer = (write: (event: LogEvent) => Effect.Effect<void>) =>
  Layer.succeed(SessionLog, SessionLog.of({ write }));

// 書かれたイベントを配列にためる
export const collectLog = (events: LogEvent[]) =>
  logLayer((event) =>
    Effect.sync(() => {
      events.push(event);
    }),
  );

// 何も書かない（ログを見ないテスト・復元）
export const silentLog = logLayer(() => Effect.void);

// 差分更新を呼べない偽物。呼ばれたら defect にする（restore で差分更新を呼べないことの表現）
export const forbiddenUpdater = updaterLayer(() => Effect.die("差分更新は呼べません"));

// 条件が成り立つまで、スケジューラに順番を譲る。上限を超えたら成り立っていないままにして、呼び出し側の expect で落とす。
// TestClock は進めない（時間に依らない順序の待ち）
export const settleUntil = (condition: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200 && !condition(); i++) yield* Effect.yieldNow;
  });
