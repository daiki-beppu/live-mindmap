import { Effect } from "effect";
import type { ScreenEvent, ScreenOffEvent, Session } from "./session.ts";
import { createPacer } from "./pacing.ts";
import type { Remark } from "./remark.ts";
import type { Word } from "./words.ts";

export type PlaybackScreen<E> =
  | {
      readonly start: number;
      readonly image: { readonly id: string; readonly load: Effect.Effect<Uint8Array, E> } | null;
      readonly lines?: ReadonlyArray<string>;
      readonly ocrFailed?: (typeof ScreenEvent.Type)["ocrFailed"];
    }
  | { readonly start: number; readonly reason: (typeof ScreenOffEvent)["Type"]["reason"] };

export type PlaybackRemark = Remark & { readonly raw?: string; readonly words?: readonly Word[] };

export type PlaybackOptions<E> = {
  sleep?: (ms: number) => Effect.Effect<void>;
  screens?: Iterable<PlaybackScreen<E>>;
};

export const playback = Effect.fnUntraced(function* <E = never>(
  session: Session,
  remarks: Iterable<PlaybackRemark>,
  { sleep, screens }: PlaybackOptions<E> = {},
): Effect.fn.Return<void, E> {
  const { waitUntil } = createPacer(sleep);
  const waiting = [...(screens ?? [])].sort((a, b) => a.start - b.start);
  let next = 0;
  const pushNext = Effect.gen(function* () {
    const change = waiting[next++]!;
    yield* waitUntil(change.start);
    if ("reason" in change) {
      yield* session.pushScreenOff({ start: change.start, reason: change.reason });
      return;
    }
    const { start, image, lines, ocrFailed } = change;
    yield* session.pushScreen({ start, image: image === null ? null : { id: image.id, bytes: yield* image.load }, ...(ocrFailed === true ? { ocrFailed } : {}) }, lines);
  });
  for (const item of remarks) {
    const { raw, words, ...r } = item;
    while (next < waiting.length && waiting[next]!.start <= r.start) yield* pushNext;
    yield* waitUntil(r.end);
    yield* (raw !== undefined && words !== undefined ? session.push(r, { raw, words }) : session.push(r));
    if (!sleep) yield* session.idle;
  }
  while (next < waiting.length) yield* pushNext;
  yield* session.flush;
});
