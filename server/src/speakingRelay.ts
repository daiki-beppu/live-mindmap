// いま話している文字（SpeakingFrame）をブラウザへ送る。途中結果は頻繁に届くので、トラックごとに間引く。
// 予約は Effect の Clock と Effect.sleep のファイバーで張る（中核は実行環境のタイマーを使わない。ADR 0003）。
import { Clock, Effect, Fiber, Ref } from "effect";
import { speakingText, type Remark, type SpeakingFrame, type Track } from "./core/index.ts";

export const SPEAKING_INTERVAL_MS = 300; // トラックごとに、この時間に 1 回まで送る
const TRACKS: Track[] = ["相手", "自分"];

export type SpeakingRelayOptions = {
  unreflected: Effect.Effect<Remark[]>; // 送る時点の、マップに反映前の発言
  send: (frame: SpeakingFrame) => Effect.Effect<void>;
};

type TrackState = { partial: string; lastSent: number | undefined; timer: Fiber.Fiber<void> | undefined };

// 予約のファイバーは、作ったときの Scope に結び付く（Scope が閉じたら止まる）
export const createSpeakingRelay = Effect.fnUntraced(function* ({ unreflected, send }: SpeakingRelayOptions) {
  const scope = yield* Effect.scope;
  const state = yield* Ref.make<Record<Track, TrackState>>({
    相手: { partial: "", lastSent: undefined, timer: undefined },
    自分: { partial: "", lastSent: undefined, timer: undefined },
  });
  const stopped = yield* Ref.make(false);

  const update = (track: Track, f: (s: TrackState) => TrackState) =>
    Ref.update(state, (current) => ({ ...current, [track]: f(current[track]) }));

  // 予約を取り消す（予約が無ければ何もしない）
  const cancel = Effect.fnUntraced(function* (track: Track) {
    // timer を読む処理と外す処理を 1 回の Ref 操作にする
    const fiber = yield* Ref.modify(state, (current): [Fiber.Fiber<void> | undefined, Record<Track, TrackState>] => [
      current[track].timer,
      { ...current, [track]: { ...current[track], timer: undefined } },
    ]);
    if (fiber === undefined) return;
    yield* Fiber.interrupt(fiber);
  });

  // 送る時点の最新の状態から文字を作って送る（予約した時点の値は使わない）
  const flush = Effect.fnUntraced(function* (track: Track) {
    yield* cancel(track);
    const now = yield* Clock.currentTimeMillis;
    yield* update(track, (s) => ({ ...s, lastSent: now }));
    const { partial } = (yield* Ref.get(state))[track];
    yield* send({ type: "speaking", track, text: speakingText(yield* unreflected, track, partial) });
  });

  // 予約の本体。予約が起きた時点で、自分を予約から外してから送る（自分自身を取り消さない）
  const reserve = Effect.fnUntraced(function* (track: Track, wait: number) {
    const fiber = yield* Effect.forkIn(
      Effect.gen(function* () {
        yield* Effect.sleep(wait);
        yield* update(track, (s) => ({ ...s, timer: undefined }));
        yield* flush(track);
      }),
      scope,
    );
    yield* update(track, (s) => ({ ...s, timer: fiber }));
  });

  const emptyFrames = Effect.fnUntraced(function* () {
    for (const track of TRACKS) {
      yield* cancel(track);
      yield* update(track, (s) => ({ ...s, partial: "" }));
      yield* send({ type: "speaking", track, text: "" });
    }
  });

  const unlessStopped = (effect: Effect.Effect<void>) =>
    Effect.flatMap(Ref.get(stopped), (isStopped) => (isStopped ? Effect.void : effect));

  return {
    // 途中結果。重複の印つきなら、そのトラックの途中結果は空として扱う。
    // 予約中ならそのまま待つ（予約が送るとき、最新の値を使う）。
    partial: (track: Track, text: string, duplicate: boolean) =>
      unlessStopped(
        Effect.gen(function* () {
          yield* update(track, (s) => ({ ...s, partial: duplicate ? "" : text }));
          const { timer, lastSent } = (yield* Ref.get(state))[track];
          if (timer !== undefined) return;
          const now = yield* Clock.currentTimeMillis;
          const wait = lastSent === undefined ? 0 : lastSent + SPEAKING_INTERVAL_MS - now;
          if (wait <= 0) yield* flush(track);
          else yield* reserve(track, wait);
        }),
      ),
    // 確定した発言が届いた。そのトラックの途中結果は終わったので空にして、すぐ送る
    remark: (track: Track) =>
      unlessStopped(
        Effect.gen(function* () {
          yield* update(track, (s) => ({ ...s, partial: "" }));
          yield* flush(track);
        }),
      ),
    // 反映が終わったなど、未反映の発言が変わったとき、両トラックをすぐ送る
    flushAll:
      unlessStopped(
        Effect.gen(function* () {
          for (const track of TRACKS) yield* flush(track);
        }),
      ),
    // 予約をすべて取り消し、両トラックの空の frame を送る。stop との違いは、以後も送れる状態を保つこと
    // （取り込みの途切れの瞬間に使う。永久停止すると、起動し直し後の字幕が届かなくなる。CT-SPEAKING-CLEAR）
    clear: unlessStopped(emptyFrames()),
    // 予約をすべて取り消し、両トラックの空の frame を送る。以後は何も送らない
    stop:
      unlessStopped(
        Effect.gen(function* () {
          yield* Ref.set(stopped, true);
          yield* emptyFrames();
        }),
      ),
    // 予約のファイバーがあるか
    scheduled: Effect.map(Ref.get(state), (s) => TRACKS.some((track) => s[track].timer !== undefined)),
  };
});
