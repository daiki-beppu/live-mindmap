import { Effect, Stream } from "effect";

export const readyHelperChecks = {
  check: Effect.succeed({ microphone: "authorized" as const, screenCapture: true, speechJa: { status: "installed" as const, installedLocales: ["ja-JP"] } }),
  checkNoScreen: Effect.succeed({ microphone: "authorized" as const, speechJa: { status: "installed" as const, installedLocales: ["ja-JP"] } }),
  installSpeechJa: Stream.die("このテストでは日本語モデルを導入しない"),
};

export const forbiddenHelperChecks = {
  check: Effect.die("このテストではヘルパーを確認しない"),
  checkNoScreen: Effect.die("このテストではヘルパーを確認しない"),
  installSpeechJa: Stream.die("このテストでは日本語モデルを導入しない"),
};

export const readyHelperItems = [
  { name: "helper", need: "required", state: "ready", install: "swift build -c release --package-path helper" },
  { name: "microphone", need: "optional", state: "ready" },
  { name: "screen-capture", need: "optional", state: "ready" },
  { name: "speech-ja", need: "required", state: "ready", install: "pnpm cli install speech-ja" },
] as const;
