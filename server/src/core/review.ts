// 見返し用の HTML（map.html）の、Node に依存しない部分。サーバー（書き出し）とブラウザ（表示）の両方が読む。
import { Effect, Predicate, Schema } from "effect";
import { DiffUpdatePausedEvent, DiffUpdateResumedEvent } from "./diffUpdate.ts";
import { DiffEvent, RemarkEvent, restoreState, ScreenEvent, ScreenInputSkippedEvent, snapshotOf, StartEvent } from "./session.ts";
import type { Snapshot } from "./snapshot.ts";

// ログ（log.jsonl の出来事）を埋め込む <script type="application/json"> の id
export const REVIEW_LOG_ELEMENT_ID = "live-mindmap-review-log";

const BODY_END = "</body>";

// テンプレート HTML の最後の </body> の直前に、出来事を JSON 要素として差し込む。
// `<` は < にして、発言の中の </script> や <!-- で要素が閉じたり壊れたりしないようにする。
// インライン化した JS の中に "</body>" があっても壊れないよう、最後の </body> を使う
export function embedReviewLog(html: string, events: readonly unknown[]): string {
  const at = html.lastIndexOf(BODY_END);
  if (at < 0) throw new Error("テンプレートに </body> がありません");
  const json = JSON.stringify(events).replaceAll("<", "\\u003c");
  const element = `<script type="application/json" id="${REVIEW_LOG_ELEMENT_ID}">${json}</script>`;
  return html.slice(0, at) + element + html.slice(at);
}

// 音声（mix の出力を base64 にしたもの）を入れる <script type="text/plain"> の id。実行されず、base64 の文字は HTML の構文を壊さない
export const REVIEW_AUDIO_ELEMENT_ID = "live-mindmap-review-audio";

// テンプレート HTML の最後の </body> の直前に、base64 の音声を要素として差し込む（理由は embedReviewLog と同じ）
export function embedReviewAudio(html: string, base64: string): string {
  const at = html.lastIndexOf(BODY_END);
  if (at < 0) throw new Error("テンプレートに </body> がありません");
  const element = `<script type="text/plain" id="${REVIEW_AUDIO_ELEMENT_ID}">${base64}</script>`;
  return html.slice(0, at) + element + html.slice(at);
}

// 同梱したライブラリのライセンスの文言を入れる <template>（描画されない）の id
export const REVIEW_LICENSES_ELEMENT_ID = "live-mindmap-review-licenses";

// テンプレート HTML の最後の </body> の直前に、ライセンスの文言の全文を <template> として差し込む。
// `&` `<` `>` を実体参照にするので、解析時に元の文言へ戻り（textContent で全文が読める）、
// 文言の中の </body> や </script>、--> が HTML の形と embedReviewLog の「最後の </body>」の判定を壊さない。
// `&` を最初に置き換える（後だと &lt; が &amp;lt; になる）
export function embedReviewLicenses(html: string, licenses: string): string {
  const at = html.lastIndexOf(BODY_END);
  if (at < 0) throw new Error("テンプレートに </body> がありません");
  const escaped = licenses.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const element = `<template id="${REVIEW_LICENSES_ELEMENT_ID}">${escaped}</template>`;
  return html.slice(0, at) + element + html.slice(at);
}

// ログの出来事から、最後の時点のスナップショットを組み立てる。差分更新は呼ばない。
// web の入口が同期で呼ぶので Effect にしない（Service も待ちも要らない）。壊れたログでは例外を投げる
export function reviewSnapshot(events: readonly unknown[]): Snapshot {
  return Effect.runSync(Effect.map(restoreState(events), snapshotOf));
}

const decodeRemark = Schema.decodeUnknownSync(RemarkEvent);
const decodeScreen = Schema.decodeUnknownSync(ScreenEvent);

// マップの復元と時間軸が読む行のうち、文字を持たずそのまま残す type
const KEPT_AS_IS: ReadonlySet<unknown> = new Set([
  StartEvent.fields.type.literal,
  DiffEvent.fields.type.literal,
  ScreenInputSkippedEvent.fields.type.literal,
  DiffUpdatePausedEvent.fields.type.literal,
  DiffUpdateResumedEvent.fields.type.literal,
]);

// 発言の行: 復元と時間軸が読む id・track・start・end・duplicate・speaker・noContent だけを残し、本文（text は空文字）・raw・words・wordTimes は持たせない
function withoutRemarkText(event: unknown): unknown {
  const { remark: r, noContent } = decodeRemark(event);
  return {
    type: RemarkEvent.fields.type.literal,
    remark: { id: r.id, track: r.track, start: r.start, end: r.end, text: "", ...(r.duplicate === undefined ? {} : { duplicate: r.duplicate }), ...(r.speaker === undefined ? {} : { speaker: r.speaker }) },
    ...(noContent === undefined ? {} : { noContent }),
  };
}

// 共有画面の行: 復元が数える start と image だけを残し、OCR の行（lines）は持たせない
function withoutScreenLines(event: unknown): unknown {
  const { start, image } = decodeScreen(event);
  return { type: ScreenEvent.fields.type.literal, start, image };
}

// ログの出来事から、発言の文字と共有画面から読んだ文字を抜いた「マップだけ」の見返し用の出来事を作る。引数は書き換えない。
// 発言の行は残す（diff の fresh の参照・反映の時刻・根拠の発言の start が復元に要る）。画面の行も残す（diff の screenCount の検査が要る）。
// 復元と時間軸が読まない type（vocab など）は落とす。壊れた発言・画面の行は、文字を残さないよう throw する
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
