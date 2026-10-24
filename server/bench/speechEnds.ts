import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { describe } from "../src/truthFile.ts";
import { exitNaturally } from "../src/exitNaturally.ts";
import { runFfmpegFilter } from "./ffmpeg.ts";
import { benchProgram, InvalidInputFile, write } from "./entry.ts";
import type { SpokenLine } from "./sttLatency.ts";

export type Silence = { start: number; end?: number };

// ffmpeg（silencedetect）の出力から、無音区間の列と録音の長さ（秒）を読む。末尾の無音は end が無いことがある
export function parseSilenceDetect(text: string): { duration: number | undefined; silences: Silence[] } {
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(text);
  const duration = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : undefined;
  const silences: Silence[] = [];
  for (const m of text.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    const value = Number(m[2]);
    if (m[1] === "start") silences.push({ start: value });
    else {
      const last = silences[silences.length - 1];
      if (last && last.end === undefined) last.end = value;
    }
  }
  return { duration, silences };
}

export function speechLines(silences: readonly Silence[], duration: number, minSpeechSeconds: number): SpokenLine[] {
  const lines: SpokenLine[] = [];
  let speechStart = 0;
  const push = (end: number) => {
    if (end > speechStart && end - speechStart >= minSpeechSeconds) lines.push({ start: speechStart, end });
  };
  for (const silence of silences) {
    push(silence.start);
    if (silence.end === undefined || silence.end >= duration) return lines;
    speechStart = silence.end;
  }
  push(duration);
  return lines;
}

const runSilenceDetect = Effect.fnUntraced(function* (file: string, noise: number, minSilence: number) {
  const { exitCode, output } = yield* runFfmpegFilter(file, `silencedetect=noise=${noise}dB:d=${minSilence}`);
  if (exitCode !== 0) return yield* new InvalidInputFile({ path: file, reason: `ffmpeg が失敗した（終了コード ${exitCode}）` });
  return output;
}, Effect.catchTag("PlatformError", (e) => Effect.fail(new InvalidInputFile({ path: "ffmpeg", reason: describe(e) }))));

export const command = Command.make(
  "speechEnds",
  {
    audio: Argument.String("audio").pipe(Argument.withDescription("実会議の録音（ffmpeg が読める音声ファイル）")),
    noise: Flag.Finite("noise").pipe(Flag.withDescription("無音とみなす音量（dB）。既定 -30"), Flag.withDefault(-30)),
    minSilence: Flag.Finite("min-silence").pipe(Flag.withDescription("無音として数える最短の秒数。既定 0.5"), Flag.withDefault(0.5)),
    minSpeech: Flag.Finite("min-speech").pipe(Flag.withDescription("行にする話している区間の最短の秒数（雑音の一瞬を捨てる）。既定 0.2"), Flag.withDefault(0.2)),
  },
  Effect.fn("speechEnds")(function* ({ audio, minSilence, minSpeech, noise }) {
    const { duration, silences } = parseSilenceDetect(yield* runSilenceDetect(audio, noise, minSilence));
    if (duration === undefined) {
      return yield* new InvalidInputFile({ path: audio, reason: "ffmpeg で録音の長さを読めない" });
    }
    yield* write(JSON.stringify(speechLines(silences, duration, minSpeech)) + "\n");
  }),
).pipe(
  Command.withDescription(
    "録音の無音区間（ffmpeg の silencedetect）の始まりを話し終わりとして、行の時刻の JSON（[{start,end}]）を標準出力に出す。"
      + "出力は sttLatency.ts・sttReplay.ts の --lines にそのまま渡せる。ffmpeg が PATH 上に要る",
  ),
);

if (import.meta.main) {
  benchProgram(command).pipe(
    NodeRuntime.runMain({ disableErrorReporting: true, teardown: exitNaturally }),
  );
}
