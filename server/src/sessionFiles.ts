import { basename, join } from "node:path";
import { Cause, Console, DateTime, Effect, FileSystem, Layer, PlatformError, Predicate, Ref, Result, Schema, Semaphore } from "effect";
import { MapCapture } from "./capture.ts";
import { ReviewPageFailed, writeReviewPages, type ReviewVariant } from "./review.ts";
import {
  DiffUpdater,
  exportFiles,
  LogEvent,
  logTimestamp,
  makeSession,
  makeTranscriptSession,
  SessionLog,
  speakerNamesFrame,
  StartEvent,
  toJsonExport,
  type IntakeLogEvent,
  type SelfPauseLogEvent,
  type SpeakerNameLogEvent,
  type InvalidLogEvent,
  type OnSpeakerNames,
  type Session,
  type Snapshot,
} from "./core/index.ts";
import { errorMessage, formatIssues, oneLine } from "./truthFile.ts";
import type { ExecutableModel } from "./modelSelection.ts";
import type { SendFrame } from "./viewers.ts";

export const EXPORT_FILE = "export.json";
export const LOG_FILE = "log.jsonl";
export const SCREENS_DIR = "screens";

export class NoSavedSession extends Schema.TaggedError<NoSavedSession>()("NoSavedSession", { sessionsDir: Schema.String }) {}
export class MissingSessionLog extends Schema.TaggedError<MissingSessionLog>()("MissingSessionLog", { path: Schema.String }) {}
export class MissingStartLine extends Schema.TaggedError<MissingStartLine>()("MissingStartLine", { path: Schema.String }) {}
export class BrokenLogLine extends Schema.TaggedError<BrokenLogLine>()("BrokenLogLine", {
  path: Schema.String,
  line: Schema.Finite,
  kind: Schema.Literals(["json", "event"]),
  reason: Schema.String,
}) {}

const isNotDirectory = (error: PlatformError.PlatformError): boolean =>
  Predicate.hasProperty(error.cause, "code") && error.cause.code === "ENOTDIR";

const pathExists = (fs: FileSystem.FileSystem, path: string) =>
  fs.exists(path).pipe(Effect.catchIf(isNotDirectory, () => Effect.succeed(false)));

export const latestSessionDir = Effect.fn("latestSessionDir")(function* (sessionsDir: string, file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* pathExists(fs, sessionsDir))) return yield* new NoSavedSession({ sessionsDir });
  const names = yield* fs.readDirectory(sessionsDir).pipe(
    Effect.catchIf((error) => error.reason._tag === "NotFound" || isNotDirectory(error), () => Effect.fail(new NoSavedSession({ sessionsDir }))),
  );
  const latest = (yield* Effect.filter(names, (name) => pathExists(fs, join(sessionsDir, name, file)))).sort().at(-1);
  return latest === undefined ? yield* new NoSavedSession({ sessionsDir }) : join(sessionsDir, latest);
});

const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeEvent = Schema.decodeUnknownEffect(LogEvent);
const schemaReason = (error: Schema.SchemaError): string =>
  oneLine(formatIssues(error.issue).issues.map(({ message }) => message).join(" / "));

export const readLogLines = Effect.fn("readLogLines")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path);
  const lines = text.split("\n")
    .map((line, i) => ({ text: line, no: i + 1 }))
    .filter((line) => line.text.trim() !== "");
  const events: unknown[] = [];
  for (const line of lines) {
    events.push(yield* decodeLine(line.text).pipe(
      Effect.mapError((error) => new BrokenLogLine({ path, line: line.no, kind: "json", reason: schemaReason(error) })),
    ));
  }
  return { lines, events };
});

export type SessionLogRead = {
  readonly dir: string;
  readonly path: string;
  readonly events: ReadonlyArray<unknown>;
  readonly select: (schemas: ReadonlyArray<(typeof LogEvent.members)[number]>) => Effect.Effect<LogEvent[], BrokenLogLine>;
  readonly brokenAt: (error: InvalidLogEvent) => BrokenLogLine;
};

const isStart = Schema.is(Schema.Struct({ type: StartEvent.fields.type }));

export const readSessionLog = Effect.fn("readSessionLog")(function* (dir: string): Effect.fn.Return<SessionLogRead, MissingSessionLog | BrokenLogLine | PlatformError.PlatformError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const path = join(dir, LOG_FILE);
  if (!(yield* pathExists(fs, path))) return yield* new MissingSessionLog({ path });
  const { lines, events } = yield* readLogLines(path).pipe(
    Effect.catchIf(
      (error) => PlatformError.isPlatformError(error) && error.reason._tag === "NotFound",
      () => Effect.fail(new MissingSessionLog({ path })),
    ),
  );
  const eventFailure = (index: number, reason: string) => new BrokenLogLine({
    path,
    line: lines.length === 0 ? 1 : lines[index]!.no,
    kind: "event",
    reason,
  });
  const select = Effect.fnUntraced(function* (schemas: ReadonlyArray<(typeof LogEvent.members)[number]>) {
    const selected = Schema.is(Schema.Struct({ type: Schema.Literals(schemas.map((schema) => schema.fields.type.literal)) }));
    const decoded: LogEvent[] = [];
    for (const [index, event] of events.entries()) {
      if (!selected(event)) continue;
      decoded.push(yield* decodeEvent(event).pipe(
        Effect.mapError((error) => eventFailure(index, schemaReason(error))),
      ));
    }
    return decoded;
  });
  return { dir, path, events, select, brokenAt: (error) => eventFailure(error.index, error.reason) };
});

export const startOf = Effect.fn("startOf")(function* (log: SessionLogRead) {
  const start = (yield* log.select([StartEvent])).find((event) => event.type === "start");
  return start === undefined ? yield* new MissingStartLine({ path: log.path }) : start;
});

export const isLocal = (log: SessionLogRead): boolean => {
  const start = log.events.find(isStart);
  if (start === undefined) return false;
  const decoded = Schema.decodeUnknownResult(StartEvent)(start);
  return Result.isSuccess(decoded) && decoded.success.model?.local === true;
};

export const writeExportFiles = Effect.fnUntraced(function* (dir: string, snapshot: Snapshot, names: ReadonlyMap<string, string>) {
  const fs = yield* FileSystem.FileSystem;
  const paths: string[] = [];
  for (const [name, content] of Object.entries(exportFiles(toJsonExport(snapshot, snapshot.remarks, names)))) {
    const path = join(dir, name);
    yield* fs.writeFileString(path, content.endsWith("\n") ? content : content + "\n");
    paths.push(path);
  }
  return paths;
});

export const captureWarning = (reason: string) => `map.png を書き出せませんでした: ${reason}`;
export const reviewWarning = (file: string, reason: string) => `${file} を書き出せませんでした: ${reason}`;

const RECORDING_PATTERN = /^(相手|自分).*\.m4a$/;
const SELF_RECORDING_PATTERN = /^自分.*\.m4a$/;

// FileSystem に lstat が無く stat はリンクを辿るため、readLink が成功するか（= リンクか）で見分ける
const hasRecording = Effect.fnUntraced(function* (dir: string, pattern: RegExp) {
  const fs = yield* FileSystem.FileSystem;
  for (const name of yield* fs.readDirectory(dir)) {
    if (!pattern.test(name)) continue;
    const path = join(dir, name);
    if (yield* fs.readLink(path).pipe(Effect.as(true), Effect.orElseSucceed(() => false))) continue;
    if ((yield* fs.stat(path)).type === "File") return true;
  }
  return false;
});

export const selfReviewVariants = Effect.fnUntraced(function* (dir: string) {
  const variants: readonly ReviewVariant[] = (yield* hasRecording(dir, SELF_RECORDING_PATTERN))
    ? [{ file: "map-audio-自分.html", audio: true, track: "自分" }]
    : [];
  return variants;
});

export const reviewVariants = Effect.fnUntraced(function* (dir: string) {
  const variants: readonly ReviewVariant[] = (yield* hasRecording(dir, RECORDING_PATTERN))
    ? [{ file: "map.html", audio: false }, { file: "map-audio.html", audio: true }]
    : [{ file: "map.html", audio: false }];
  return variants;
});

export class ExportFilesFailed extends Schema.TaggedError<ExportFilesFailed>()("ExportFilesFailed", { message: Schema.String }) {}

export const writeReviews = Effect.fnUntraced(function* (dir: string) {
  const variants = yield* reviewVariants(dir).pipe(Effect.mapError((e) => new ReviewPageFailed({ message: errorMessage(e) })));
  const logPath = join(dir, LOG_FILE);
  const { events } = yield* readLogLines(logPath).pipe(
    Effect.mapError((e) => new ReviewPageFailed({
      message: e._tag === "BrokenLogLine" ? `${logPath} の ${e.line} 行目が JSON として読めません: ${e.reason}` : errorMessage(e),
    })),
  );
  return yield* writeReviewPages(dir, events, variants);
});

export const writeExportsAndCapture = Effect.fnUntraced(function* (dir: string, snapshot: Snapshot, formatReason: (e: unknown) => string, names: ReadonlyMap<string, string>) {
  const paths = yield* writeExportFiles(dir, snapshot, names).pipe(Effect.mapError((e) => new ExportFilesFailed({ message: formatReason(e) })));
  const orWarn = <A, E, R>(effect: Effect.Effect<A, E, R>, warning: (reason: string) => string) =>
    Effect.catchCauseIf(
      effect,
      (cause) => !Cause.hasInterrupts(cause),
      (cause) => Effect.as(Console.error(warning(formatReason(Cause.squash(cause)))), undefined),
    );
  const png = join(dir, "map.png");
  const captured = yield* orWarn(
    Effect.as(Effect.flatMap(MapCapture, (service) => service.capture(snapshot, png)), true),
    captureWarning,
  );
  if (captured) paths.push(png);
  const reviewed = yield* orWarn(writeReviews(dir), (reason) => reviewWarning("map.html", reason));
  if (reviewed) {
    paths.push(...reviewed.paths);
    for (const { file, reason } of reviewed.skipped) yield* Console.error(reviewWarning(file, reason));
  }
  return paths;
});

export const createSessionDir = Effect.fnUntraced(function* (sessionsDir: string, at?: DateTime.DateTime) {
  const fs = yield* FileSystem.FileSystem;
  const base = join(sessionsDir, DateTime.formatIso(at ?? DateTime.nowUnsafe()).replaceAll(":", "-"));
  yield* fs.makeDirectory(sessionsDir, { recursive: true });
  for (let n = 1; ; n++) {
    const dir = n === 1 ? base : `${base}-${n}`;
    const created = yield* fs.makeDirectory(dir).pipe(
      Effect.as(true),
      Effect.catchIf((e) => e.reason._tag === "AlreadyExists", () => Effect.succeed(false)),
    );
    if (created) return dir;
  }
});

export type LoggedSessionOptions = {
  model: ExecutableModel;
  dir: string;
  title?: string;
  logShiftMs?: number;
  send?: SendFrame;
  onDiff?: Effect.Effect<void>;
  onSpeakerNames?: OnSpeakerNames;
};

const openLogged = Effect.fnUntraced(function* ({ dir, title, logShiftMs = 0, send, onDiff, onSpeakerNames, model }: Omit<LoggedSessionOptions, "model"> & { model: ExecutableModel | undefined }, updater: DiffUpdater["Service"] | undefined) {
  const fs = yield* FileSystem.FileSystem;
  const writeLogLine = (event: LogEvent | IntakeLogEvent | SelfPauseLogEvent | SpeakerNameLogEvent) =>
    Effect.suspend(() =>
      fs.writeFileString(join(dir, LOG_FILE), JSON.stringify({ at: logTimestamp(logShiftMs), ...event }) + "\n", { flag: "a" }),
    ).pipe(Effect.orDie);
  const writeExport = (session: Session) =>
    Effect.flatMap(session.exportJson, (json) => fs.writeFileString(join(dir, EXPORT_FILE), JSON.stringify(json))).pipe(Effect.orDie);
  const lock = yield* Semaphore.make(1);
  const serialized = <A>(effect: Effect.Effect<A>) => lock.withPermit(Effect.uninterruptible(effect));
  const current = yield* Ref.make<Session | undefined>(undefined);
  const log = Layer.succeed(SessionLog)(
    SessionLog.of({
      write: (event) =>
        Effect.gen(function* () {
          const session = yield* serialized(
            Effect.gen(function* () {
              yield* writeLogLine(event.type === "start" && model !== undefined ? { ...event, model: { name: model.name, route: model.route, local: model.local } } : event);
              const session = yield* Ref.get(current);
              if (session) yield* writeExport(session);
              return session;
            }),
          );
          if (!session) return;
          if (send && (event.type === "diff" || event.type === "diff-update-paused" || event.type === "diff-update-state")) {
            yield* send({ type: "diff-update", state: yield* session.diffUpdate });
          }
          if (event.type !== "diff") return;
          if (!event.error && send) yield* Effect.flatMap(session.snapshot, (snapshot) => send({ type: "snapshot", snapshot }));
          if (onDiff) yield* onDiff;
        }),
      writeScreen: (file, bytes) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(join(dir, SCREENS_DIR), { recursive: true });
          yield* fs.writeFile(join(dir, SCREENS_DIR, file), bytes);
        }).pipe(Effect.orDie),
      readScreen: (file) => fs.readFile(join(dir, SCREENS_DIR, file)).pipe(Effect.orDie),
    }),
  );
  const images = model === undefined || (model.route !== "apple" && model.images !== false);
  const options = { title: title ?? basename(dir), images, logShiftMs, ...(onSpeakerNames ? { onSpeakerNames } : {}) };
  const session = yield* (updater === undefined ? makeTranscriptSession(options) : makeSession(options).pipe(Effect.provideService(DiffUpdater, updater))).pipe(Effect.provide(log));
  yield* Ref.set(current, session);
  if (send) {
    yield* send(speakerNamesFrame(new Map()));
    yield* send({ type: "diff-update", state: yield* session.diffUpdate });
  }
  yield* serialized(writeExport(session));
  if (send) yield* Effect.flatMap(session.snapshot, (snapshot) => send({ type: "snapshot", snapshot }));
  return { session, appendLog: (event: LogEvent | IntakeLogEvent | SelfPauseLogEvent | SpeakerNameLogEvent) => serialized(writeLogLine(event)) };
});

export const openLoggedSession = Effect.fnUntraced(function* (options: LoggedSessionOptions) {
  return yield* openLogged(options, yield* DiffUpdater);
});

export const openLoggedTranscriptSession = (options: Omit<LoggedSessionOptions, "model">) => openLogged({ ...options, model: undefined }, undefined);
