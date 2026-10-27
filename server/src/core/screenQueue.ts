import { Result } from "effect";
import type { DiffEvent } from "./session.ts";

type ScreenRef = NonNullable<(typeof DiffEvent.Type)["input"]["screens"]>[number];
type HeldScreen = ScreenRef & { readonly seq: number };

export type ScreenQueue = {
  readonly unsent: readonly HeldScreen[];
  readonly received: number;
  readonly carried: string | undefined;
  readonly anchor: number | undefined;
  readonly catchUp: HeldScreen | undefined;
  readonly images: boolean;
};

// 1回の差分更新に添える画面の費用を抑える。adapterの保持・未送画面の上限とは独立。
const SCREENS_MAX = 3;
const SCREEN_GAP_SECONDS = 10;

export const make = (): ScreenQueue => ({ unsent: [], received: 0, carried: undefined, anchor: undefined, catchUp: undefined, images: true });

const laterStart = (latest: HeldScreen | undefined, screen: HeldScreen): HeldScreen =>
  latest === undefined || screen.start >= latest.start ? screen : latest;

export function receive(queue: ScreenQueue, screen: ScreenRef, paused: boolean): ScreenQueue {
  const held = { start: screen.start, image: screen.image, seq: queue.received };
  return {
    ...queue, unsent: [...queue.unsent, held], received: queue.received + 1,
    catchUp: paused ? laterStart(queue.catchUp, held) : queue.catchUp,
  };
}

const byStart = <T extends ScreenRef>(screens: readonly T[]): T[] => [...screens].sort((a, b) => a.start - b.start);

function selectScreens(sorted: readonly HeldScreen[], carried: string | undefined, anchor: number | undefined, cutoff: number): HeldScreen[] {
  let lastImage = anchor;
  return sorted.filter((screen) => {
    if (screen.image === null) return true;
    const eligible = lastImage === undefined || screen.start >= lastImage + SCREEN_GAP_SECONDS
      || (screen.image === carried && cutoff >= lastImage + SCREEN_GAP_SECONDS);
    if (eligible) lastImage = screen.start;
    return eligible;
  });
}

function carriedOf(sorted: readonly ScreenRef[], attached: readonly ScreenRef[]): string | undefined {
  const latest = sorted.at(-1);
  return latest?.image != null && !attached.some((screen) => screen.image === latest.image) ? latest.image : undefined;
}

const anchorAfter = (attached: readonly ScreenRef[], previous: number | undefined): number | undefined =>
  attached.findLast((screen) => screen.image !== null)?.start ?? previous;

export function select(queue: ScreenQueue, cutoff: number): Pick<(typeof DiffEvent.Type)["input"], "screens" | "screenCount"> {
  const candidates = byStart(queue.unsent.filter((screen) => screen.start <= cutoff || (screen.image !== null && screen.image === queue.carried)));
  const selected = queue.images ? selectScreens(candidates, queue.carried, queue.anchor, cutoff) : [];
  const chosen = queue.catchUp === undefined ? selected.slice(-SCREENS_MAX) : selected;
  return {
    ...(chosen.length ? { screens: chosen.map(({ start, image }) => ({ start, image })) } : {}),
    ...(queue.received > 0 ? { screenCount: queue.received } : {}),
  };
}

export function consume(queue: ScreenQueue, event: typeof DiffEvent.Type, cutoff: number): Result.Result<ScreenQueue, string> {
  const selectedBefore = event.input.screenCount ?? 0;
  if (selectedBefore > queue.received) return Result.fail(`diff の screenCount ${selectedBefore} が、ここまでの screen の行の数 ${queue.received} より大きい`);
  const attached = event.input.screens ?? [];
  const candidates = event.input.fresh.length ? byStart(queue.unsent.filter((screen) => screen.seq < selectedBefore && (screen.start <= cutoff || (screen.image !== null && screen.image === queue.carried)))) : [];
  const carried = event.input.fresh.length ? (queue.images ? carriedOf(candidates, attached) : undefined) : queue.carried;
  const unsent = event.input.fresh.length ? queue.unsent.filter((screen) => screen.seq >= selectedBefore || screen.start > cutoff || (screen.image !== null && screen.image === carried)) : queue.unsent;
  return Result.succeed({
    ...queue, unsent, carried, anchor: anchorAfter(attached, queue.anchor),
    catchUp: queue.catchUp !== undefined && unsent.includes(queue.catchUp) ? queue.catchUp : undefined,
  });
}

export const markPaused = (queue: ScreenQueue): ScreenQueue => ({ ...queue, catchUp: queue.unsent.reduce<HeldScreen | undefined>(laterStart, undefined) });

export const skipImages = (queue: ScreenQueue): ScreenQueue => ({ ...queue, images: false, carried: undefined });
