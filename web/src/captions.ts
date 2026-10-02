import type { Track } from "../../server/src/core/index.ts";
import type { Speaking } from "./useLiveFeed.ts";

// 字幕に残す文の数（トラックごと）。古い文は文ごとまとめて消す（文字単位で前から削ると目が滑る）
export const CAPTION_LINES = 2;

// 文の区切り（句点・疑問符・感嘆符の後ろ）で分ける。区切りの後ろの空白は捨てる
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[。？！?!])\s*/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export type Caption = { track: Track; lines: string[] };

// 字幕。トラックごとに 1 ブロック（相手 → 自分）で、文ごとに 1 行、末尾の CAPTION_LINES 文だけを出す。文字が空のトラックは出さない
export function captionsOf(speaking: Speaking): Caption[] {
  return (["相手", "自分"] as const).flatMap((track) => {
    const lines = sentencesOf(speaking[track]).slice(-CAPTION_LINES);
    return lines.length === 0 ? [] : [{ track, lines }];
  });
}
