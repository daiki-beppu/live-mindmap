// 公開の記録。~/.live-mindmap/publish/records.jsonl に 1 公開 1 行で追記する（利用者だけが読める権限）。
// 読み込みと、取り下げ・期限切れの後片付けでの状態の書き換え（行は消さない）もここだけが持つ
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

// 記録の全行。ファイルが無ければ空。読めない行があれば、何行目かを示して失敗にする
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

// 名前が一致する行の状態を書き換える。expired への書き換えは、今も published の行だけ（別プロセスが取り下げた行を上書きしない）。行は消さず、ほかの項目・行は生の JSON のまま残す（decode し直さない）。
// 途中で落ちても記録が半端に残らないよう、一時ファイルに書いてから置き換える
export const markRecordStatus = Effect.fnUntraced(function* (names: ReadonlyArray<string>, status: "withdrawn" | "expired") {
  const { path } = yield* recordPaths();
  const fs = yield* FileSystem.FileSystem;
  // 読込から置換までの間に別プロセスの追記や取り下げが入ると、その変更が消えるため排他する
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
    // 書込が途中で失敗しても残った一時ファイルを消す
    yield* Effect.addFinalizer(() => fs.remove(temporary, { force: true }).pipe(Effect.orDie));
    yield* fs.writeFileString(temporary, rewritten.join("\n"), { mode: 0o600, flag: "wx" });
    yield* fs.rename(temporary, path);
    yield* fs.chmod(path, 0o600);
  }).pipe(Effect.scoped));
});
