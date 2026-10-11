// 録音なしの見返しの時計（Issue #824）。進めている間だけ rAF を開き、フレームの ms を Message にする（update は ms を経過秒にして reducer へ渡す）
import { Option } from "effect";
import { Subscription } from "foldkit";
import type { Context } from "./context.ts";
import type { Model } from "./main.ts";
import { Message } from "./message.ts";

export const makeSubscriptions = (context: Context) =>
  Subscription.make<Model, Message>()(() => ({
    frame: Subscription.animationFrameEntry({
      isActive: (model) => model.playback.playing && Option.isNone(context.maybeAudioUrl),
      toMessage: (ms) => Message.TickedFrame({ ms }),
    }),
  }));
