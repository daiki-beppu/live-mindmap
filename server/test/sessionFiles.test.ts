import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, PlatformError } from "effect";
import { restoreState, ScreenEvent, StartEvent } from "../src/core/index.ts";
import { isLocal, latestSessionDir, LOG_FILE, readSessionLog, startOf } from "../src/sessionFiles.ts";

const sessionsDir = "/synthetic/sessions";
const dir = join(sessionsDir, "2026-10-24T00-00-00.000Z");
const path = join(dir, LOG_FILE);
const fileSystem = (overrides: Partial<FileSystem.FileSystem>) =>
  Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop(overrides));
const logFile = (text: string) => fileSystem({
  exists: (file) => Effect.succeed(file === path || file === dir),
  readFileString: (file) => file === path
    ? Effect.succeed(text)
    : Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method: "readFileString", pathOrDescriptor: file })),
});

describe("セッションのログの読み込み", () => {
  it.effect("不正 JSON は空行を含む物理行番号とパスを持つ kind: json の失敗になる", () => Effect.gen(function* () {
    const error = yield* Effect.flip(readSessionLog(dir).pipe(Effect.provide(logFile('\n{"type":"start","title":"定例"}\n \t\n{broken\n'))));
    expect(error).toMatchObject({ _tag: "BrokenLogLine", path, line: 4, kind: "json", reason: expect.stringMatching(/\S/) });
  }));

  it.effect("events は空行を除いた JSON 値を順序と追加フィールドを保って未検証で返す", () => Effect.gen(function* () {
    const events = [{ type: "start", title: "定例", at: "保存時刻" }, { type: "diff", input: 5 }, null, [1], "start"];
    const log = yield* readSessionLog(dir).pipe(Effect.provide(logFile(`\n${events.map((event) => JSON.stringify(event)).join("\n\n")}\n`)));
    expect({ dir: log.dir, path: log.path, events: log.events }).toEqual({ dir, path, events });
  }));

  it.effect("選択した種類の不正イベントは空行込みの行番号と kind: event で失敗する", () => Effect.gen(function* () {
    const log = yield* readSessionLog(dir).pipe(Effect.provide(logFile('\n{"type":"start","title":"t"}\n\n{"type":"screen","start":"x","image":null}\n')));
    const error = yield* Effect.flip(log.select([ScreenEvent]));
    expect(error).toMatchObject({ _tag: "BrokenLogLine", path, line: 4, kind: "event", reason: expect.stringMatching(/\S/) });
  }));

  it.effect("選択外の不正イベントとトップレベル文字列以外の type は選ばない", () => Effect.gen(function* () {
    const log = yield* readSessionLog(dir).pipe(Effect.provide(logFile([
      { type: "start", title: "t" },
      { type: "diff", input: 5 },
      { payload: { type: "start" } },
      [{ type: "start" }],
      "start",
      { type: 7 },
      null,
    ].map((event) => JSON.stringify(event)).join("\n"))));
    expect(yield* log.select([StartEvent])).toEqual([{ type: "start", title: "t" }]);
  }));

  it.effect("複数の種類を選択するとログの順序で検証済みイベントを返す", () => Effect.gen(function* () {
    const events = [{ type: "screen", start: 1, image: null }, { type: "start", title: "t" }, { type: "screen", start: 2, image: "s.jpg" }];
    const log = yield* readSessionLog(dir).pipe(Effect.provide(logFile(events.map((event) => JSON.stringify(event)).join("\n"))));
    expect(yield* log.select([StartEvent, ScreenEvent])).toEqual(events);
  }));

  it.effect("log.jsonl が無ければ MissingSessionLog になる", () => Effect.gen(function* () {
    const error = yield* Effect.flip(readSessionLog(dir).pipe(Effect.provide(fileSystem({}))));
    expect(error).toMatchObject({ _tag: "MissingSessionLog" });
  }));

  it.effect("読み取りの権限エラーはログ不在へ変換しない", () => Effect.gen(function* () {
    const denied = PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "readFileString", pathOrDescriptor: path });
    const error = yield* Effect.flip(readSessionLog(dir).pipe(Effect.provide(fileSystem({ exists: () => Effect.succeed(true), readFileString: () => Effect.fail(denied) }))));
    expect(error).toEqual(denied);
  }));

  it.effect("存在確認後にログが無くなっても MissingSessionLog になる", () => Effect.gen(function* () {
    const missing = PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method: "readFileString", pathOrDescriptor: path });
    const error = yield* Effect.flip(readSessionLog(dir).pipe(Effect.provide(fileSystem({
      exists: () => Effect.succeed(true),
      readFileString: () => Effect.fail(missing),
    }))));
    expect(error).toMatchObject({ _tag: "MissingSessionLog", path });
  }));

  it.effect("brokenAt は復元の失敗を元の物理行番号へ戻し理由を保つ", () => Effect.gen(function* () {
    const log = yield* readSessionLog(dir).pipe(Effect.provide(logFile('\n{"type":"start","title":"t"}\n\n{"type":"intake-note"}\n \n{"type":"remark"}\n')));
    const invalid = yield* Effect.flip(restoreState(log.events));
    expect(log.brokenAt(invalid)).toMatchObject({ _tag: "BrokenLogLine", path, line: 6, kind: "event", reason: invalid.reason });
  }));

  it.effect("空ログも読めて、復元の start 欠落は先頭行の診断になる", () => Effect.gen(function* () {
    const log = yield* readSessionLog(dir).pipe(Effect.provide(logFile("\n \t\n")));
    expect(log.events).toEqual([]);
    const invalid = yield* Effect.flip(restoreState(log.events));
    expect(log.brokenAt(invalid)).toMatchObject({ _tag: "BrokenLogLine", path, line: 1, kind: "event", reason: invalid.reason });
  }));
});

describe("最新のセッションのフォルダ", () => {
  it.effect("列挙順によらず指定ファイルを持つ最新のフォルダのパスを返す", () => Effect.gen(function* () {
    const file = "map.html";
    const names = ["2026-10-24", "2026-10-25", "2026-10-23"];
    const present = new Set([sessionsDir, join(sessionsDir, names[0]!, file), join(sessionsDir, names[2]!, file), join(sessionsDir, names[1]!, LOG_FILE)]);
    const latest = yield* latestSessionDir(sessionsDir, file).pipe(Effect.provide(fileSystem({
      exists: (candidate) => Effect.succeed(present.has(candidate)),
      readDirectory: () => Effect.succeed(names),
    })));
    expect(latest).toBe(join(sessionsDir, "2026-10-24"));
  }));

  it.effect("保存先が無ければ sessionsDir を持つ NoSavedSession になる", () => Effect.gen(function* () {
    const error = yield* Effect.flip(latestSessionDir(sessionsDir, LOG_FILE).pipe(Effect.provide(fileSystem({}))));
    expect(error).toMatchObject({ _tag: "NoSavedSession", sessionsDir });
  }));

  it.effect("指定ファイルを持つ候補が無ければ NoSavedSession になる", () => Effect.gen(function* () {
    const error = yield* Effect.flip(latestSessionDir(sessionsDir, LOG_FILE).pipe(Effect.provide(fileSystem({
      exists: (candidate) => Effect.succeed(candidate === sessionsDir),
      readDirectory: () => Effect.succeed(["2026-10-24"]),
    }))));
    expect(error).toMatchObject({ _tag: "NoSavedSession", sessionsDir });
  }));

  it.effect("存在確認後に保存先が無くなっても NoSavedSession になる", () => Effect.gen(function* () {
    const missing = PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method: "readDirectory", pathOrDescriptor: sessionsDir });
    const error = yield* Effect.flip(latestSessionDir(sessionsDir, LOG_FILE).pipe(Effect.provide(fileSystem({
      exists: () => Effect.succeed(true),
      readDirectory: () => Effect.fail(missing),
    }))));
    expect(error).toMatchObject({ _tag: "NoSavedSession", sessionsDir });
  }));

  it.effect.each(["exists", "readDirectory"] as const)("保存先の %s が ENOTDIR なら NoSavedSession になる", (method) => Effect.gen(function* () {
    const notDir = PlatformError.systemError({ _tag: "BadResource", module: "FileSystem", method, pathOrDescriptor: sessionsDir, cause: { code: "ENOTDIR" } });
    const error = yield* Effect.flip(latestSessionDir(sessionsDir, LOG_FILE).pipe(Effect.provide(fileSystem({
      exists: () => method === "exists" ? Effect.fail(notDir) : Effect.succeed(true),
      readDirectory: () => Effect.fail(notDir),
    }))));
    expect(error).toMatchObject({ _tag: "NoSavedSession", sessionsDir });
  }));

  it.effect("候補が通常ファイルでも ENOTDIR を無視して有効なフォルダを返す", () => Effect.gen(function* () {
    const notDir = PlatformError.systemError({ _tag: "BadResource", module: "FileSystem", method: "exists", cause: { code: "ENOTDIR" } });
    const latest = yield* latestSessionDir(sessionsDir, LOG_FILE).pipe(Effect.provide(fileSystem({
      exists: (candidate) => candidate === join(sessionsDir, "9999-file", LOG_FILE) ? Effect.fail(notDir) : Effect.succeed(true),
      readDirectory: () => Effect.succeed(["9999-file", "2026-10-24"]),
    })));
    expect(latest).toBe(join(sessionsDir, "2026-10-24"));
  }));

  it.effect.each(["exists", "readDirectory"] as const)("保存先の %s の権限エラーは NoSavedSession に変換しない", (method) => Effect.gen(function* () {
    const denied = PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method, pathOrDescriptor: sessionsDir });
    const error = yield* Effect.flip(latestSessionDir(sessionsDir, LOG_FILE).pipe(Effect.provide(fileSystem({
      exists: () => method === "exists" ? Effect.fail(denied) : Effect.succeed(true),
      readDirectory: () => Effect.fail(denied),
    }))));
    expect(error).toEqual(denied);
  }));
});

describe("開始イベントとローカルモード", () => {
  it.effect("startOf は選択外の壊れた diff を無視して開始イベントを返す", () => Effect.gen(function* () {
    const log = yield* readSessionLog(dir).pipe(Effect.provide(logFile('{"type":"diff","input":5}\n{"type":"start","title":"定例"}\n')));
    expect(yield* startOf(log)).toEqual({ type: "start", title: "定例" });
  }));

  it.effect("startOf は開始イベントが無ければ MissingStartLine になる", () => Effect.gen(function* () {
    const log = yield* readSessionLog(dir).pipe(Effect.provide(logFile('{"type":"diff","input":5}\n')));
    expect(yield* Effect.flip(startOf(log))).toMatchObject({ _tag: "MissingStartLine" });
  }));

  it.effect("startOf は不正な開始イベントを MissingStartLine にせず元の行で失敗する", () => Effect.gen(function* () {
    const log = yield* readSessionLog(dir).pipe(Effect.provide(logFile('\n{"type":"start","title":5}\n')));
    expect(yield* Effect.flip(startOf(log))).toMatchObject({ _tag: "BrokenLogLine", path, line: 2, kind: "event", reason: expect.stringMatching(/\S/) });
  }));

  it.effect.each([
    { name: "local が true", start: { type: "start", title: "t", model: { name: "m", route: "apple", local: true } }, local: true },
    { name: "local が false", start: { type: "start", title: "t", model: { name: "m", route: "claude", local: false } }, local: false },
    { name: "model がない", start: { type: "start", title: "t" }, local: false },
    { name: "start が不正", start: { type: "start", title: 5, model: { name: "m", route: "apple", local: true } }, local: false },
    { name: "local が未指定", start: { type: "start", title: "t", model: { name: "m", route: "apple" } }, local: false },
  ])("isLocal は $name のとき $local を返す", ({ start, local }) => Effect.gen(function* () {
    const log = yield* readSessionLog(dir).pipe(Effect.provide(logFile(`${JSON.stringify(start)}\n{"type":"diff","input":5}\n`)));
    expect(isLocal(log)).toBe(local);
  }));

  it.effect("isLocal は開始イベントが無ければ false を返す", () => Effect.gen(function* () {
    const log = yield* readSessionLog(dir).pipe(Effect.provide(logFile('{"type":"diff","input":5}\n')));
    expect(isLocal(log)).toBe(false);
  }));

  it.effect("isLocal は後続の start で最初の不正な start を置き換えない", () => Effect.gen(function* () {
    const log = yield* readSessionLog(dir).pipe(Effect.provide(logFile('{"type":"start","title":5}\n{"type":"start","title":"t","model":{"name":"m","route":"apple","local":true}}\n')));
    expect(isLocal(log)).toBe(false);
  }));
});
