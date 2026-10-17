// 発言を 1 行にする書式（Issue #1021）。クラウドのプロンプトもローカルのプロンプトも、この関数を通す。
// 形は「ID [mm:ss] 話者: 本文」。話者は「相手 A」「相手」「自分」。SDK に依存しない（claudePrompt.test.ts が SDK なしで読み込む）
import type { Remark } from "./core/index.ts";

export const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export type RemarkLineOptions = {
  text?: string; // 本文の代わりに載せる文（ローカルは文ごとの行を作る）
  name?: string; // 相手のラベルに添える名前。「相手 B（田中）」
};

export const remarkLine = (r: Remark, { text = r.text, name }: RemarkLineOptions = {}): string => {
  const speaker = r.speaker ?? r.track;
  const who = name !== undefined && r.speaker !== undefined && r.track === "相手" ? `${speaker}（${name}）` : speaker;
  return `${r.id} [${fmtTime(r.start)}] ${who}: ${text}`;
};

// 発言の話者のラベルに付いた名前（Issue #1026）。話者なしの発言と、名前の表が無い呼び出しは undefined
export const nameOfSpeaker = (r: Remark, names: ReadonlyMap<string, string> | undefined): string | undefined =>
  r.speaker === undefined ? undefined : names?.get(r.speaker);
