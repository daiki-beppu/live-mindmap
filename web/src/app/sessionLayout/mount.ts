// 位置は offsetTop（変形を含まない位置）で測る。getBoundingClientRect は動いている途中の見かけの位置を返し、次の動きの起点を誤って揺れが止まらなくなる（試作の失敗）。
import { Effect } from "effect";
import { Mount } from "foldkit";
import { CAPTION_SLIDE_MS, slideDeltas } from "../../captions.ts";
import { Message } from "./message.ts";

export const CAPTION_ID_KEY = "caption-id";
const CAPTION_ID_ATTRIBUTE = `data-${CAPTION_ID_KEY}`;

const topsOf = (container: HTMLElement): Map<string, number> => {
  const tops = new Map<string, number>();
  for (const row of Array.from(container.children)) {
    const id = row.getAttribute(CAPTION_ID_ATTRIBUTE);
    if (id !== null && row instanceof HTMLElement) tops.set(id, container.offsetTop + row.offsetTop);
  }
  return tops;
};

const TIMING = { duration: CAPTION_SLIDE_MS, easing: "ease-out" };
const fadeIn = (row: Element) => row.animate([{ opacity: 0 }, { opacity: 1 }], TIMING);

const observeSlide = (container: HTMLElement): (() => void) => {
  let previous = topsOf(container);
  const rowOf = (id: string) => Array.from(container.children).find((row) => row.getAttribute(CAPTION_ID_ATTRIBUTE) === id);
  for (const id of previous.keys()) {
    const row = rowOf(id);
    if (row !== undefined) fadeIn(row);
  }
  const observer = new MutationObserver(() => {
    const current = topsOf(container);
    const { moved, entered } = slideDeltas(previous, current);
    previous = current;
    for (const [id, delta] of moved) rowOf(id)?.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], TIMING);
    for (const id of entered) {
      const row = rowOf(id);
      if (row !== undefined) fadeIn(row);
    }
  });
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
