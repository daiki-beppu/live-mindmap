// ヘルパー（Swift の子プロセス）という外の世界。子プロセス・空きポート・ヘルパーへの WebSocket を受け持つ（ADR 0008）。
// 子プロセスは effect/process（Node では NodeChildProcessSpawner）で起動する。1 回分の起動は呼び出し側の Scope 1 つで、
// ヘルパーの停止はその Scope の後始末。SIGTERM から SIGKILL へ上げる待ちは forceKillAfter に任せる。
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { Context, Deferred, Effect, Fiber, Layer, Predicate, Schedule, Schema, Stream, type Scope } from "effect";
import type { PlatformError } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HELPER_RUN_STDERR_TAIL_LINES, STDERR_TAIL_LINES, tailLines } from "./core/index.ts";
import { openHelperSocket } from "./helperSocket.ts";

// SIGTERM を送ってから、SIGKILL に切り替えるまでの待ち時間
export const HELPER_STOP_TIMEOUT_MS = 5_000;

// ヘルパーの終わり方。code で終われば signal は null、シグナルで落ちれば code が null
export type HelperExitInfo = { code: number | null; signal: string | null };

// 起動（接続まで）が成り立たなかった。ヘルパーが終わっていれば exit に終わり方が入る
export class HelperLaunchFailure extends Schema.TaggedError<HelperLaunchFailure>()("HelperLaunchFailure", {
  stderrTail: Schema.Array(Schema.String),
  exit: Schema.optional(Schema.Struct({ code: Schema.NullOr(Schema.Finite), signal: Schema.NullOr(Schema.String) })),
}) {
  override get message(): string {
    return `ヘルパーを起動できません: ${this.stderrTail.join("\n")}`;
  }
}

// helper が休止の指示を認証するトークンを受け取る環境変数名（helper/README.md「サーバーからの指示」）。起動ごとに作った値を渡し、指示の JSON の token で返す
export const HELPER_CONTROL_TOKEN_ENV = "LIVE_MINDMAP_HELPER_CONTROL_TOKEN";

// 接続できたヘルパー 1 回分
export type HelperAttempt = {
  // ヘルパーが WebSocket で送ったテキストを届いた順に流す。ヘルパーとの接続が閉じると終わる
  events: Stream.Stream<string>;
  // ヘルパーを止める（SIGTERM。HELPER_STOP_TIMEOUT_MS 経っても終わらなければ SIGKILL）。終わるまで戻らない
  stop: Effect.Effect<void>;
  // ヘルパーの終わり方。標準エラーを読み終えてから返す
  exit: Effect.Effect<HelperExitInfo>;
  // 標準エラーの末尾（exit が返った後の値が確定した値）
  stderrTail: Effect.Effect<ReadonlyArray<string>>;
  // 自分の休止・再開の指示を送る（Issue #1069）。paused は求める状態。helper に届かなくても失敗にしない
  send: (paused: boolean) => Effect.Effect<void>;
};

export type HelperCommand = { command: string; args: string[] }; // 実行ファイルと、サブコマンドの前に付ける引数

const readText = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) => Stream.mkString(Stream.decodeText(stream));

// ヘルパーを 1 回起動して終わりを待ち、標準出力・標準エラー・終了コードを返す（呼び出し側の Scope の中で動く）。stdin は常に閉じる。
// options.stdout が "ignore" のときは標準出力を読まず、stdout は ""
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

// ヘルパーの標準エラーから失敗の理由を作る。標準エラーが空なら終了コード
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
  // 録画のファイルに記録された作成日時（ISO8601）。記録が無いファイルは null。ヘルパーの `creation-date` を 1 回だけ起動して聞く
  creationDate: (file: string) => Effect.Effect<string | null, HelperCreationDateFailure>;
  // 会議アプリの一覧（ヘルパーの `list` の結果）。失敗は予期しない失敗（defect）
  apps: Effect.Effect<unknown>;
  // ヘルパーを 1 回起動して接続する。args は `run` から始まるヘルパーの引数（--port は付けなくてよい）。
  // 返ったヘルパーは Scope を閉じると止まる。stopRequested が立つと、接続待ちの間でもヘルパーを止める
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

// ヘルパーの list が成り立たなかった（defect として扱う）
class HelperListFailure extends Schema.TaggedError<HelperListFailure>()("HelperListFailure", {
  message: Schema.String,
}) {}

const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

// 空きポートを選ぶ（listen(0) で割り当てを受けてから閉じる）
const freePort = Effect.callback<number, HelperLaunchFailure>((resume) => {
  const fail = (reason: string) => resume(Effect.fail(new HelperLaunchFailure({ stderrTail: [reason] })));
  const probe = createServer();
  let closed = false;
  probe.once("error", (error) => fail(error.message));
  probe.listen(0, "127.0.0.1", () => {
    // 中断で閉じた後に割り当てが届いた場合、待受けを残さない
    if (closed) return probe.close();
    const address = probe.address();
    if (!address || typeof address === "string") return fail("空きポートを取得できません");
    probe.close(() => resume(Effect.succeed(address.port)));
  });
  // 中断されたら探索用の待受けを閉じる
  return Effect.sync(() => {
    closed = true;
    probe.close();
  });
});

const make = Effect.fnUntraced(function* (helper: HelperCommand) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  // ヘルパーの list の失敗は予期しない失敗（500）。HTTP の側が文面を伏せずに返す
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
    const { stdout, stderr, code } = yield* runHelperCommand(spawner, helper, ["check", ...(noScreen ? ["--no-screen"] : [])], { forceKillAfter: HELPER_STOP_TIMEOUT_MS });
    if (code !== 0) return yield* new HelperCheckFailure({ message: `ヘルパーの check が失敗しました: ${stderr.trim() || `終了コード ${code}`}` });
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(noScreen ? HelperCheckNoScreenSchema : HelperCheckSchema))(stdout);
  }, Effect.scoped, Effect.mapError((error) => new HelperCheckFailure({ message: error.message })));

  const creationDate = Effect.fnUntraced(function* (file: string) {
    const { stdout, stderr, code } = yield* runHelperCommand(spawner, helper, ["creation-date", "--file", file], { forceKillAfter: HELPER_STOP_TIMEOUT_MS });
    if (code !== 0) return yield* new HelperCreationDateFailure({ message: `ヘルパーの creation-date が失敗しました: ${stderr.trim() || `終了コード ${code}`}` });
    const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(HelperCreationDateSchema))(stdout);
    return decoded.creationDate;
  }, Effect.scoped, Effect.mapError((error) => new HelperCreationDateFailure({ message: error.message })));

  const installSpeechJa = Stream.unwrap(Effect.gen(function* () {
    const handle = yield* spawner.spawn(ChildProcess.make(helper.command, [...helper.args, "install-speech-ja"], {
      stdin: "ignore", stdout: "ignore", forceKillAfter: HELPER_STOP_TIMEOUT_MS,
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
    // この起動回の指示用トークン。環境変数で helper にだけ渡す（引数・ログ・標準エラーには出さない）
    const controlToken = randomBytes(32).toString("hex");
    // 既定の detached: true のまま起動し、プロセスグループごと止める。forceKillAfter は Scope の後始末（kill を通らない）にも効かせる
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(helper.command, [...helper.args, ...args, "--port", String(port)], {
          stdin: "ignore",
          stdout: "ignore",
          env: { [HELPER_CONTROL_TOKEN_ENV]: controlToken },
          extendEnv: true,
          forceKillAfter: HELPER_STOP_TIMEOUT_MS,
        }),
      )
      .pipe(Effect.mapError((error) => new HelperLaunchFailure({ stderrTail: [error.message], exit: { code: null, signal: null } })));

    // 標準エラーはサーバーの標準エラーへ素通ししながら溜める
    const stderrChunks: Uint8Array[] = [];
    const stderrFiber = yield* Effect.forkIn(
      handle.stderr.pipe(
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            process.stderr.write(chunk);
            stderrChunks.push(chunk);
          }),
        ),
        Effect.ignore,
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

    const stop = handle.kill({ forceKillAfter: HELPER_STOP_TIMEOUT_MS }).pipe(Effect.ignore);
    // 「止めて」の印が立ったら、接続待ちの間でも止める。止まれば下の接続待ちは HelperLaunchFailure で終わる
    yield* Effect.forkIn(Effect.andThen(Deferred.await(stopRequested), stop), scope);

    // ヘルパーの準備（モデルやマイクの許可）には時間がかかることがあるので、子プロセスが生きている間は時間切れなしで再試行する
    const connect = openHelperSocket(`ws://127.0.0.1:${port}`).pipe(
      Effect.retry(Schedule.spaced("200 millis")),
      Effect.catchTag("HelperSocketError", (error) => Effect.die(error)),
    );
    const helperEnded = Effect.gen(function* () {
      const exit = yield* Deferred.await(exited);
      return yield* new HelperLaunchFailure({ stderrTail: yield* stderrTail, exit });
    });
    const socket = yield* Effect.raceFirst(connect, helperEnded);
    // server から helper への指示は、type 付きの JSON 1 件（helper/README.md「サーバーからの指示」）。組み立てはここ 1 か所
    const send = (paused: boolean) => socket.send(JSON.stringify({ type: "self-pause", paused, token: controlToken }));

    return { events: socket.events, stop, exit: Deferred.await(exited), stderrTail, send };
  });

  return Helpers.of({ apps, launch, check: check(false), checkNoScreen: check(true), installSpeechJa, creationDate });
});
