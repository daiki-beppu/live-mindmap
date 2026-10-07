import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Console, Deferred, Effect, Fiber, Layer, Predicate, Result } from "effect";
import { CliError } from "effect/cli";
import { afterEach, beforeEach, vi } from "vitest";
import { CaptureFailed, MapCapture } from "../src/capture.ts";
import { runCli } from "../src/cli.ts";
import { REVIEW_LOG_ELEMENT_ID } from "../src/core/index.ts";
import { ReviewBuild, ReviewPageFailed } from "../src/review.ts";
import type { DiffInput, Op, Snapshot } from "../src/core/index.ts";
import { fakeListener } from "./fakeListener.ts";
import { embeddedAudio, fakeAudioMix, FAKE_MIX_BYTES } from "./fixtures/audioMix.ts";

// play の updater（claude.ts）と配信の待受け（http.ts の openListener）を差し替える。待受けは既定で偽物にし、
// 本物の WebSocket 越しに観測する 1 本だけ、実物の openListener に戻す
const external = vi.hoisted(() => ({
  openClaudeUpdater: vi.fn(),
  openListener: vi.fn(),
  realHttp: { current: null as null | typeof import("../src/http.ts") },
}));
vi.mock("../src/claude.ts", async () => (await import("./fixtures/claudeModule.ts")).fakeClaudeModule(() => external.openClaudeUpdater()));
vi.mock("../src/http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/http.ts")>();
  external.realHttp.current = actual;
  return { ...actual, openListener: external.openListener };
});

const fixture = join(import.meta.dirname, "fixtures/short.transcript.json");

const script: Op[][] = [
  [
    { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
    { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: ["r2"] },
  ],
  [{ op: "add", ref: "t3", parent: "n2", kind: "決定", text: "2 回にする", evidence: ["r3"] }],
];

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

// 旧 CliDeps の置き換え。保存先とポートは ConfigProvider、標準出力は Console、撮影は MapCapture の Layer で渡す
function dependencies(sessionsDir: string, port = "0") {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const captures: Snapshot[] = [];
  const captureFailure = { error: null as CaptureFailed | null };
  const reviewFailure = { error: null as ReviewPageFailed | null };
  const mix = fakeAudioMix();
  const consoleService: Console.Console = {
    ...console,
    log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ") + "\n"); },
    error: (...args: unknown[]) => { stderr.push(args.map(String).join(" ") + "\n"); },
  };
  const layer = Layer.mergeAll(
    NodeServices.layer,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({ LIVE_MINDMAP_SESSIONS: sessionsDir, LIVE_MINDMAP_PORT: port })),
    Layer.succeed(Console.Console, consoleService),
    Layer.succeed(MapCapture, MapCapture.of({
      capture: (snapshot: Snapshot, path: string) =>
        captureFailure.error
          ? Effect.fail(captureFailure.error)
          : Effect.sync(() => {
            captures.push(snapshot);
            writeFileSync(path, "");
          }),
    })),
    Layer.succeed(ReviewBuild, ReviewBuild.of({
      build: () => reviewFailure.error ? Effect.fail(reviewFailure.error) : Effect.succeed("<!doctype html><html><body></body></html>"),
    })),
    mix.layer,
  );
  return { layer, stdout, stderr, captures, captureFailure, reviewFailure, mix };
}

// 既定の updater。script を順に返す
function scripted(ops: Op[][] = script) {
  const calls: DiffInput[] = [];
  const close = vi.fn();
  external.openClaudeUpdater.mockReturnValue({
    update: async (input: DiffInput) => {
      calls.push(input);
      return { ops: ops[calls.length - 1] ?? [] };
    },
    close,
  });
  return { calls, close };
}

beforeEach(() => {
  external.openClaudeUpdater.mockReset();
  external.openListener.mockReset();
  scripted();
  external.openListener.mockImplementation(fakeListener().open);
});
afterEach(() => vi.restoreAllMocks());

// play を 1 回流し、セッションのフォルダと出力したパスを返す
const played = (deps: ReturnType<typeof dependencies>) => Effect.gen(function* () {
  yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));
  const paths = deps.stdout.join("").trim().split("\n");
  deps.stdout.length = 0;
  return { paths, session: dirname(paths[0]!) };
});

describe("CLI", () => {
  it.effect("文字起こしを再生すると、export --format json がその時点のマップを標準出力に出す", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const deps = dependencies(dir);
    const { calls } = scripted();

    yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));
    expect(calls.map((c) => c.fresh.map((u) => u.id))).toEqual([["r1", "r2"], ["r3"]]);

    deps.stdout.length = 0;
    yield* runCli(["export", "--format", "json"]).pipe(Effect.provide(deps.layer));
    const exported = JSON.parse(deps.stdout.join(""));
    expect(exported.root).toMatchObject({
      kind: "会議",
      children: [
        {
          kind: "議題",
          text: "採用",
          children: [
            {
              kind: "論点",
              text: "面接は何回か",
              pointStatus: "決定済み",
              children: [
                {
                  kind: "決定",
                  text: "2 回にする",
                  evidence: [{ id: "r3", track: "相手", start: 19.2, end: 28.0, text: "2 回にしましょう" }],
                },
              ],
            },
          ],
        },
      ],
    });
  }));

  it.effect("再生が終わると、ログと同じフォルダに map.md・map.json・map.drawnix・map.png・map.html を書き出し、そのパスを順に出力する", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const deps = dependencies(dir);
    const { paths, session } = yield* played(deps);

    expect(paths).toEqual([join(session, "map.md"), join(session, "map.json"), join(session, "map.drawnix"), join(session, "map.png"), join(session, "map.html")]);
    const files = yield* Effect.tryPromise(() => readdir(session));
    expect(files.sort()).toEqual(expect.arrayContaining(["log.jsonl", "map.md", "map.json", "map.drawnix", "map.png", "map.html"]));
    const md = yield* Effect.tryPromise(() => readFile(join(session, "map.md"), "utf8"));
    expect(md).toContain("# short");
    expect(md).toContain("面接は何回か → 2 回にする");
    const drawnix = JSON.parse(yield* Effect.tryPromise(() => readFile(join(session, "map.drawnix"), "utf8")));
    expect(drawnix).toMatchObject({ type: "drawnix", elements: [{ type: "mindmap" }] });
    // play のセッションには録音が無い。map-audio.html は作らず、mix も呼ばない
    expect(files).not.toContain("map-audio.html");
    expect(deps.mix.calls).toEqual([]);
    expect(deps.stderr.join("")).not.toContain("map-audio");
  }));

  it.effect("map.html には log.jsonl の出来事がそのまま埋め込まれる（偽のビルドのテンプレートに差し込む）", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const deps = dependencies(dir);
    const { session } = yield* played(deps);

    const log = (yield* Effect.tryPromise(() => readFile(join(session, "log.jsonl"), "utf8")))
      .split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
    const html = yield* Effect.tryPromise(() => readFile(join(session, "map.html"), "utf8"));
    const match = new RegExp(`<script type="application/json" id="${REVIEW_LOG_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
    expect(match).not.toBeNull();
    expect(match![1]).not.toContain("<");
    expect(JSON.parse(match![1]!)).toEqual(log);
    expect(log.length).toBeGreaterThan(0);
  }));

  it.effect("再生で map.html のビルドが失敗しても、ほかの 4 つを書き、そのパスを出す。理由は標準エラーに残し、map.html は作らない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const deps = dependencies(dir);
    deps.reviewFailure.error = new ReviewPageFailed({ message: "ビルドに失敗" });

    yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));

    expect(deps.stderr.join("")).toContain("map.html を書き出せませんでした: ビルドに失敗");
    const [session] = yield* Effect.tryPromise(() => readdir(dir));
    const files = yield* Effect.tryPromise(() => readdir(join(dir, session!)));
    expect(files).toEqual(expect.arrayContaining(["map.md", "map.json", "map.drawnix", "map.png"]));
    expect(files).not.toContain("map.html");
    expect(deps.stdout.join("").trim().split("\n").map((l) => basename(l))).toEqual(["map.md", "map.json", "map.drawnix", "map.png"]);
  }));

  it.effect("再生の map.png は、書き出した map.md・map.json と同じ、再生の最後のマップを撮る（1 回だけ取ったスナップショットを渡す）", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const deps = dependencies(dir);
    const { paths } = yield* played(deps);

    expect(deps.captures).toHaveLength(1);
    expect(deps.captures[0]!.nodes.map((x) => x.text)).toEqual(["short", "採用", "面接は何回か", "2 回にする"]);
    expect(deps.captures[0]!.round).toBe(2);
    expect(paths).toHaveLength(5);
  }));

  it.effect("再生で map.png の撮影が失敗しても、画像だけ諦めて、map.html を含む 4 つを書き、そのパスを出す。理由は標準エラーに残す", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const deps = dependencies(dir);
    deps.captureFailure.error = new CaptureFailed({ message: "撮影に失敗" });

    yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));

    expect(deps.stderr.join("")).toContain("map.png を書き出せませんでした: 撮影に失敗");
    const [session] = yield* Effect.tryPromise(() => readdir(dir));
    const files = yield* Effect.tryPromise(() => readdir(join(dir, session!)));
    expect(files).toEqual(expect.arrayContaining(["map.md", "map.json", "map.drawnix", "map.html"]));
    expect(files).not.toContain("map.png");
    expect(deps.stdout.join("").trim().split("\n").map((l) => basename(l))).toEqual(["map.md", "map.json", "map.drawnix", "map.html"]);
  }));

  it.effect("map.json は、直後の export --format json の出力と同じ内容", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const deps = dependencies(dir);
    const { session } = yield* played(deps);

    yield* runCli(["export", "--format", "json"]).pipe(Effect.provide(deps.layer));
    expect(yield* Effect.tryPromise(() => readFile(join(session, "map.json"), "utf8"))).toBe(deps.stdout.join(""));
  }));

  it.effect("形式を指定しない export は Markdown を標準出力に出し、ファイルは作らない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const deps = dependencies(dir);
    const { session } = yield* played(deps);
    const before = (yield* Effect.tryPromise(() => readdir(session))).sort();

    yield* runCli(["export"]).pipe(Effect.provide(deps.layer));
    const md = deps.stdout.join("");
    expect(md.startsWith("# short")).toBe(true);
    expect(md).toContain("面接は何回か → 2 回にする");
    expect((yield* Effect.tryPromise(() => readdir(session))).sort()).toEqual(before);
    expect(md).toBe(yield* Effect.tryPromise(() => readFile(join(session, "map.md"), "utf8")));
  }));

  it.effect("再生の途中でも、export はその時点のマップを標準出力に出し、ファイルは作らない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const deps = dependencies(dir);
    const reachedSecond = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let calls = 0;
    external.openClaudeUpdater.mockReturnValue({
      update: async () => {
        const ops = script[calls++] ?? [];
        if (calls === 2) {
          Deferred.doneUnsafe(reachedSecond, Effect.void);
          await Effect.runPromise(Deferred.await(release)); // 2 回目の更新が終わらない、進行中の状態で止める
        }
        return { ops };
      },
      close: () => {},
    });

    const playing = yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer), Effect.forkChild);
    yield* Deferred.await(reachedSecond);

    const [session] = yield* Effect.tryPromise(() => readdir(dir));
    const sessionDir = join(dir, session!);
    const before = (yield* Effect.tryPromise(() => readdir(sessionDir))).sort();
    expect(before).toEqual(["export.json", "log.jsonl"]);

    yield* runCli(["export"]).pipe(Effect.provide(deps.layer));
    const md = deps.stdout.join("");
    expect(md.startsWith("# short")).toBe(true);
    expect(md).toContain("面接は何回か（未決）");
    expect(md).not.toContain("→ 決定");

    deps.stdout.length = 0;
    yield* runCli(["export", "--format", "json"]).pipe(Effect.provide(deps.layer));
    const exported = JSON.parse(deps.stdout.join(""));
    expect(exported.root.children[0].children[0]).toMatchObject({ kind: "論点", text: "面接は何回か", pointStatus: "未決", children: [] });
    expect((yield* Effect.tryPromise(() => readdir(sessionDir))).sort()).toEqual(before);

    Deferred.doneUnsafe(release, Effect.void);
    yield* Fiber.join(playing);
  }));

  it.effect("--realtime を付けない再生は、仮想時計を進めなくても終わる（待ち時間なし）", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const deps = dependencies(dir);
    // it.effect は TestClock なので、再生が待てばこの Effect は終わらない
    yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));
    expect(deps.captures).toHaveLength(1);
  }));

  describe("play の差分更新（claude.ts）", () => {
    it.effect("再生のために 1 つ開き、1 回の再生の全発言を同じ updater に渡し、再生が終わったら閉じる", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { calls, close } = scripted();

      yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));

      expect(external.openClaudeUpdater).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(2);
      expect(close).toHaveBeenCalledTimes(1);
    }));

    it.effect("再生が失敗しても、開いた updater は閉じる", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { close } = scripted();

      const result = yield* Effect.result(
        runCli(["play", join(dir, "無い.transcript.json")]).pipe(Effect.provide(deps.layer)),
      );

      expect(Result.isFailure(result)).toBe(true);
      expect(close).toHaveBeenCalledTimes(1);
    }));
  });

  describe("restore", () => {
    const adoptionScript: Op[][] = script;

    // sessionsDir に script で 1 セッション再生し、そのフォルダと export の出力を返す
    const playInto = (deps: ReturnType<typeof dependencies>, ops: Op[][]) => Effect.gen(function* () {
      scripted(ops);
      yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));
      const session = dirname(deps.stdout.join("").split("\n")[0]!); // play は書き出したファイルのパスを出す（#41）
      deps.stdout.length = 0;
      yield* runCli(["export", "--format", "json"]).pipe(Effect.provide(deps.layer));
      const before = deps.stdout.join("");
      deps.stdout.length = 0;
      return { session, before };
    });

    it.effect("落ちた後に、ログから差分更新を呼ばずに元と同じマップへ戻し、export で読める", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session, before } = yield* playInto(deps, adoptionScript);
      // 落ちた状態: エクスポートは残っておらず、ログには知らない種類の行がある
      rmSync(join(session, "export.json"));
      appendFileSync(join(session, "log.jsonl"), JSON.stringify({ type: "jev", at: "2026-10-01T00:00:00.000Z" }) + "\n");
      external.openClaudeUpdater.mockReset();

      yield* runCli(["restore"]).pipe(Effect.provide(deps.layer));
      expect(deps.stdout.join("").trim()).toBe(session);
      expect(external.openClaudeUpdater).not.toHaveBeenCalled();

      deps.stdout.length = 0;
      yield* runCli(["export", "--format", "json"]).pipe(Effect.provide(deps.layer));
      expect(deps.stdout.join("")).toBe(before);
    }));

    it.effect("復元してもログを書き足さない", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* playInto(deps, adoptionScript);
      const logBefore = readFileSync(join(session, "log.jsonl"), "utf8");

      yield* runCli(["restore"]).pipe(Effect.provide(deps.layer));
      expect(readFileSync(join(session, "log.jsonl"), "utf8")).toBe(logBefore);
    }));

    it.effect("ログの行が JSON として壊れていれば、タグ付きの失敗にする", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* playInto(deps, adoptionScript);
      const lines = readFileSync(join(session, "log.jsonl"), "utf8").split("\n");
      lines.splice(1, 0, "{壊れた行");
      writeFileSync(join(session, "log.jsonl"), lines.join("\n"));

      const result = yield* Effect.result(runCli(["restore"]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(Predicate.hasProperty(result.failure, "_tag")).toBe(true);
      expect(CliError.isCliError(result.failure)).toBe(false);
      // 行番号付きの日本語 1 行は、入口の表を通す cliProcess.test.ts で観測する
      expect(deps.stdout).toEqual([]);
      expect(deps.stderr).toEqual([]);
    }));

    // JSON としては読めるが、type が remark の項目が壊れた行（InvalidLogEvent）は、空行を除く前の行番号の BrokenLogLine にする
    it.effect("JSON としては正しいが Schema として壊れた行は、空行を含む元の行番号の BrokenLogLine にする。差分更新は開かない", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* playInto(deps, adoptionScript);
      const lines = readFileSync(join(session, "log.jsonl"), "utf8").split("\n");
      lines.splice(1, 0, "", "", JSON.stringify({ type: "remark", at: "2026-10-01T00:00:00.000Z" })); // 空行 2 つの後の 4 行目
      writeFileSync(join(session, "log.jsonl"), lines.join("\n"));
      external.openClaudeUpdater.mockReset();

      const result = yield* Effect.result(runCli(["restore"]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toMatchObject({ _tag: "BrokenLogLine", line: 4 });
      expect(CliError.isCliError(result.failure)).toBe(false);
      expect(external.openClaudeUpdater).not.toHaveBeenCalled();
      expect(deps.stdout).toEqual([]);
    }));

    it.effect("セッションが複数あれば最新のものを復元し、export がその最新のマップを出す", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const first = yield* playInto(deps, adoptionScript);
      const oldDir = join(dir, "2000-01-01T00-00-00.000Z");
      renameSync(first.session, oldDir);
      const second = yield* playInto(deps, [[{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "予算", evidence: ["r1"] }]]);
      expect(second.session).not.toBe(oldDir);
      expect(first.before).not.toBe(second.before);
      rmSync(join(second.session, "export.json"));

      yield* runCli(["restore"]).pipe(Effect.provide(deps.layer));
      expect(deps.stdout.join("").trim()).toBe(second.session);

      deps.stdout.length = 0;
      yield* runCli(["export", "--format", "json"]).pipe(Effect.provide(deps.layer));
      expect(deps.stdout.join("")).toBe(second.before);
    }));

    it.effect("ログのない、より新しいフォルダがあっても、ログのある最新のセッションを復元する", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* playInto(deps, adoptionScript);
      mkdirSync(join(dir, "9999-12-31T00-00-00.000Z"));

      yield* runCli(["restore"]).pipe(Effect.provide(deps.layer));
      expect(deps.stdout.join("").trim()).toBe(session);
    }));

    it.effect("セッションがなければタグ付きの失敗にする", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);

      const result = yield* Effect.result(runCli(["restore"]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(Predicate.hasProperty(result.failure, "_tag")).toBe(true);
      expect(CliError.isCliError(result.failure)).toBe(false);
      // 「セッションがありません: <パス>」の 1 行は cliProcess.test.ts で観測する
      expect(deps.stdout).toEqual([]);
      expect(deps.stderr).toEqual([]);
    }));
  });

  describe("review", () => {
    const embedded = (html: string) => {
      const match = new RegExp(`<script type="application/json" id="${REVIEW_LOG_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
      return match === null ? null : (JSON.parse(match[1]!) as unknown[]);
    };
    const logOf = (session: string) =>
      readFileSync(join(session, "log.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as unknown);
    // フォルダ直下のファイルの中身（map.html 以外）
    const snapshotExceptHtml = (session: string) =>
      Object.fromEntries(readdirSync(session).filter((f) => f !== "map.html").sort().map((f) => [f, readFileSync(join(session, f), "utf8")]));

    it.effect("引数を省略すると、log.jsonl を持つ最新のセッションの map.html を確認なしで上書きし、そのパスだけを 1 行に出す", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* played(deps);
      writeFileSync(join(session, "map.html"), "古い");

      yield* runCli(["review"]).pipe(Effect.provide(deps.layer));

      expect(deps.stdout.join("")).toBe(`${join(session, "map.html")}\n`);
      expect(deps.stderr).toEqual([]);
      const html = readFileSync(join(session, "map.html"), "utf8");
      expect(html).not.toBe("古い");
      expect(embedded(html)).toEqual(logOf(session));
    }));

    it.effect("ログのない、より新しいフォルダがあっても、ログのある最新のセッションを対象にする", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* played(deps);
      rmSync(join(session, "map.html"));
      const empty = join(dir, "9999-12-31T00-00-00.000Z");
      mkdirSync(empty);

      yield* runCli(["review"]).pipe(Effect.provide(deps.layer));

      expect(deps.stdout.join("")).toBe(`${join(session, "map.html")}\n`);
      expect(existsSync(join(session, "map.html"))).toBe(true);
      expect(readdirSync(empty)).toEqual([]);
    }));

    it.effect("相対パスで渡したフォルダも受け、最新ではなくそのフォルダに書き、出力は絶対パスにする", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const first = yield* played(deps);
      const oldDir = join(dir, "2000-01-01T00-00-00.000Z");
      renameSync(first.session, oldDir);
      const second = yield* played(deps);
      expect(second.session).not.toBe(oldDir);
      rmSync(join(oldDir, "map.html"));
      rmSync(join(second.session, "map.html"));

      yield* runCli(["review", relative(process.cwd(), oldDir)]).pipe(Effect.provide(deps.layer));

      expect(deps.stdout.join("")).toBe(`${join(oldDir, "map.html")}\n`);
      expect(existsSync(join(oldDir, "map.html"))).toBe(true);
      expect(existsSync(join(second.session, "map.html"))).toBe(false);
    }));

    it.effect("絶対パスで渡したフォルダも受ける", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* played(deps);
      rmSync(join(session, "map.html"));

      yield* runCli(["review", session]).pipe(Effect.provide(deps.layer));

      expect(deps.stdout.join("")).toBe(`${join(session, "map.html")}\n`);
      expect(existsSync(join(session, "map.html"))).toBe(true);
    }));

    it.effect("map.html 以外（md・json・drawnix・png・export.json・log.jsonl）は書き直さず、ファイルも増やさない。撮影もしない", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* played(deps);
      const capturesBefore = deps.captures.length;
      const before = snapshotExceptHtml(session);
      expect(Object.keys(before)).toEqual(expect.arrayContaining(["export.json", "log.jsonl", "map.md", "map.json", "map.drawnix", "map.png"]));

      yield* runCli(["review"]).pipe(Effect.provide(deps.layer));

      expect(snapshotExceptHtml(session)).toEqual(before);
      expect(deps.captures).toHaveLength(capturesBefore);
    }));

    it.effect("サーバーにつながず、進行中のセッションでも、その時点の log.jsonl をそのまま読んで作る", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* played(deps);
      appendFileSync(join(session, "log.jsonl"), JSON.stringify({ type: "進行中の行", at: "2026-10-01T00:00:00.000Z" }) + "\n");
      external.openListener.mockClear();

      yield* runCli(["review"]).pipe(Effect.provide(deps.layer));

      expect(external.openListener).not.toHaveBeenCalled();
      const events = embedded(readFileSync(join(session, "map.html"), "utf8"));
      expect(events).toEqual(logOf(session));
      expect(events).toContainEqual({ type: "進行中の行", at: "2026-10-01T00:00:00.000Z" });
    }));

    it.effect("ポートの設定を読まない。不正な LIVE_MINDMAP_PORT でも成功し、map.html を書いて絶対パスを出す", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const { session } = yield* played(dependencies(dir));
      rmSync(join(session, "map.html"));
      const deps = dependencies(dir, "ポートではない");

      yield* runCli(["review"]).pipe(Effect.provide(deps.layer));

      expect(deps.stdout.join("")).toBe(`${join(session, "map.html")}\n`);
      expect(embedded(readFileSync(join(session, "map.html"), "utf8"))).toEqual(logOf(session));
    }));

    it.effect("存在しないフォルダは、何も書かず、そのパスを含む CommandFailed で失敗する", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const missing = join(dir, "ない");

      const result = yield* Effect.result(runCli(["review", missing]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toMatchObject({ _tag: "CommandFailed" });
      expect((result.failure as { message: string }).message).toContain(missing);
      expect(deps.stdout).toEqual([]);
      expect(existsSync(missing)).toBe(false);
    }));

    it.effect("log.jsonl が無いフォルダは、何も書かず、そのパスを含む CommandFailed で失敗する", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* played(deps);
      rmSync(join(session, "log.jsonl"));
      rmSync(join(session, "map.html"));

      const result = yield* Effect.result(runCli(["review", session]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toMatchObject({ _tag: "CommandFailed" });
      expect((result.failure as { message: string }).message).toContain(session);
      expect(deps.stdout).toEqual([]);
      expect(existsSync(join(session, "map.html"))).toBe(false);
    }));

    it.effect("ビルドが失敗したら、map.html を書き出せませんでした: <理由> の CommandFailed で失敗し、何も書かない", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* played(deps);
      rmSync(join(session, "map.html"));
      deps.reviewFailure.error = new ReviewPageFailed({ message: "ビルドに失敗" });

      const result = yield* Effect.result(runCli(["review"]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toMatchObject({ _tag: "CommandFailed", message: "map.html を書き出せませんでした: ビルドに失敗" });
      expect(deps.stdout).toEqual([]);
      expect(existsSync(join(session, "map.html"))).toBe(false);
    }));

    it.effect("ログに壊れた行があれば、map.html を書き出せませんでした: で始まる CommandFailed で失敗し、前の map.html を変えない", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const { session } = yield* played(deps);
      writeFileSync(join(session, "map.html"), "前の内容");
      appendFileSync(join(session, "log.jsonl"), "{壊れた行\n");

      const result = yield* Effect.result(runCli(["review"]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toMatchObject({ _tag: "CommandFailed" });
      expect((result.failure as { message: string }).message).toMatch(/^map\.html を書き出せませんでした: /);
      expect(deps.stdout).toEqual([]);
      expect(readFileSync(join(session, "map.html"), "utf8")).toBe("前の内容");
    }));

    describe("録音があるセッション", () => {
      // played のセッションに、録音（中身は何でもよい）を置く
      const withRecordings = (session: string, ...names: string[]) => {
        for (const name of names) writeFileSync(join(session, name), "録音");
      };

      it.effect("map.html、map-audio.html の順に書いてそのパスを出し、mix は セッションのフォルダを読んで一時の出力先に書く。map-audio.html には mix の出力が埋め込まれる", () => Effect.gen(function* () {
        const dir = yield* temporaryDirectory;
        const deps = dependencies(dir);
        const { session } = yield* played(deps);
        withRecordings(session, "相手.m4a", "自分.m4a");

        yield* runCli(["review"]).pipe(Effect.provide(deps.layer));

        expect(deps.stdout.join("")).toBe(`${join(session, "map.html")}\n${join(session, "map-audio.html")}\n`);
        expect(deps.stderr).toEqual([]);
        expect(deps.mix.calls).toHaveLength(1);
        expect(deps.mix.calls[0]!.session).toBe(session);
        expect(dirname(deps.mix.calls[0]!.out)).not.toBe(session); // 既にある出力は上書きされないので、出力はセッションのフォルダに書かない
        const audioHtml = readFileSync(join(session, "map-audio.html"), "utf8");
        expect(embeddedAudio(audioHtml)).toEqual(FAKE_MIX_BYTES);
        expect(embedded(audioHtml)).toEqual(logOf(session)); // ログも同じように埋め込まれている
        const plainHtml = readFileSync(join(session, "map.html"), "utf8");
        expect(embeddedAudio(plainHtml)).toBeNull(); // map.html には音声を入れない
        expect(embedded(plainHtml)).toEqual(logOf(session));
      }));

      it.effect("`自分` だけの録音（自分-2.m4a）でも map-audio.html を書く", () => Effect.gen(function* () {
        const dir = yield* temporaryDirectory;
        const deps = dependencies(dir);
        const { session } = yield* played(deps);
        withRecordings(session, "自分-2.m4a");

        yield* runCli(["review", session]).pipe(Effect.provide(deps.layer));

        expect(deps.stdout.join("")).toBe(`${join(session, "map.html")}\n${join(session, "map-audio.html")}\n`);
        expect(deps.mix.calls).toHaveLength(1);
      }));

      it.effect("前回の map-audio.html があっても上書きして書き直す（mix の出力先はセッションのフォルダではないので、既にあるファイルで失敗しない）", () => Effect.gen(function* () {
        const dir = yield* temporaryDirectory;
        const deps = dependencies(dir);
        const { session } = yield* played(deps);
        withRecordings(session, "相手.m4a");
        writeFileSync(join(session, "map-audio.html"), "古い");

        yield* runCli(["review"]).pipe(Effect.provide(deps.layer));

        expect(embeddedAudio(readFileSync(join(session, "map-audio.html"), "utf8"))).toEqual(FAKE_MIX_BYTES);
        expect(deps.stderr).toEqual([]);
      }));

      it.effect("mix が失敗しても review は成功（終了コード 0）し、map.html だけを書いてそのパスだけを出す。理由は標準エラーに残し、map-audio.html は作らない", () => Effect.gen(function* () {
        const dir = yield* temporaryDirectory;
        const deps = dependencies(dir);
        const { session } = yield* played(deps);
        withRecordings(session, "相手.m4a", "自分.m4a");
        deps.mix.failure.reason = "録音を混ぜられない";

        yield* runCli(["review"]).pipe(Effect.provide(deps.layer));

        expect(deps.stdout.join("")).toBe(`${join(session, "map.html")}\n`);
        expect(deps.stderr.join("")).toContain("map-audio.html を書き出せませんでした: 録音を混ぜられない");
        expect(existsSync(join(session, "map-audio.html"))).toBe(false);
        expect(embedded(readFileSync(join(session, "map.html"), "utf8"))).toEqual(logOf(session));
      }));

      it.effect("mix が失敗した review は、前回の map-audio.html を消さず、書き直しもしない", () => Effect.gen(function* () {
        const dir = yield* temporaryDirectory;
        const deps = dependencies(dir);
        const { session } = yield* played(deps);
        withRecordings(session, "相手.m4a");
        writeFileSync(join(session, "map-audio.html"), "前回");
        deps.mix.failure.reason = "失敗";

        yield* runCli(["review"]).pipe(Effect.provide(deps.layer));

        expect(readFileSync(join(session, "map-audio.html"), "utf8")).toBe("前回");
      }));

      it.effect("ビルドが失敗したら、録音があっても何も書かず、map.html を書き出せませんでした: <理由> の CommandFailed で失敗する（map-audio.html も無い）", () => Effect.gen(function* () {
        const dir = yield* temporaryDirectory;
        const deps = dependencies(dir);
        const { session } = yield* played(deps);
        rmSync(join(session, "map.html"));
        withRecordings(session, "相手.m4a");
        deps.reviewFailure.error = new ReviewPageFailed({ message: "ビルドに失敗" });

        const result = yield* Effect.result(runCli(["review"]).pipe(Effect.provide(deps.layer)));

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isSuccess(result)) return;
        expect(result.failure).toMatchObject({ _tag: "CommandFailed", message: "map.html を書き出せませんでした: ビルドに失敗" });
        expect(deps.stdout).toEqual([]);
        expect(existsSync(join(session, "map.html"))).toBe(false);
        expect(existsSync(join(session, "map-audio.html"))).toBe(false);
      }));

      it.effect("ログに壊れた行があれば、録音があっても失敗し、mix を呼ばず、何も書かない", () => Effect.gen(function* () {
        const dir = yield* temporaryDirectory;
        const deps = dependencies(dir);
        const { session } = yield* played(deps);
        rmSync(join(session, "map.html"));
        withRecordings(session, "相手.m4a");
        appendFileSync(join(session, "log.jsonl"), "{壊れた行\n");

        const result = yield* Effect.result(runCli(["review"]).pipe(Effect.provide(deps.layer)));

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isSuccess(result)) return;
        expect(result.failure).toMatchObject({ _tag: "CommandFailed" });
        expect(deps.stdout).toEqual([]);
        expect(existsSync(join(session, "map.html"))).toBe(false);
        expect(existsSync(join(session, "map-audio.html"))).toBe(false);
      }));
    });

    describe("録音が無いセッション", () => {
      it.effect("map.html だけを書き、mix を呼ばず、標準エラーに map-audio の理由を出さない。録音ではない名前のファイル・サブフォルダの中の m4a は録音と数えない", () => Effect.gen(function* () {
        const dir = yield* temporaryDirectory;
        const deps = dependencies(dir);
        const { session } = yield* played(deps);
        rmSync(join(session, "map.html"));
        writeFileSync(join(session, "メモ.m4a"), "録音ではない名前");
        writeFileSync(join(session, "相手.txt"), "拡張子が違う");
        mkdirSync(join(session, "相手"));
        writeFileSync(join(session, "相手", "x.m4a"), "サブフォルダの中");
        deps.mix.failure.reason = "呼ばれたら理由が出る"; // 呼ばれていれば標準エラーに出る

        yield* runCli(["review"]).pipe(Effect.provide(deps.layer));

        expect(deps.stdout.join("")).toBe(`${join(session, "map.html")}\n`);
        expect(deps.mix.calls).toEqual([]);
        expect(deps.stderr).toEqual([]);
        expect(existsSync(join(session, "map-audio.html"))).toBe(false);
      }));
    });

    it.effect("引数を省略してセッションが 1 つも無ければ、何も書かず、タグ付きの失敗にする", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);

      const result = yield* Effect.result(runCli(["review"]).pipe(Effect.provide(deps.layer)));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toMatchObject({ _tag: "NoSession" });
      expect(deps.stdout).toEqual([]);
      expect(readdirSync(dir)).toEqual([]);
    }));
  });

  describe("ブラウザへの配信", () => {
    // 本物の WebSocket 越しに観測するのは、このファイルで 1 本だけ（正本 22 行）。
    // 「失敗した反映では送らない」「終わると閉じる」は、偽の待受け（fakeListener）で同じ契約を観測する
    it.live("反映のたびに、マップ全体のスナップショットが WebSocket で届く（初期のルート＋反映ごとに 1 つ）。標準出力は変わらない", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const listening = yield* Deferred.make<number>();
      const http = external.realHttp.current!;
      external.openListener.mockImplementation((port: number) =>
        Effect.tap(http.openListener(port), ({ httpServer }) => Deferred.succeed(listening, http.portOf(httpServer.address))));

      const received: Snapshot[] = [];
      let firstReceived: () => void = () => {};
      const first = new Promise<void>((resolve) => (firstReceived = resolve));
      let n = 0;
      external.openClaudeUpdater.mockReturnValue({
        update: async () => {
          await first; // 接続して最初のスナップショットが届くまで、反映を待たせる
          return { ops: script[n++] ?? [] };
        },
        close: () => {},
      });

      const playing = yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer), Effect.forkChild);
      const port = yield* Deferred.await(listening);
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.addEventListener("message", (e) => {
        received.push(JSON.parse(String(e.data)));
        firstReceived();
      });
      yield* Fiber.join(playing);
      yield* Effect.sleep(100); // close 前に送られたものが届くのを待つ
      ws.close();

      expect(received.map((s) => s.nodes.length)).toEqual([1, 3, 4]);
      expect(received[0]!.nodes.map((x) => x.kind)).toEqual(["会議"]);
      const last = received.at(-1)!;
      expect(last.nodes.map((x) => x.text)).toEqual(["short", "採用", "面接は何回か", "2 回にする"]);
      expect(last.nodes.find((x) => x.kind === "論点")).toMatchObject({ pointStatus: "決定済み" });
      // 反映ごとに round が進み、その反映の新しい発言の end の最大値を時刻として、記録が積み上がって届く
      expect(received.map((s) => s.round)).toEqual([0, 1, 2]);
      expect(received[0]!.changes).toEqual([]);
      expect(received[1]!.changes).toEqual([
        { round: 1, at: 19.2, change: "追加", node: "n1", kind: "議題", text: "採用" },
        { round: 1, at: 19.2, change: "追加", node: "n2", kind: "論点", text: "面接は何回か" },
      ]);
      expect(last.changes).toEqual([
        ...received[1]!.changes,
        { round: 2, at: 28, change: "決定済み化", node: "n2", kind: "論点", text: "面接は何回か" },
        { round: 2, at: 28, change: "追加", node: "n3", kind: "決定", text: "2 回にする" },
      ]);
      // 根拠: 届いたスナップショットから、ノードの根拠の ID で発言（時刻・本文）を引ける
      const n1 = last.nodes.find((x) => x.id === "n1")!;
      const r1 = last.remarks.find((r) => r.id === n1.evidence[0])!;
      expect(r1).toMatchObject({ start: 0.5, end: 9.8, text: "今日は採用の進め方を決めます" });
      expect(["自分", "相手"]).toContain(r1.track);
      for (const node of last.nodes) for (const id of node.evidence) expect(last.remarks.some((r) => r.id === id)).toBe(true);
      expect(deps.stdout.join("")).toMatch(/^([^\n]+\n){5}$/); // 書き出した 5 ファイルのパスだけ
    }));

    it.effect("失敗した反映（マップが変わらない）ではスナップショットを送らない", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const fake = fakeListener();
      external.openListener.mockImplementation(fake.open);
      let n = 0;
      external.openClaudeUpdater.mockReturnValue({
        update: async () => {
          if (n++ === 0) throw new Error("失敗");
          return { ops: [] as Op[] };
        },
        close: () => {},
      });

      yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));

      expect(n).toBe(2); // 2 回とも更新へ到達したうえで
      expect(fake.published.map((s) => s.nodes.length)).toEqual([1, 1]); // 初期のルート＋成功した 1 回（変更なし）だけ
    }));

    it.effect("再生が終わると配信を閉じる", () => Effect.gen(function* () {
      const dir = yield* temporaryDirectory;
      const deps = dependencies(dir);
      const fake = fakeListener();
      external.openListener.mockImplementation(fake.open);

      yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));

      expect(fake.published.length).toBeGreaterThan(0); // 配信へ到達したうえで
      // 待受けを 1 回だけ閉じ、その前に最後のスナップショットまで渡し切る
      expect(fake.events).toEqual(["drained", "closed"]);
    }));
  });
});
