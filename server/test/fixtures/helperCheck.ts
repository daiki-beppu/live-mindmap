import { Effect, Stream } from "effect";

export const readyHelperChecks = {
  check: ({ screen }: { readonly screen: boolean }) => Effect.succeed({ microphone: "authorized" as const, ...(screen ? { screenCapture: true } : {}), speechJa: { status: "installed" as const, installedLocales: ["ja-JP"] } }),
  installSpeechJa: Stream.die("このテストでは日本語モデルを導入しない"),
  creationDate: (_file: string) => Effect.succeed(null),
};

export const forbiddenHelperChecks = {
  check: (_options: { readonly screen: boolean }) => Effect.die("このテストではヘルパーを確認しない"),
  installSpeechJa: Stream.die("このテストでは日本語モデルを導入しない"),
  creationDate: (_file: string) => Effect.die("このテストではファイルの作成日時を読まない"),
};

export const readyHelperItems = [
  { name: "helper", need: "required", state: "ready", install: "swift build -c release --package-path helper" },
  { name: "microphone", need: "optional", state: "ready" },
  { name: "screen-capture", need: "optional", state: "ready" },
  { name: "speech-ja", need: "required", state: "ready", install: "pnpm cli install speech-ja" },
] as const;
