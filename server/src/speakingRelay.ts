// いま話している文字（CaptionsFrame）をブラウザへ送る。途中結果は頻繁に届くので、フレーム全体で間引く。
// 予約は Effect の Clock と Effect.sleep のファイバーで張る（中核は実行環境のタイマーを使わない。ADR 0003）。
import { Clock, Effect, Fiber, Ref } from "effect";
import { createCaptionBoard, type CaptionBoardInput, type CaptionsFrame, type HelperPartial, type SpeakerLogEvent, type Track } from "./core/index.ts";
import { createStopGate } from "./stopGate.ts";

export const SPEAKING_INTERVAL_MS = 300; // 両トラックをまとめた 1 本のフレームを、この時間に 1 回まで送る

// 送る時点の、途中結果を除いた盤への入力（マップに反映前の発言・保留中の発言・話者の区間・ラベルの覗き）
export type CaptionContext = Omit<CaptionBoardInput, "partials">;

export type SpeakingRelayOptions = {
  context: Effect.Effect<CaptionContext>;
  send: (frame: CaptionsFrame) => Effect.Effect<void>;
};

type State = { partials: Record<Track, HelperPartial | undefined>; lastSent: number | undefined; lastFrame: string; timer: Fiber.Fiber<void> | undefined };

// 予約のファイバーは、作ったときの Scope に結び付く（Scope が閉じたら止まる）
export const createSpeakingRelay = Effect.fnUntraced(function* ({ context, send }: SpeakingRelayOptions) {
  const scope = yield* Effect.scope;
  const board = createCaptionBoard();
  const state = yield* Ref.make<State>({ partials: { 相手: undefined, 自分: undefined }, lastSent: undefined, lastFrame: "", timer: undefined });
  const gate = yield* createStopGate;
  const { unlessStopped } = gate;

  // 予約を取り消す（予約が無ければ何もしない）。timer を読む処理と外す処理を 1 回の Ref 操作にする
  const cancel = Effect.fnUntraced(function* () {
    const fiber = yield* Ref.modify(state, (current): [Fiber.Fiber<void> | undefined, State] => [current.timer, { ...current, timer: undefined }]);
    if (fiber === undefined) return;
    yield* Fiber.interrupt(fiber);
  });

  const emit = Effect.fnUntraced(function* (frame: CaptionsFrame) {
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.update(state, (s) => ({ ...s, lastSent: now, lastFrame: JSON.stringify(frame) }));
    yield* send(frame);
  });

  // 送る時点の最新の状態から、盤への入力を作る（予約した時点の値は使わない）
  const inputNow = Effect.fnUntraced(function* () {
    const { partials } = yield* Ref.get(state);
    return { ...(yield* context), partials: Object.values(partials).filter((p) => p !== undefined) } satisfies CaptionBoardInput;
  });
  const flush = Effect.fnUntraced(function* () {
    yield* cancel();
    yield* emit({ type: "captions", bubbles: board.build(yield* inputNow()) });
  });

  // 予約の本体。予約が起きた時点で、自分を予約から外してから送る（自分自身を取り消さない）
  const reserve = Effect.fnUntraced(function* (wait: number) {
    const fiber = yield* Effect.forkIn(
      Effect.gen(function* () {
        yield* Effect.sleep(wait);
        yield* Ref.update(state, (s) => ({ ...s, timer: undefined }));
        yield* flush();
      }),
      scope,
    );
    yield* Ref.update(state, (s) => ({ ...s, timer: fiber }));
  });

  // 間隔内なら予約し、間隔が過ぎていればすぐ送る。予約中ならそのまま待つ（予約が送るとき、最新の値を使う）
  const throttled = Effect.fnUntraced(function* () {
    const { timer, lastSent } = yield* Ref.get(state);
    if (timer !== undefined) return;
    const now = yield* Clock.currentTimeMillis;
    const wait = lastSent === undefined ? 0 : lastSent + SPEAKING_INTERVAL_MS - now;
    if (wait <= 0) yield* flush();
    else yield* reserve(wait);
  });

  const emptyFrame = Effect.fnUntraced(function* () {
    yield* cancel();
    yield* Ref.update(state, (s) => ({ ...s, partials: { 相手: undefined, 自分: undefined } }));
    board.reset();
    yield* emit({ type: "captions", bubbles: [] });
  });

  return {
    // 途中結果。重複の印つきなら、そのトラックの途中結果は空として扱う（盤が重複の印つきを出さない）
    partial: (p: HelperPartial) =>
      unlessStopped(
        Effect.andThen(
          Ref.update(state, (s) => ({ ...s, partials: { ...s.partials, [p.track]: p } })),
          throttled(),
        ),
      ),
    // 確定した発言が届いた。そのトラックの途中結果は終わったので空にして、すぐ送る
    remark: (track: Track) =>
      unlessStopped(
        Effect.andThen(
          Ref.update(state, (s) => ({ ...s, partials: { ...s.partials, [track]: undefined } })),
          flush(),
        ),
      ),
    // 話者の区間が確定した（speaker-settled）か、枠が混入で戻った（speaker-mixed）か、枠の重心が届いた（speaker-centroid。起動し直した後の枠がラベルにつながる。Issue #1025）。仮のラベルが変わりうるので、字幕が変わるときだけ間引いて送る
    speaker: (event: SpeakerLogEvent) =>
      unlessStopped(
        Effect.gen(function* () {
          if (event.type === "speaker-settled" || event.type === "speaker-mixed" || event.type === "speaker-centroid") {
            const { lastFrame } = yield* Ref.get(state);
            // 比較は盤の状態を進めない（送らないときに、送っていない境目を確定しないため）
            const frame = { type: "captions", bubbles: board.preview(yield* inputNow()) } satisfies CaptionsFrame;
            if (JSON.stringify(frame) !== lastFrame) yield* throttled();
          }
        }),
      ),
    // 反映が終わったなど、未反映の発言が変わったとき、すぐ送る
    flushAll: unlessStopped(flush()),
    // 予約を取り消し、空の並びを送る。stop との違いは、以後も送れる状態を保つこと
    // （取り込みの途切れの瞬間に使う。永久停止すると、起動し直し後の字幕が届かなくなる。CT-SPEAKING-CLEAR）
    clear: unlessStopped(emptyFrame()),
    // 予約を取り消し、空の並びを送る。以後は何も送らない
    stop: unlessStopped(Effect.andThen(gate.stop, emptyFrame())),
    // 予約のファイバーがあるか
    scheduled: Effect.map(Ref.get(state), (s) => s.timer !== undefined),
  };
});
