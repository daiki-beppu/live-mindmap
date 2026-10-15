// 字幕の吹き出しを滑らせる Mount（Issue #1022）。.captions の中身（吹き出しの行の増減・並べ替え・文字の伸び）が変わるたびに、行ごとの offsetTop を前の値と比べ、
// 位置が変わった行を CAPTION_SLIDE_MS で滑らせ、新しい行は薄く現す。
// 位置は offsetTop（変形を含まない位置）で測る。getBoundingClientRect は動いている途中の見かけの位置を返し、次の動きの起点を誤って揺れが止まらなくなる（試作の失敗）。
// 差の計算は純粋な関数（slideDeltas）に分けてある
import { Effect } from "effect";
import { Mount } from "foldkit";
import { CAPTION_SLIDE_MS, slideDeltas } from "../../captions.ts";
import { Message } from "./message.ts";

// 行の印（h.DataAttribute のキー。要素には data-caption-id として付く）
export const CAPTION_ID_KEY = "caption-id";
const CAPTION_ID_ATTRIBUTE = `data-${CAPTION_ID_KEY}`;

const topsOf = (container: HTMLElement): Map<string, number> => {
  const tops = new Map<string, number>();
  for (const row of Array.from(container.children)) {
    const id = row.getAttribute(CAPTION_ID_ATTRIBUTE);
    // .captions は下端が基準で、行が増えると .captions 自体が上へ動く。行の位置は、動かない親（.layout）に対する座標にする
    if (id !== null && row instanceof HTMLElement) tops.set(id, container.offsetTop + row.offsetTop);
  }
  return tops;
};

const TIMING = { duration: CAPTION_SLIDE_MS, easing: "ease-out" };
const fadeIn = (row: Element) => row.animate([{ opacity: 0 }, { opacity: 1 }], TIMING);

const observeSlide = (container: HTMLElement): (() => void) => {
  let previous = topsOf(container);
  const rowOf = (id: string) => Array.from(container.children).find((row) => row.getAttribute(CAPTION_ID_ATTRIBUTE) === id);
  // 字幕が空のときは .captions を描かず、最初の吹き出しと同時にこの Mount が付く。その最初の行は監視より前にあるので、ここで薄く現す
  for (const id of previous.keys()) {
    const row = rowOf(id);
    if (row !== undefined) fadeIn(row);
  }
  const observer = new MutationObserver(() => {
    const current = topsOf(container);
    const { moved, entered } = slideDeltas(previous, current);
    previous = current;
    // 前の見かけの位置から、今の位置へ滑らせる（差だけ戻した位置から始める）
    for (const [id, delta] of moved) rowOf(id)?.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], TIMING);
    for (const id of entered) {
      const row = rowOf(id);
      if (row !== undefined) fadeIn(row);
    }
  });
  // 行の出入りに加え、文字が伸びて行の高さが変わるとき（下端が基準なので、上の行が押し上がる）も測り直す
  observer.observe(container, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
};

export const SlideCaptions = Mount.define("SlideCaptions", {
  messages: [Message.CompletedSlideCaptions],
  execute: ({ element }) =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => observeSlide(element as HTMLElement)),
        (stop) => Effect.sync(stop),
      );
      return Message.CompletedSlideCaptions();
    }),
});
