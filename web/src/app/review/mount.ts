// <audio> の要素の Mount（Issue #824）。時刻（timeupdate と、鳴っている間の毎フレームの currentTime）と終わり（ended）を Message にするだけ。
// args は固定なので、<audio> への操作は Mount ではなく update が返す Command で行う。
// 背景のタブでは rAF が止まるので timeupdate も聞く。rAF は要素の play/playing で始め、pause/ended/release で止める
import { Effect, Queue, Stream } from "effect";
import { Mount } from "foldkit";
import { Message } from "./message.ts";

type Observed = typeof Message.UpdatedAudioTime.Type | typeof Message.EndedAudio.Type;

export const ObserveAudio = Mount.defineStream("ObserveAudio", {
  messages: [Message.UpdatedAudioTime, Message.EndedAudio],
  execute: ({ element }) =>
    Stream.callback<Observed>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const audio = element as HTMLAudioElement;
          const emitTime = () => Queue.offerUnsafe(queue, Message.UpdatedAudioTime({ time: audio.currentTime }));
          let frame: number | undefined;
          const stopFrames = () => {
            if (frame !== undefined) cancelAnimationFrame(frame);
            frame = undefined;
          };
          const tick = () => {
            emitTime();
            frame = requestAnimationFrame(tick);
          };
          const startFrames = () => {
            if (frame === undefined) frame = requestAnimationFrame(tick);
          };
          const onEnded = () => {
            stopFrames();
            Queue.offerUnsafe(queue, Message.EndedAudio());
          };
          audio.addEventListener("timeupdate", emitTime);
          audio.addEventListener("play", startFrames);
          audio.addEventListener("playing", startFrames);
          audio.addEventListener("pause", stopFrames);
          audio.addEventListener("ended", onEnded);
          if (!audio.paused) startFrames();
          return () => {
            stopFrames();
            audio.removeEventListener("timeupdate", emitTime);
            audio.removeEventListener("play", startFrames);
            audio.removeEventListener("playing", startFrames);
            audio.removeEventListener("pause", stopFrames);
            audio.removeEventListener("ended", onEnded);
          };
        }),
        (release) => Effect.sync(release),
      ).pipe(Effect.andThen(Effect.never)),
    ),
});
