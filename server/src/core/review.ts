import { Effect, Predicate, Schema } from "effect";
import { DiffUpdatePausedEvent, DiffUpdateResumedEvent } from "./diffUpdate.ts";
import { DiscussionNoticeEvent } from "./discussionNotice.ts";
import { DiffEvent, InvalidLogEvent, RemarkEvent, restoreState, ScreenEvent, ScreenInputSkippedEvent, snapshotOf, SupplementEvent, StartEvent } from "./session.ts";
import type { Snapshot } from "./snapshot.ts";

export const REVIEW_LOG_ELEMENT_ID = "live-mindmap-review-log";

const BODY_END = "</body>";

const decodeSupplement = Schema.decodeUnknownEffect(SupplementEvent);
const invalidAt = (index: number) => Effect.mapError((error: Schema.SchemaError) => new InvalidLogEvent({ index, reason: error.message }));

export const prepareReviewEvents = Effect.fnUntraced(function* (events: readonly unknown[]) {
  return yield* Effect.forEach(events, Effect.fnUntraced(function* (event, index) {
    if (!Predicate.hasProperty(event, "type") || event.type !== SupplementEvent.fields.type.literal) return event;
    const { op } = yield* decodeSupplement(event).pipe(invalidAt(index));
    return { ...event, category: null, op: op === null || op.op === "delete" ? op : { ...op, kind: "補足" } };
  }));
});

// `<` は < にして、発言の中の </script> や <!-- で要素が閉じたり壊れたりしないようにする。
// インライン化した JS の中に "</body>" があっても壊れないよう、最後の </body> を使う
export function embedReviewLog(html: string, events: readonly unknown[]): string {
  const at = html.lastIndexOf(BODY_END);
  if (at < 0) throw new Error("テンプレートに </body> がありません");
  const kept = events.filter((event) => !(Predicate.hasProperty(event, "type") && event.type === DiscussionNoticeEvent.fields.type.literal));
  const json = JSON.stringify(kept).replaceAll("<", "\\u003c");
  const element = `<script type="application/json" id="${REVIEW_LOG_ELEMENT_ID}">${json}</script>`;
  return html.slice(0, at) + element + html.slice(at);
}

export const REVIEW_AUDIO_ELEMENT_ID = "live-mindmap-review-audio";

export function embedReviewAudio(html: string, base64: string): string {
  const at = html.lastIndexOf(BODY_END);
  if (at < 0) throw new Error("テンプレートに </body> がありません");
  const element = `<script type="text/plain" id="${REVIEW_AUDIO_ELEMENT_ID}">${base64}</script>`;
  return html.slice(0, at) + element + html.slice(at);
}

export const REVIEW_LICENSES_ELEMENT_ID = "live-mindmap-review-licenses";

export function embedReviewLicenses(html: string, licenses: string): string {
  const at = html.lastIndexOf(BODY_END);
  if (at < 0) throw new Error("テンプレートに </body> がありません");
  const escaped = licenses.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const element = `<template id="${REVIEW_LICENSES_ELEMENT_ID}">${escaped}</template>`;
  return html.slice(0, at) + element + html.slice(at);
}

export function reviewSnapshot(events: readonly unknown[]): Snapshot {
  return Effect.runSync(Effect.map(restoreState(events), snapshotOf));
}

const decodeRemark = Schema.decodeUnknownEffect(RemarkEvent);
const decodeScreen = Schema.decodeUnknownEffect(ScreenEvent);

const KEPT_AS_IS: ReadonlySet<unknown> = new Set([
  StartEvent.fields.type.literal,
  DiffEvent.fields.type.literal,
  SupplementEvent.fields.type.literal,
  ScreenInputSkippedEvent.fields.type.literal,
  DiffUpdatePausedEvent.fields.type.literal,
  DiffUpdateResumedEvent.fields.type.literal,
]);

const withoutRemarkText = Effect.fnUntraced(function* (event: unknown, index: number) {
  const { remark: r, noContent } = yield* decodeRemark(event).pipe(invalidAt(index));
  return {
    type: RemarkEvent.fields.type.literal,
    remark: { id: r.id, track: r.track, start: r.start, end: r.end, text: "", ...(r.duplicate === undefined ? {} : { duplicate: r.duplicate }), ...(r.speaker === undefined ? {} : { speaker: r.speaker }) },
    ...(noContent === undefined ? {} : { noContent }),
  };
});

const withoutScreenLines = Effect.fnUntraced(function* (event: unknown, index: number) {
  const { start, image } = yield* decodeScreen(event).pipe(invalidAt(index));
  return { type: ScreenEvent.fields.type.literal, start, image };
});

export const mapOnlyReviewEvents = Effect.fnUntraced(function* (events: readonly unknown[]) {
  const rows: unknown[] = [];
  for (const [index, event] of events.entries()) {
    const type = Predicate.isObject(event) && "type" in event ? event.type : undefined;
    if (type === RemarkEvent.fields.type.literal) rows.push(yield* withoutRemarkText(event, index));
    else if (type === ScreenEvent.fields.type.literal) rows.push(yield* withoutScreenLines(event, index));
    else if (KEPT_AS_IS.has(type)) rows.push(event);
  }
  return rows;
});
