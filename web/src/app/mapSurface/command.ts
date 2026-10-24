import { Effect } from "effect";
import { Command, Render } from "foldkit";
import { Message } from "./message.ts";

const BLINK_SELECTOR = ".map-surface .map-node--blink";

// 同じ key の要素にクラスが付いたままだと CSS アニメーションは再生し直されないので、描画が確定した後に、animation を一度外して reflow させてから戻す。
// 終わったアニメーションは getAnimations() に残らないので、アニメーションの API ではなく CSS の animation の指定で作り直す
export const RestartBlink = Command.define("RestartBlink", {
  messages: [Message.CompletedRestartBlink],
  execute: Render.afterCommit.pipe(
    Effect.andThen(
      Effect.sync(() => {
        const elements = Array.from(document.querySelectorAll<HTMLElement>(BLINK_SELECTOR));
        for (const element of elements) element.style.animation = "none";
        // reflow を起こして、外した状態を確定させる
        void document.body.offsetWidth;
        for (const element of elements) element.style.removeProperty("animation");
      }),
    ),
    Effect.as(Message.CompletedRestartBlink()),
  ),
});
