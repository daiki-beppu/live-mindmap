import { Effect, Layer } from "effect";
import { AppleIntelligence } from "../../src/appleIntelligence.ts";

// 非 Apple の経路が問い合わせ・起動に依存していないことも確認する。
export const unusedApple = Layer.succeed(AppleIntelligence, AppleIntelligence.of({
  availability: Effect.die("このテストでは Apple の利用可否を問い合わせません"),
  launch: Effect.die("このテストでは Apple を起動しません"),
}));
