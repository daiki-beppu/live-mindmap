import type { Remark } from "./core/index.ts";

export const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export type RemarkLineOptions = {
  text?: string;
  name?: string;
};

export const remarkLine = (r: Remark, { text = r.text, name }: RemarkLineOptions = {}): string => {
  const speaker = r.speaker ?? r.track;
  const who = name !== undefined && r.speaker !== undefined && r.track === "相手" ? `${speaker}（${name}）` : speaker;
  return `${r.id} [${fmtTime(r.start)}] ${who}: ${text}`;
};

export const nameOfSpeaker = (r: Remark, names: ReadonlyMap<string, string> | undefined): string | undefined =>
  r.speaker === undefined ? undefined : names?.get(r.speaker);
