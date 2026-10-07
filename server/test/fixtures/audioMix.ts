import { writeFile } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { AudioMix, AudioMixFailed } from "../../src/audioMix.ts";
import { REVIEW_AUDIO_ELEMENT_ID } from "../../src/core/index.ts";

// 偽の mix が出力先に書く小さなバイト列（m4a ではないが、中身は何でもよい。0〜255 を全部含めて、base64 の往復を確かめられる）
export const FAKE_MIX_BYTES = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

export type FakeMix = {
  layer: Layer.Layer<AudioMix>;
  calls: { session: string; out: string; track?: "自分" }[];
  // 設定すると、次からの mix はこの理由で AudioMixFailed になる（出力先には何も書かない）
  failure: { reason: string | null };
};

// mix の Service の偽物。出力先に小さなバイト列を書く、または失敗する。呼び出しの引数を記録する
export function fakeAudioMix(): FakeMix {
  const calls: FakeMix["calls"] = [];
  const failure: FakeMix["failure"] = { reason: null };
  const layer = Layer.succeed(AudioMix, AudioMix.of({
    mix: (session, out, track) => {
      calls.push({ session, out, track });
      if (failure.reason !== null) return Effect.fail(new AudioMixFailed({ message: failure.reason }));
      return Effect.tryPromise({
        try: () => writeFile(out, FAKE_MIX_BYTES),
        catch: (e) => new AudioMixFailed({ message: String(e) }),
      });
    },
  }));
  return { layer, calls, failure };
}

// 書き出した HTML に埋め込まれた音声を、元のバイト列に読み戻す。要素が無ければ null
export function embeddedAudio(html: string): Buffer | null {
  const match = new RegExp(`id="${REVIEW_AUDIO_ELEMENT_ID}"[^>]*>([\\s\\S]*?)</`).exec(html);
  return match === null ? null : Buffer.from(match[1]!.trim(), "base64");
}
