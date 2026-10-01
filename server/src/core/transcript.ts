// 録音サンプルの文字起こしファイル（kanary transcribe の JSON）を発言の流れに変える
import type { Remark, Track } from "./session.ts";

type TranscriptFile = {
  transcript: { segments: { track: string; start_seconds: number; end_seconds: number; text: string }[] };
};

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
