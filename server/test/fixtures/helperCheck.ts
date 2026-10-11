import { Effect } from "effect";

export const readyHelperChecks = {
  check: Effect.succeed({ microphone: "authorized" as const, screenCapture: true, speechJa: { status: "supported" as const, installedLocales: [] } }),
  checkNoScreen: Effect.succeed({ microphone: "authorized" as const, speechJa: { status: "supported" as const, installedLocales: [] } }),
};

export const forbiddenHelperChecks = {
  check: Effect.die("このテストではヘルパーを確認しない"),
  checkNoScreen: Effect.die("このテストではヘルパーを確認しない"),
};

export const readyHelperItems = [
  { name: "helper", need: "required", state: "ready", install: "swift build -c release --package-path helper" },
  { name: "microphone", need: "optional", state: "ready" },
  { name: "screen-capture", need: "optional", state: "ready" },
] as const;
