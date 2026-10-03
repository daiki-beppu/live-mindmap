// ヘルパーが WebSocket で流すイベント（helper/README.md「イベントの形」）を発言に変える。
// Node の実行環境に依存しない（ADR 0003）。
import type { Remark, Track } from "./session.ts";

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

export type HelperPartial = { track: Track; start: number; end: number; text: string; duplicate: boolean };

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
