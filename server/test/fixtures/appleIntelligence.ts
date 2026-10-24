import { Effect, Layer } from "effect";
import { AppleIntelligence } from "../../src/appleIntelligence.ts";

export const unusedApple = Layer.succeed(AppleIntelligence, AppleIntelligence.of({
  availability: Effect.die("このテストでは Apple の利用可否を問い合わせません"),
  launch: Effect.die("このテストでは Apple を起動しません"),
}));

export const availableApple = Layer.succeed(AppleIntelligence, AppleIntelligence.of({
  availability: Effect.succeed({ osVersion: "27.0", availability: { status: "available" } }),
  launch: Effect.die("このテストでは Apple を起動しません"),
}));
