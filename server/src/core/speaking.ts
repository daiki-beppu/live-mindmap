// いま話している文字（仮のノードに出す文字）。マップ（Snapshot）には入れない。
// Node の実行環境に依存しない（ADR 0003）。
import { Schema } from "effect";
import { Track, type Remark } from "./remark.ts";

// ブラウザへ送る frame。スナップショットの frame とは type で見分ける
export const SpeakingFrame = Schema.Struct({ type: Schema.Literal("speaking"), track: Track, text: Schema.String });
export type SpeakingFrame = typeof SpeakingFrame["Type"];

// そのトラックの未反映の発言を受け取った順に並べ、最後に途中結果を付ける。空の文字は除いて半角スペースでつなぐ。
export function speakingText(unreflected: Remark[], track: Track, partial: string): string {
  return [...unreflected.filter((r) => r.track === track).map((r) => r.text), partial].filter((t) => t !== "").join(" ");
}
