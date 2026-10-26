import { Effect, Schema, Stream } from "effect";
import { HelperCheckFailure, type HelperCheck } from "../../src/helpers.ts";

const ready: HelperCheck = { microphone: "authorized", screenCapture: true, speechJa: { status: "installed", installedLocales: ["ja-JP"] } };

export const helperChecks = (state: HelperCheck | HelperCheckFailure = ready) => ({
  check: ({ screen }: { readonly screen: boolean }) => Schema.is(HelperCheckFailure)(state)
    ? Effect.fail(state)
    : Effect.succeed({ microphone: state.microphone, speechJa: state.speechJa, ...(screen ? { screenCapture: state.screenCapture ?? false } : {}) }),
  installSpeechJa: Stream.die("このテストでは日本語モデルを導入しない"),
  creationDate: (_file: string) => Effect.succeed(null),
});

export const readyHelperItems = [
  { name: "helper", need: "required", state: "ready", install: "swift build -c release --package-path helper" },
  { name: "microphone", need: "optional", state: "ready" },
  { name: "screen-capture", need: "optional", state: "ready" },
  { name: "speech-ja", need: "required", state: "ready", install: "pnpm cli install speech-ja" },
] as const;
