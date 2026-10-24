import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { Context, Deferred, Effect, Fiber, Layer, Predicate, Schedule, Schema, Stream, type Scope } from "effect";
import type { PlatformError } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HELPER_RUN_STDERR_TAIL_LINES, STDERR_TAIL_LINES, tailLines } from "./core/index.ts";
import { openHelperSocket } from "./helperSocket.ts";

export const HELPER_STOP_TIMEOUT_MS = Context.Reference("live-mindmap/HelperStopTimeoutMs", { defaultValue: (): number => 5_000 });

export type HelperExitInfo = { code: number | null; signal: string | null };

export class HelperLaunchFailure extends Schema.TaggedError<HelperLaunchFailure>()("HelperLaunchFailure", {
  stderrTail: Schema.Array(Schema.String),
  exit: Schema.optional(Schema.Struct({ code: Schema.NullOr(Schema.Finite), signal: Schema.NullOr(Schema.String) })),
}) {
  override get message(): string {
    return `ヘルパーを起動できません: ${this.stderrTail.join("\n")}`;
  }
}

export const HELPER_CONTROL_TOKEN_ENV = "LIVE_MINDMAP_HELPER_CONTROL_TOKEN";

export type HelperAttempt = {
  events: Stream.Stream<string>;
  stop: Effect.Effect<void>;
  exit: Effect.Effect<HelperExitInfo>;
  stderrTail: Effect.Effect<ReadonlyArray<string>>;
  send: (instruction: HelperInstruction) => Effect.Effect<void>;
};

export type HelperInstruction = { type: "self-pause" | "reading-pause"; paused: boolean };

export type HelperCommand = { command: string; args: string[] };

const readText = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) => Stream.mkString(Stream.decodeText(stream));

export const runHelperCommand = Effect.fnUntraced(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  helper: HelperCommand,
  args: ReadonlyArray<string>,
  options: { readonly stdout?: "ignore"; readonly forceKillAfter?: number } = {},
) {
  const handle = yield* spawner.spawn(ChildProcess.make(helper.command, [...helper.args, ...args], { stdin: "ignore", ...options }));
  const [stdout, stderr, code] = yield* Effect.all(
    [options.stdout === "ignore" ? Effect.succeed("") : readText(handle.stdout), readText(handle.stderr), handle.exitCode],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, code };
});

export const stderrReason = (stderr: string, code: number): string =>
  tailLines(stderr, STDERR_TAIL_LINES).join("\n").trim() || `終了コード ${code}`;

const checkFields = {
  microphone: Schema.Literals(["notDetermined", "denied", "authorized"]),
  speechJa: Schema.Struct({
    status: Schema.Literals(["unsupported", "supported", "downloading", "installed"]),
    installedLocales: Schema.Array(Schema.String),
  }),
};
const HelperCheckSchema = Schema.Struct({ ...checkFields, screenCapture: Schema.Boolean });
const HelperCheckNoScreenSchema = Schema.Struct(checkFields);
export type HelperCheck = typeof HelperCheckNoScreenSchema.Type & { readonly screenCapture?: boolean };

export class HelperCheckFailure extends Schema.TaggedError<HelperCheckFailure>()("HelperCheckFailure", {
  message: Schema.String,
}) {}

export class HelperCreationDateFailure extends Schema.TaggedError<HelperCreationDateFailure>()("HelperCreationDateFailure", {
  message: Schema.String,
}) {}

const HelperCreationDateSchema = Schema.Struct({ creationDate: Schema.NullOr(Schema.String) });

export class HelperInstallFailure extends Schema.TaggedError<HelperInstallFailure>()("HelperInstallFailure", {
  message: Schema.String,
}) {}

export class Helpers extends Context.Service<Helpers, {
  check: Effect.Effect<HelperCheck, HelperCheckFailure>;
  checkNoScreen: Effect.Effect<HelperCheck, HelperCheckFailure>;
  installSpeechJa: Stream.Stream<string, HelperInstallFailure>;
  creationDate: (file: string) => Effect.Effect<string | null, HelperCreationDateFailure>;
  apps: Effect.Effect<unknown>;
  launch: (args: ReadonlyArray<string>, stopRequested: Deferred.Deferred<void>) => Effect.Effect<HelperAttempt, HelperLaunchFailure, Scope.Scope>;
}>()("live-mindmap/server/Helpers") {
  static readonly layer = (helper: HelperCommand): Layer.Layer<Helpers, never, ChildProcessSpawner.ChildProcessSpawner> =>
    Layer.effect(Helpers)(make(helper));
}

// exitCode はシグナルで終わると、文面に `receipt of signal: '<SIGNAL>'` を埋めた PlatformError で失敗する。
// 文面は PlatformError の message ではなく、元の Error（cause）側にある
const SIGNAL_PATTERN = /receipt of signal: '([^']+)'/;
const exitInfoOfFailure = (error: PlatformError.PlatformError): HelperExitInfo => {
  const text = Predicate.isError(error.cause) ? error.cause.message : "";
  return { code: null, signal: SIGNAL_PATTERN.exec(text)?.[1] ?? null };
};

class HelperListFailure extends Schema.TaggedError<HelperListFailure>()("HelperListFailure", {
  message: Schema.String,
}) {}

const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const freePort = Effect.callback<number, HelperLaunchFailure>((resume) => {
  const fail = (reason: string) => resume(Effect.fail(new HelperLaunchFailure({ stderrTail: [reason] })));
  const probe = createServer();
  let closed = false;
  probe.once("error", (error) => fail(error.message));
  probe.listen(0, "127.0.0.1", () => {
    if (closed) return probe.close();
    const address = probe.address();
    if (!address || typeof address === "string") return fail("空きポートを取得できません");
    probe.close(() => resume(Effect.succeed(address.port)));
  });
  return Effect.sync(() => {
    closed = true;
    probe.close();
  });
});

const connectRetry = Schedule.min([Schedule.exponential("10 millis"), Schedule.spaced("200 millis")]);

const make = Effect.fnUntraced(function* (helper: HelperCommand) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const stopTimeoutMs = yield* HELPER_STOP_TIMEOUT_MS;

  const listFailed = (reason: string) => Effect.die(new HelperListFailure({ message: reason }));
  const apps = Effect.scoped(
    Effect.gen(function* () {
      const { stdout, stderr, code } = yield* runHelperCommand(spawner, helper, ["list"]);
      if (code !== 0) return yield* listFailed(`ヘルパーの list が失敗しました: ${stderr.trim() || `終了コード ${code}`}`);
      return yield* decodeJsonText(stdout).pipe(
        Effect.catchTag("SchemaError", () => listFailed(`ヘルパーの list の出力が JSON ではありません: ${stdout.trim()}`)),
      );
    }),
  ).pipe(Effect.catchTag("PlatformError", (error) => listFailed(`ヘルパーの list が失敗しました: ${error.message}`)));

  const check = Effect.fnUntraced(function* (noScreen: boolean) {
    const { stdout, stderr, code } = yield* runHelperCommand(spawner, helper, ["check", ...(noScreen ? ["--no-screen"] : [])], { forceKillAfter: stopTimeoutMs });
    if (code !== 0) return yield* new HelperCheckFailure({ message: `ヘルパーの check が失敗しました: ${stderr.trim() || `終了コード ${code}`}` });
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(noScreen ? HelperCheckNoScreenSchema : HelperCheckSchema))(stdout);
  }, Effect.scoped, Effect.mapError((error) => new HelperCheckFailure({ message: error.message })));

  const creationDate = Effect.fnUntraced(function* (file: string) {
    const { stdout, stderr, code } = yield* runHelperCommand(spawner, helper, ["creation-date", "--file", file], { forceKillAfter: stopTimeoutMs });
    if (code !== 0) return yield* new HelperCreationDateFailure({ message: `ヘルパーの creation-date が失敗しました: ${stderr.trim() || `終了コード ${code}`}` });
    const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(HelperCreationDateSchema))(stdout);
    return decoded.creationDate;
  }, Effect.scoped, Effect.mapError((error) => new HelperCreationDateFailure({ message: error.message })));

  const installSpeechJa = Stream.unwrap(Effect.gen(function* () {
    const handle = yield* spawner.spawn(ChildProcess.make(helper.command, [...helper.args, "install-speech-ja"], {
      stdin: "ignore", stdout: "ignore", forceKillAfter: stopTimeoutMs,
    }));
    const scope = yield* Effect.scope;
    const exited = yield* Effect.forkIn(handle.exitCode, scope);
    let stderrTail: ReadonlyArray<string> = [];
    const progress = handle.stderr.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.tap((line) => Effect.sync(() => { stderrTail = [...stderrTail, line].slice(-STDERR_TAIL_LINES); })),
    );
    const completed = Effect.gen(function* () {
      const code = yield* Fiber.join(exited);
      if (code !== 0) return yield* new HelperInstallFailure({ message: `日本語モデルの導入が失敗しました: ${stderrTail.join("\n") || `終了コード ${code}`}` });
    });
    return Stream.concat(progress, Stream.drain(Stream.fromEffect(completed)));
  })).pipe(Stream.mapError((error) => new HelperInstallFailure({ message: error.message })));

  const launch = Effect.fnUntraced(function* (
    args: ReadonlyArray<string>,
    stopRequested: Deferred.Deferred<void>,
  ): Effect.fn.Return<HelperAttempt, HelperLaunchFailure, Scope.Scope> {
    const scope = yield* Effect.scope;
    const port = yield* freePort;
    const controlToken = randomBytes(32).toString("hex");
    // 既定の detached: true のまま起動し、プロセスグループごと止める。forceKillAfter は Scope の後始末（kill を通らない）にも効かせる
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(helper.command, [...helper.args, ...args, "--port", String(port)], {
          stdin: "ignore",
          stdout: "ignore",
          env: { [HELPER_CONTROL_TOKEN_ENV]: controlToken },
          extendEnv: true,
          forceKillAfter: stopTimeoutMs,
        }),
      )
      .pipe(Effect.mapError((error) => new HelperLaunchFailure({ stderrTail: [error.message], exit: { code: null, signal: null } })));

    const stderrChunks: Uint8Array[] = [];
    const stderrFiber = yield* Effect.forkIn(
      handle.stderr.pipe(
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            process.stderr.write(chunk);
            stderrChunks.push(chunk);
          }),
        ),
        Effect.ignore({ log: "Debug", message: "ヘルパーの標準エラーを読み切れない" }),
      ),
      scope,
    );
    const stderrTail = Effect.sync(() => tailLines(Buffer.concat(stderrChunks).toString(), HELPER_RUN_STDERR_TAIL_LINES));

    // exitCode は "exit" で解決するので、標準エラーのストリームを読み終えてから終わり方を確定する
    const exited = yield* Deferred.make<HelperExitInfo>();
    yield* Effect.forkIn(
      Effect.gen(function* () {
        const info = yield* handle.exitCode.pipe(
          Effect.map((code): HelperExitInfo => ({ code, signal: null })),
          Effect.catch((error) => Effect.succeed(exitInfoOfFailure(error))),
        );
        yield* Fiber.join(stderrFiber);
        yield* Deferred.succeed(exited, info);
      }),
      scope,
    );

    const stop = handle.kill({ forceKillAfter: stopTimeoutMs }).pipe(Effect.ignore({ log: "Debug", message: "ヘルパーを止められない" }));
    yield* Effect.forkIn(Effect.andThen(Deferred.await(stopRequested), stop), scope);

    // 間隔は 10ms から倍々に伸ばし、200ms で頭打ちにする（Schedule.min は短い方の待ちを使い、spaced が止まらないので終わらない）
    const connect = openHelperSocket(`ws://127.0.0.1:${port}`).pipe(
      Effect.retry(connectRetry),
      Effect.catchTag("HelperSocketError", (error) => Effect.die(error)),
    );
    const helperEnded = Effect.gen(function* () {
      const exit = yield* Deferred.await(exited);
      return yield* new HelperLaunchFailure({ stderrTail: yield* stderrTail, exit });
    });
    const socket = yield* Effect.raceFirst(connect, helperEnded);
    const send = (instruction: HelperInstruction) => socket.send(JSON.stringify({ ...instruction, token: controlToken }));

    return { events: socket.events, stop, exit: Deferred.await(exited), stderrTail, send };
  });

  return Helpers.of({ apps, launch, check: check(false), checkNoScreen: check(true), installSpeechJa, creationDate });
});
