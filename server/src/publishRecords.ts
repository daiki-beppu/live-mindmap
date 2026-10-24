import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Config, Effect, FileSystem, Schema } from "effect";
import { PublishRecord } from "./core/index.ts";
import { withFileLock } from "./fileLock.ts";

const homeConfig = Config.String("HOME").pipe(Config.withDefault(homedir()));
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(PublishRecord));

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
    records.push(yield* decodeRecord(line).pipe(Effect.mapError(() => new Error(`公開の記録 ${path} の ${index + 1} 行目が読めません`))));
  }
  return records;
});

export const markRecordStatus = Effect.fnUntraced(function* (names: ReadonlyArray<string>, status: "withdrawn" | "expired") {
  const { path } = yield* recordPaths();
  const fs = yield* FileSystem.FileSystem;
  yield* withFileLock(path, Effect.gen(function* () {
    const text = yield* fs.readFileString(path);
    const rewritten = text.split("\n").map((line) => {
      if (line.trim() === "") return line;
      const raw: unknown = JSON.parse(line);
      if (typeof raw !== "object" || raw === null || !("name" in raw) || typeof raw.name !== "string" || !names.includes(raw.name)) return line;
      if (status === "expired" && !("status" in raw && raw.status === "published")) return line;
      return JSON.stringify({ ...raw, status });
    });
    const temporary = `${path}.${randomUUID()}.tmp`;
    yield* Effect.addFinalizer(() => fs.remove(temporary, { force: true }).pipe(Effect.orDie));
    yield* fs.writeFileString(temporary, rewritten.join("\n"), { mode: 0o600, flag: "wx" });
    yield* fs.rename(temporary, path);
    yield* fs.chmod(path, 0o600);
  }).pipe(Effect.scoped));
});
