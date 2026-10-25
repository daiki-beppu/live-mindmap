import { Effect, Logger, References } from "effect";

export type LoggedEntry = { readonly level: string; readonly message: unknown };

// Command の effect を Debug まで拾う logger の下で走らせ、結果と出たログを返す
export const runCollectingLogs = async <A>(effect: Effect.Effect<A>): Promise<{ readonly result: A; readonly logs: ReadonlyArray<LoggedEntry> }> => {
  const logs: Array<LoggedEntry> = [];
  const collector = Logger.make(({ logLevel, message }) => {
    logs.push({ level: logLevel, message: Array.isArray(message) ? message[0] : message });
  });
  const result = await Effect.runPromise(effect.pipe(Effect.provide(Logger.layer([collector])), Effect.provideService(References.MinimumLogLevel, "Debug")));
  return { result, logs };
};
