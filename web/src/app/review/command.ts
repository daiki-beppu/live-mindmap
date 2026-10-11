// 録音つきの見返しが <audio> に書く Command（Issue #824）。<audio> は REVIEW_AUDIO_ID で引く。
// Model の後を追って DOM に書くだけで、結果は Command ごとの Message で update に戻す
import { Effect, Schema } from "effect";
import { Command, Render } from "foldkit";
import { Message } from "./message.ts";

// server の REVIEW_AUDIO_ELEMENT_ID（base64 の script 要素）とぶつけない
export const REVIEW_AUDIO_ID = "review-audio";

const audioElement = Effect.sync(() => document.getElementById(REVIEW_AUDIO_ID) as HTMLAudioElement | null);

// 鳴らせなかったときは、止めた状態に戻す側（AbortError 以外の失敗）として返す。AbortError は別の play()/pause() に割り込まれただけなので無視させる
export const PlayAudio = Command.define("PlayAudio", {
  messages: [Message.SucceededPlayAudio, Message.FailedPlayAudio],
  execute: Effect.flatMap(audioElement, (audio) =>
    audio === null
      ? Effect.succeed(Message.FailedPlayAudio({ isAborted: false }))
      : Effect.tryPromise({ try: () => audio.play(), catch: (error) => error }).pipe(
          Effect.as(Message.SucceededPlayAudio()),
          Effect.catch((error) => Effect.succeed(Message.FailedPlayAudio({ isAborted: error instanceof DOMException && error.name === "AbortError" }))),
        ),
  ),
});

export const PauseAudio = Command.define("PauseAudio", {
  messages: [Message.CompletedPauseAudio],
  execute: audioElement.pipe(Effect.map((audio) => { audio?.pause(); return Message.CompletedPauseAudio(); })),
});

export const SeekAudio = Command.define("SeekAudio", {
  args: { time: Schema.Finite },
  messages: [Message.CompletedSeekAudio],
  execute: ({ time }) => audioElement.pipe(Effect.map((audio) => { if (audio !== null) audio.currentTime = time; return Message.CompletedSeekAudio(); })),
});

// 声の高さは変えない（preservesPitch）。defaultPlaybackRate も揃えるのは、src を差し替えたときに速さが戻らないようにするため
export const WriteAudioSettings = Command.define("WriteAudioSettings", {
  args: { rate: Schema.Finite, muted: Schema.Boolean, volume: Schema.Finite },
  messages: [Message.CompletedWriteAudioSettings],
  execute: ({ rate, muted, volume }) =>
    audioElement.pipe(
      Effect.map((audio) => {
        if (audio !== null) {
          audio.preservesPitch = true;
          audio.defaultPlaybackRate = rate;
          audio.playbackRate = rate;
          audio.muted = muted;
          audio.volume = volume;
        }
        return Message.CompletedWriteAudioSettings();
      }),
    ),
});

const releaseFocus = Effect.sync(() => {
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
});

// 押して離したあと、今フォーカスのある要素からフォーカスを外す（矢印キーなどの操作がシークバーなどに奪われたままにならないように）
export const ReleaseFocus = Command.define("ReleaseFocus", {
  messages: [Message.CompletedReleaseFocus],
  execute: releaseFocus.pipe(Effect.as(Message.CompletedReleaseFocus())),
});

// 速さのメニューで項目を選んだあと。Menu は閉じるときに自分の Command（FocusButton）でボタンへフォーカスを戻す。
// その Command は commit を待ってから focus するので、同じ時点で外すと順序が決まらない。commit と次の描画を待ってから外し、ボタンに戻されたフォーカスを最後に外す
export const ReleaseFocusAfterMenuClose = Command.define("ReleaseFocusAfterMenuClose", {
  messages: [Message.CompletedReleaseFocusAfterMenuClose],
  execute: Render.afterPaint.pipe(Effect.andThen(releaseFocus), Effect.as(Message.CompletedReleaseFocusAfterMenuClose())),
});
