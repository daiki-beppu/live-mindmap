import { DEFAULT_HEIGHT, GAP_X, GAP_Y, NODE_WIDTH, type Position } from "./layout.ts";
import type { Speaking } from "./useLiveFeed.ts";

// 仮のノードに出す末尾の文字数（コードポイント）。長い文字は、先頭を省いて末尾だけを出す
export const DRAFT_TAIL = 40;

export function tailText(text: string): string {
  const chars = Array.from(text);
  return chars.length <= DRAFT_TAIL ? text : "…" + chars.slice(-DRAFT_TAIL).join("");
}

export type Draft = { id: string; text: string };

// 仮のノード。トラックごとに 1 つまで（相手 → 自分）、文字が空のトラックには出さない
export function draftsOf(speaking: Speaking): Draft[] {
  return (["相手", "自分"] as const).flatMap((track) => (speaking[track] === "" ? [] : [{ id: `draft:${track}`, text: tailText(speaking[track]) }]));
}

// 仮のノードの位置。正式なノードの配置には入れず（親の位置が動くため）、配置の後に、
// ルートの子と同じ深さの x で、正式なノード全体の下端より下へ ids の順に積む。
export function draftPositions(formal: Record<string, Position>, heights: Record<string, number>, ids: string[]): Record<string, Position> {
  let y = Math.max(...Object.entries(formal).map(([id, p]) => p.y + (heights[id] ?? DEFAULT_HEIGHT)), 0) + GAP_Y;
  const result: Record<string, Position> = {};
  for (const id of ids) {
    result[id] = { x: NODE_WIDTH + GAP_X, y };
    y += (heights[id] ?? DEFAULT_HEIGHT) + GAP_Y;
  }
  return result;
}
