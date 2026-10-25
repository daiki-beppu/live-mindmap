import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Config, Effect, FileSystem, Schema } from "effect";
import { PublishRecord } from "./core/index.ts";
import { withFileLock } from "./fileLock.ts";

const homeConfig = Config.String("HOME").pipe(Config.withDefault(homedir()));
const recordJson = Schema.fromJsonString(PublishRecord);
const decodeRecord = Schema.decodeUnknownEffect(recordJson);
const encodeRecord = Schema.encodeSync(recordJson);

class UnreadablePublishRecord extends Schema.TaggedError<UnreadablePublishRecord>()("UnreadablePublishRecord", {
  path: Schema.String,
  line: Schema.Finite,
}) {
  override get message(): string {
    return `公開の記録 ${this.path} の ${this.line} 行目が読めません`;
  }
}

const decodeLine = (path: string, line: string, index: number) =>
  decodeRecord(line).pipe(Effect.mapError(() => new UnreadablePublishRecord({ path, line: index + 1 })));

const recordPaths = Effect.fnUntraced(function* () {
  const home = yield* homeConfig;
  const directory = join(home, ".live-mindmap", "publish");
  return { directory, path: join(directory, "records.jsonl") };
});

export const appendPublishRecord = Effect.fnUntraced(function* (record: PublishRecord) {
  const { directory, path } = yield* recordPaths();
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* fs.chmod(directory, 0o700);
  yield* withFileLock(path, Effect.gen(function* () {
    yield* fs.writeFileString(path, `${JSON.stringify(record)}\n`, { flag: "a", mode: 0o600 });
    yield* fs.chmod(path, 0o600);
  }));
});

export const readPublishRecords = Effect.fnUntraced(function* () {
  const { path } = yield* recordPaths();
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(path))) return [] as PublishRecord[];
  const text = yield* fs.readFileString(path);
  const records: PublishRecord[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "") continue;
    records.push(yield* decodeLine(path, line, index));
  }
  return records;
});

export const markRecordStatus = Effect.fnUntraced(function* (names: ReadonlyArray<string>, status: "withdrawn" | "expired") {
  const { path } = yield* recordPaths();
  const fs = yield* FileSystem.FileSystem;
  yield* withFileLock(path, Effect.gen(function* () {
    const text = yield* fs.readFileString(path);
    const rewritten = yield* Effect.forEach(text.split("\n"), (line, index) => line.trim() === "" ? Effect.succeed(line) : decodeLine(path, line, index).pipe(Effect.map((record) =>
      names.includes(record.name) && (status !== "expired" || record.status === "published") ? encodeRecord({ ...record, status }) : line)));
    const temporary = `${path}.${randomUUID()}.tmp`;
    yield* Effect.addFinalizer(() => fs.remove(temporary, { force: true }).pipe(Effect.orDie));
    yield* fs.writeFileString(temporary, rewritten.join("\n"), { mode: 0o600, flag: "wx" });
    yield* fs.rename(temporary, path);
    yield* fs.chmod(path, 0o600);
  }).pipe(Effect.scoped));
});
