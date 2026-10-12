// マップの表示面が DOM に書く Command（Issue #826）。Model の後を追って DOM に書くだけで、結果は Message で update に戻す
import { Effect } from "effect";
import { Command, Render } from "foldkit";
import { Message } from "./message.ts";

// 点滅のアニメーションの対象。view が点滅の対象のノードに付けるクラス（styles.css の .map-node--blink）
const BLINK_SELECTOR = ".map-surface .map-node--blink";

// 反映の番号が変わった後も点滅の対象であるノードの点滅を、最初から再生し直す。
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
