import { Console, Effect, FileSystem, Schema, Stream } from "effect";
import { join } from "node:path";
import { beginPoolSession, emptyPool, finishPoolSession, sessionVocabularyUsage, VocabularyPool } from "./core/index.ts";
import { LOG_FILE } from "./sessionFiles.ts";
import { errorMessage } from "./truthFile.ts";

export const POOL_FILE = "vocabulary.json";
export const vocabularyPoolPath = (sessionsDir: string): string => join(sessionsDir, POOL_FILE);

const decodePool = Schema.decodeUnknownEffect(Schema.fromJsonString(VocabularyPool));

export const poolUnavailableMessage = (reason: unknown): string => `語彙の溜まりを使えません（${POOL_FILE}）: ${errorMessage(reason)}`;
const warn = (reason: unknown) => Console.error(poolUnavailableMessage(reason));

export const readPool = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(path))) return emptyPool;
  return yield* decodePool(yield* fs.readFileString(path));
});

export const writePool = Effect.fnUntraced(function* (path: string, pool: VocabularyPool) {
  const fs = yield* FileSystem.FileSystem;
  const temporary = `${path}.tmp`;
  yield* fs.writeFileString(temporary, JSON.stringify(pool));
  yield* fs.rename(temporary, path);
});

export const startPoolSession = Effect.fnUntraced(function* (sessionsDir: string) {
  const path = vocabularyPoolPath(sessionsDir);
  const begun = beginPoolSession(yield* readPool(path));
  yield* writePool(path, begun.pool);
  return { session: begun.session, words: begun.words };
}, Effect.catch((error) => Effect.as(warn(error), undefined)));

const updatePool = Effect.fnUntraced(function* <E>(sessionsDir: string, events: Stream.Stream<unknown, E>) {
  const path = vocabularyPoolPath(sessionsDir);
  const usage = yield* sessionVocabularyUsage(events);
  if (usage === undefined) return;
  yield* writePool(path, finishPoolSession(yield* readPool(path), usage));
}, Effect.catch((error) => warn(error)));

export const updatePoolFromLog = (sessionsDir: string, events: ReadonlyArray<unknown>): Effect.Effect<void, never, FileSystem.FileSystem> =>
  updatePool(sessionsDir, Stream.fromIterable(events));

const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export const updatePoolFromSession = Effect.fnUntraced(function* (dir: string, sessionsDir: string) {
  const logPath = join(dir, LOG_FILE);
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(logPath))) return;
  const events = fs.stream(logPath).pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.filter((line) => line.trim() !== ""),
    Stream.mapEffect((line) => decodeLine(line)),
  );
  yield* updatePool(sessionsDir, events);
}, Effect.catch((error) => warn(error)));
