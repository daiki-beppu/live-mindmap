// ヘルパーが WebSocket で流すイベント（helper/README.md「イベントの形」）を発言に変える。
// Node の実行環境に依存しない（ADR 0003）。
import { Effect, Schema } from "effect";
import { Track, type Remark } from "./session.ts";

// partial（途中結果）と remark（確定結果）が共通して持つ項目。
// duplicate の項目がないイベントは、重複ではないものとして扱う（helper/README.md「イベントの形」）
const helperRemarkFields = {
  track: Track,
  start: Schema.Number,
  end: Schema.Number,
  text: Schema.String,
  duplicate: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
};

// ヘルパーのイベントの形（helper/README.md「イベントの形」）。段 3 で decodeHelperEvent から使う。
// hostTime は 64 bit の値で JSON の number では桁が落ちるため、数字だけの文字列に限る（number は受け付けない）。
export const HelperEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("remark"), ...helperRemarkFields }),
  Schema.Struct({ type: Schema.Literal("partial"), ...helperRemarkFields }),
  Schema.Struct({ type: Schema.Literal("origin"), hostTime: Schema.String.check(Schema.isPattern(/^\d+$/)) }),
]);
export type HelperEvent = typeof HelperEvent["Type"];

const isTrack = (v: unknown): v is Track => v === "自分" || v === "相手";

// remark は、渡された ID を付けた発言にする。partial（途中結果）と知らない type は発言ではないので null。
// remark の必須項目が壊れているときは、読み飛ばさずに例外にする。ID はヘルパーが持たないので呼び出し側が採番する。
export function remarkFromHelper(data: unknown, id: string): Remark | null {
  if (typeof data !== "object" || data === null) throw new Error("ヘルパーのイベントがオブジェクトではありません");
  const e = data as Record<string, unknown>;
  if (e.type !== "remark") return null;
  if (!isTrack(e.track)) throw new Error(`remark の track が不正です: ${String(e.track)}`);
  if (typeof e.start !== "number" || typeof e.end !== "number") throw new Error("remark の start / end が数値ではありません");
  if (typeof e.text !== "string") throw new Error("remark の text が文字列ではありません");
  return { id, track: e.track, start: e.start, end: e.end, text: e.text, duplicate: e.duplicate === true };
}

export const HelperPartial = Schema.Struct(helperRemarkFields);
export type HelperPartial = typeof HelperPartial["Type"];

// partial（いま話している途中結果）。仮のノードの表示と、1 秒更新されなかった発話の発言化（settle.ts）に使う。partial 以外は null。
// 必須項目が壊れているときは、remark と同じく例外にする（start / end のない旧形式も受け付けない）。
// duplicate の項目がない partial は、重複ではないものとして扱う。
export function partialFromHelper(data: unknown): HelperPartial | null {
  if (typeof data !== "object" || data === null) throw new Error("ヘルパーのイベントがオブジェクトではありません");
  const e = data as Record<string, unknown>;
  if (e.type !== "partial") return null;
  if (!isTrack(e.track)) throw new Error(`partial の track が不正です: ${String(e.track)}`);
  if (typeof e.start !== "number" || typeof e.end !== "number") throw new Error("partial の start / end が数値ではありません");
  if (typeof e.text !== "string") throw new Error("partial の text が文字列ではありません");
  return { track: e.track, start: e.start, end: e.end, text: e.text, duplicate: e.duplicate === true };
}

// origin（ヘルパーが決めた時刻の原点。host time）。64 bit の値は JSON の number では桁が落ちるので、
// ヘルパーは文字列で送る。ここではその文字列をそのまま返す（サーバーは --origin へそのまま渡すだけで、数値として扱わない）。
// remark・partial・知らない type は原点の通知ではないので null。必須項目が壊れていれば例外にする（number 型の hostTime も拒否する）。
export function originFromHelper(data: unknown): string | null {
  if (typeof data !== "object" || data === null) throw new Error("ヘルパーのイベントがオブジェクトではありません");
  const e = data as Record<string, unknown>;
  if (e.type !== "origin") return null;
  if (typeof e.hostTime !== "string" || !/^\d+$/.test(e.hostTime)) throw new Error("origin の hostTime が数字の文字列ではありません");
  return e.hostTime;
}
