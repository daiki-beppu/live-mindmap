// 全セッションをまたぐ語彙の溜まり（Issue #645）のファイル。セッションの置き場（LIVE_MINDMAP_SESSIONS）の直下に 1 つ置く。
// 出入りの規則は core/vocabularyPool.ts。ここはファイルの読み書きだけを持つ。
// 溜まりが読めない・書けないときは、警告を 1 行出してその回は溜まりを使わない（開始・終了・restore は止めない）。
import { Console, Effect, FileSystem, Schema, Stream } from "effect";
import { join } from "node:path";
import { beginPoolSession, emptyPool, finishPoolSession, sessionVocabularyUsage, VocabularyPool, type PoolWord } from "./core/index.ts";
import { LOG_FILE } from "./sessionFiles.ts";
import { errorMessage } from "./truthFile.ts";

export const POOL_FILE = "vocabulary.json";
export const vocabularyPoolPath = (sessionsDir: string): string => join(sessionsDir, POOL_FILE);

const decodePool = Schema.decodeUnknownEffect(Schema.fromJsonString(VocabularyPool));

const warn = (reason: unknown) => Console.error(`語彙の溜まりを使えません（${POOL_FILE}）: ${errorMessage(reason)}`);

// 無ければ空の溜まり。読めない・壊れているときは失敗
const readPool = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(path))) return emptyPool;
  return yield* decodePool(yield* fs.readFileString(path));
});

// 途中で落ちても JSON が半端に残らないよう、一時ファイルに書いてから置き換える
const writePool = Effect.fnUntraced(function* (path: string, pool: VocabularyPool) {
  const fs = yield* FileSystem.FileSystem;
  const temporary = `${path}.tmp`;
  yield* fs.writeFileString(temporary, JSON.stringify(pool));
  yield* fs.rename(temporary, path);
});

// セッションの開始: 始めたセッションの数を 1 つ進めて書き、このセッションの番号と引き継ぐ語を返す。使えないときは警告を出して undefined
export const startPoolSession = (sessionsDir: string): Effect.Effect<{ session: number; words: ReadonlyArray<PoolWord> } | undefined, never, FileSystem.FileSystem> => {
  const path = vocabularyPoolPath(sessionsDir);
  return Effect.gen(function* () {
    const begun = beginPoolSession(yield* readPool(path));
    yield* writePool(path, begun.pool);
    return { session: begun.session, words: begun.words };
  }).pipe(Effect.catch((error) => Effect.as(warn(error), undefined)));
};

// セッションの終了と cli restore: ログから導いた使われ方で溜まりを更新する。ログに番号の行が無ければ何もしない
const updatePool = <E>(sessionsDir: string, events: Stream.Stream<unknown, E>): Effect.Effect<void, never, FileSystem.FileSystem> => {
  const path = vocabularyPoolPath(sessionsDir);
  return Effect.gen(function* () {
    const usage = yield* sessionVocabularyUsage(events);
    if (usage === undefined) return;
    yield* writePool(path, finishPoolSession(yield* readPool(path), usage));
  }).pipe(Effect.catch((error) => warn(error)));
};

export const updatePoolFromLog = (sessionsDir: string, events: ReadonlyArray<unknown>): Effect.Effect<void, never, FileSystem.FileSystem> =>
  updatePool(sessionsDir, Stream.fromIterable(events));

const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

// セッションのフォルダの log.jsonl を 1 行ずつ読んで、溜まりを更新する（ファイル全体を一度にメモリへ載せない）。
// ログが無いセッションは番号の行も無いので、何もしない
export const updatePoolFromSession = (dir: string, sessionsDir: string): Effect.Effect<void, never, FileSystem.FileSystem> => {
  const logPath = join(dir, LOG_FILE);
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(logPath))) return;
    const events = fs.stream(logPath).pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.filter((line) => line.trim() !== ""),
      Stream.mapEffect((line) => decodeLine(line)),
    );
    yield* updatePool(sessionsDir, events);
  }).pipe(Effect.catch((error) => warn(error)));
};
