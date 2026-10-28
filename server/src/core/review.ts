import { Effect, Predicate, Schema } from "effect";
import { DiffUpdatePausedEvent, DiffUpdateResumedEvent } from "./diffUpdate.ts";
import { DiscussionNoticeEvent } from "./discussionNotice.ts";
import { DiffEvent, RemarkEvent, restoreState, ScreenEvent, ScreenInputSkippedEvent, snapshotOf, StartEvent } from "./session.ts";
import type { Snapshot } from "./snapshot.ts";

export const REVIEW_LOG_ELEMENT_ID = "live-mindmap-review-log";

const BODY_END = "</body>";

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

const decodeRemark = Schema.decodeUnknownSync(RemarkEvent);
const decodeScreen = Schema.decodeUnknownSync(ScreenEvent);

const KEPT_AS_IS: ReadonlySet<unknown> = new Set([
  StartEvent.fields.type.literal,
  DiffEvent.fields.type.literal,
  ScreenInputSkippedEvent.fields.type.literal,
  DiffUpdatePausedEvent.fields.type.literal,
  DiffUpdateResumedEvent.fields.type.literal,
]);

function withoutRemarkText(event: unknown): unknown {
  const { remark: r, noContent } = decodeRemark(event);
  return {
    type: RemarkEvent.fields.type.literal,
    remark: { id: r.id, track: r.track, start: r.start, end: r.end, text: "", ...(r.duplicate === undefined ? {} : { duplicate: r.duplicate }), ...(r.speaker === undefined ? {} : { speaker: r.speaker }) },
    ...(noContent === undefined ? {} : { noContent }),
  };
}

function withoutScreenLines(event: unknown): unknown {
  const { start, image } = decodeScreen(event);
  return { type: ScreenEvent.fields.type.literal, start, image };
}

export function mapOnlyReviewEvents(events: readonly unknown[]): unknown[] {
  return events.flatMap((event, index): unknown[] => {
    const type = Predicate.isObject(event) && "type" in event ? event.type : undefined;
    try {
      if (type === RemarkEvent.fields.type.literal) return [withoutRemarkText(event)];
      if (type === ScreenEvent.fields.type.literal) return [withoutScreenLines(event)];
      return KEPT_AS_IS.has(type) ? [event] : [];
    } catch (error) {
      throw new Error(`出来事 ${index} 行目を読めません: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
