import { join } from "node:path";
import { Context, Effect, Layer, Option, Schema, Stream, type Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { UpdaterUnavailable } from "./updaterUnavailable.ts";
import type { HelperCommand } from "./helpers.ts";
import { appleRefusal } from "./modelSelection.ts";

const MacState = Schema.Struct({
  osVersion: Schema.NonEmptyString,
  availability: Schema.Union([
    Schema.Struct({ status: Schema.Literal("available") }),
    Schema.Struct({ status: Schema.Literal("unavailable"), reason: Schema.NonEmptyString }),
  ]),
});
const Ready = Schema.Struct({ type: Schema.Literal("ready"), url: Schema.NonEmptyString, contextSize: Schema.Literal(8192) });
const failed = (message: string) => new UpdaterUnavailable({ message });
const decode = <S extends Schema.Top>(schema: S, text: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError((error) => failed(`Apple の子プロセスの出力が不正です: ${error.message}`)),
  );

export class AppleIntelligence extends Context.Service<AppleIntelligence, {
  availability: Effect.Effect<typeof MacState.Type, UpdaterUnavailable>;
  launch: Effect.Effect<{ readonly url: string }, UpdaterUnavailable, Scope.Scope>;
}>()("live-mindmap/server/AppleIntelligence") {
  static readonly layer = (command: HelperCommand): Layer.Layer<AppleIntelligence, never, ChildProcessSpawner.ChildProcessSpawner> =>
    Layer.effect(AppleIntelligence)(Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawn = (mode: string) => spawner.spawn(ChildProcess.make(command.command, [...command.args, mode], {
        stdin: "ignore", forceKillAfter: 5_000,
      })).pipe(Effect.mapError((error) => failed(`Apple の子プロセスを起動できません: ${error.message}\nhelper を release ビルドしてからやり直してください`)));
      const availability = Effect.scoped(Effect.gen(function* () {
        const child = yield* spawn("availability");
        const [stdout, stderr, code] = yield* Effect.all([
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
        ], { concurrency: "unbounded" }).pipe(Effect.mapError((error) => failed(error.message)));
        if (code !== 0) return yield* failed(`Apple の利用可否を取得できません: ${stderr.trim()}（終了コード ${code}）`);
        return yield* decode(MacState, stdout);
      }));
      const launch = Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const child = yield* spawn("serve");
        yield* Effect.forkIn(Stream.runForEach(child.stderr, (chunk) => Effect.sync(() => { process.stderr.write(chunk); })).pipe(Effect.ignore), scope);
        const ready = child.stdout.pipe(Stream.decodeText, Stream.splitLines, Stream.take(1), Stream.runHead,
          Effect.mapError((error) => failed(error.message)),
          Effect.flatMap((line) => Option.isSome(line) ? decode(Schema.Union([Ready, MacState]), line.value) : Effect.fail(failed("Apple の準備情報を受け取る前に出力が閉じました"))),
          Effect.flatMap((message) => {
            if ("type" in message) return Effect.succeed(message);
            const refusal = appleRefusal(message);
            return Effect.fail(failed(refusal === undefined ? "Apple の準備情報がありません" : refusal.join("\n")));
          }));
        const endpoint = yield* ready;
        const url = yield* Effect.try({ try: () => new URL(endpoint.url), catch: () => failed("Apple の準備情報の URL が不正です") });
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port === "" || url.username !== "" || url.password !== "" || url.pathname !== "/v1" || url.search !== "" || url.hash !== "") {
          return yield* failed("Apple の推論先は子プロセスのループバック URL である必要があります");
        }
        return { url: endpoint.url };
      });
      return AppleIntelligence.of({ availability, launch });
    }));
}

export const appleCommand: HelperCommand = {
  command: join(import.meta.dirname, "../../helper/.build/release/live-mindmap-apple"), args: [],
};
