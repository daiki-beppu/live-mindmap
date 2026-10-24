import { writeFile } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { AudioMix, AudioMixFailed } from "../../src/audioMix.ts";
import { REVIEW_AUDIO_ELEMENT_ID } from "../../src/core/index.ts";

export const FAKE_MIX_BYTES = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

export type FakeMix = {
  layer: Layer.Layer<AudioMix>;
  calls: { session: string; out: string; track?: "自分" }[];
  failure: { reason: string | null };
};

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

export function embeddedAudio(html: string): Buffer | null {
  const match = new RegExp(`id="${REVIEW_AUDIO_ELEMENT_ID}"[^>]*>([\\s\\S]*?)</`).exec(html);
  return match === null ? null : Buffer.from(match[1]!.trim(), "base64");
}
