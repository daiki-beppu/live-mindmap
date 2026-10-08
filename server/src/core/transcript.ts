// 録音サンプルの文字起こしファイル（kanary transcribe の JSON）を発言の流れに変える
import { Schema } from "effect";
import type { Remark, Track } from "./session.ts";

// 読み込む側（cli play）がこの Schema で decode する。使うのは segments の 4 項目だけで、ほかのキーは見ない
export const TranscriptFile = Schema.Struct({
  transcript: Schema.Struct({
    segments: Schema.Array(
      Schema.Struct({
        track: Schema.String,
        start_seconds: Schema.Finite,
        end_seconds: Schema.Finite,
        text: Schema.String,
      }),
    ),
  }),
});
export type TranscriptFile = typeof TranscriptFile["Type"];

// 録音サンプルは会議アプリの音を 1 本に混ぜたものなので、マイク以外は `相手` とする
const toTrack = (track: string): Track => (track === "microphone" ? "自分" : "相手");

export function fromTranscript(file: TranscriptFile): Remark[] {
  return file.transcript.segments.map((s, i) => ({
    id: `r${i + 1}`,
    track: toTrack(s.track),
    start: s.start_seconds,
    end: s.end_seconds,
    text: s.text,
  }));
}
