import { unusedApple } from "./fixtures/appleIntelligence.ts";
import { readyManagedDeps } from "./fixtures/readyManagedDeps.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Clock, ConfigProvider, Console, Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { beforeEach, vi } from "vitest";
import { MapCapture } from "../src/capture.ts";
import { runCli } from "../src/cli.ts";
import { ReviewBuild } from "../src/review.ts";
import { fakeListener } from "./fakeListener.ts";
import { fakeAudioMix } from "./fixtures/audioMix.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";
import { fakeReadings } from "./fixtures/readings.ts";

// play <セッションのフォルダ> を、CLI の入口から偽の Agent SDK の query まで通して確かめる（試すシームは CLI の play + 偽の query）。
// 組み方は playScreen.it.test.ts と同じ: 本物の layerClaude を残し、AgentSdk.layer だけを偽物に替える。
// 共有画面の画像の変換（PNG → JPEG）は Service ScreenJpeg の偽物。

type Block = { type: string; text?: string; source?: { type: string; media_type: string; data: string } };
type SentMessage = { type: string; message: { role: string; content: string | Block[] } };
type Created = { messages: SentMessage[]; options: { systemPrompt: string } };

const external = vi.hoisted(() => ({
  created: [] as Created[],
  openListener: vi.fn(),
}));

vi.mock("../src/claude.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/claude.ts")>();
  const { Layer: L } = await import("effect");
  // prompt から user メッセージを 1 つ読むたびに、noop の結果を 1 つ返す
  const query = ((params: { prompt: AsyncIterable<SentMessage>; options: Created["options"] }) => {
    const record: Created = { messages: [], options: params.options };
    external.created.push(record);
    const gen = (async function* () {
      for await (const message of params.prompt) {
        record.messages.push(message);
        yield { type: "assistant", message: { model: "fake-model", usage: { input_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens: 0 } } };
        yield { type: "result", subtype: "success", structured_output: { ops: [{ op: "noop", reason: "テスト" }] } };
      }
    })();
    return Object.assign(gen, { close: () => {} });
  }) as unknown as import("../src/claude.ts").AgentSdk["Service"]["query"];
  class AgentSdk extends actual.AgentSdk {
    static override readonly layer = L.succeed(actual.AgentSdk, actual.AgentSdk.of({ query }));
  }
  return { ...actual, AgentSdk };
});
vi.mock("../src/http.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/http.ts")>();
  return { ...actual, openListener: external.openListener };
});

beforeEach(() => {
  external.created.length = 0;
  external.openListener.mockReset();
  external.openListener.mockImplementation(fakeListener().open);
});

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-play-session-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

type Line = Record<string, unknown> & { type: string };

function dependencies(sessionsDir: string) {
  const stdout: string[] = [];
  const convert = fakeScreenJpeg();
  const consoleService: Console.Console = {
    ...console,
    log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ") + "\n"); },
    error: () => {},
  };
  const layer = Layer.mergeAll(
    NodeServices.layer, unusedApple, readyManagedDeps,
    NodeHttpClient.layerUndici,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: join(sessionsDir, "home"), LIVE_MINDMAP_CONFIG: join(sessionsDir, "absent.config.json"), LIVE_MINDMAP_SESSIONS: sessionsDir, LIVE_MINDMAP_PORT: "0" })),
    Layer.succeed(Console.Console, consoleService),
    Layer.succeed(MapCapture, MapCapture.of({ capture: (_s, path) => Effect.sync(() => writeFileSync(path, "")) })),
    Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.succeed("<!doctype html><html><body></body></html>") })),
    fakeAudioMix().layer,
    convert.layer,
  );
  return { layer, stdout, convert };
}

// play を 1 回流し、新しいセッションのフォルダを返す（標準出力の 1 行目のパスの親）
const played = (deps: ReturnType<typeof dependencies>, args: string[]) =>
  Effect.gen(function* () {
    yield* runCli(["play", ...args]).pipe(Effect.provide(deps.layer));
    return dirname(deps.stdout.join("").trim().split("\n")[0]!);
  });

const failure = (deps: ReturnType<typeof dependencies>, args: string[]) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(runCli(["play", ...args]).pipe(Effect.provide(deps.layer)));
    expect(result._tag).toBe("Failure"); // 失敗の形を見る前に、失敗したことを確かめる
    return result._tag === "Failure" ? (result.failure as { _tag: string; line?: number; message?: string }) : undefined;
  });

const parseLog = (text: string): Line[] => text.trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Line);
const logLines = (session: string) => parseLog(readFileSync(join(session, "log.jsonl"), "utf8"));
const diffInputs = (lines: Line[]) => lines.filter((l) => l.type === "diff").map((l) => l.input as Record<string, unknown>);
const sessionFolders = (sessionsDir: string) => (existsSync(sessionsDir) ? readdirSync(sessionsDir) : []);

// 元のセッションのフォルダ（log.jsonl と screens/）を手で作る。画像ファイルの中身は渡した文字列
function sessionFolder(root: string, lines: Record<string, unknown>[], images: Record<string, string> = {}) {
  const dir = join(root, "original");
  mkdirSync(join(dir, "screens"), { recursive: true });
  writeFileSync(
    join(dir, "log.jsonl"),
    lines.map((l, i) => JSON.stringify({ at: `2026-10-01T00:00:${String(i).padStart(2, "0")}.000Z`, ...l })).join("\n") + "\n",
  );
  for (const [name, content] of Object.entries(images)) writeFileSync(join(dir, "screens", name), content);
  return dir;
}

const remarkLine = (id: string, start: number, end: number, text = `発言${id}`) => ({
  type: "remark",
  remark: { id, track: "相手", start, end, text },
});

// 文字起こしの発言（kanary transcribe の JSON の segments）
const segments = (list: [start: number, end: number, text: string][]) =>
  JSON.stringify({
    schema_version: 1,
    duration: 60,
    source_path: "meeting.m4a",
    transcript: {
      tracks: ["speaker"],
      diagnostics: {},
      segments: list.map(([start, end, text]) => ({ track: "speaker", start_seconds: start, end_seconds: end, text, confidence: 0.9 })),
    },
  });

// 素材を置いた「会議のフォルダ」を作る。slides.tsv は 1 行目が見出し。画像ファイルの中身は "png:<相対パス>"
function meeting(root: string, transcript: string, rows: [start: number, end: number, slide: string, image: string][]) {
  const folder = join(root, "meeting");
  mkdirSync(join(folder, "slides"), { recursive: true });
  const transcriptPath = join(folder, "meeting.transcript.json");
  writeFileSync(transcriptPath, transcript);
  const tsvPath = join(folder, "slides.tsv");
  writeFileSync(tsvPath, ["start\tend\tslide\timage", ...rows.map((r) => r.join("\t"))].join("\n") + "\n");
  for (const [, , , image] of rows) writeFileSync(join(folder, image), `png:${image}`);
  return { transcriptPath, tsvPath };
}

const FOUR_REMARKS = segments([
  [0.5, 9.8, "今日は採用の進め方を決めます"],
  [9.8, 19.2, "面接を何回にするかですね"],
  [19.2, 28.0, "この図の右側を見てください"],
  [30, 40, "2 回にしましょう"],
]);
const ROWS: [number, number, string, string][] = [
  [0, 3, "s1", "slides/s1.png"],
  [4, 8, "s2", "slides/s2.png"],
  [8, 12, "gallery", "slides/gallery.png"],
  [12, 15, "s4", "slides/s4.png"],
  [15, 18, "s5", "slides/s5.png"],
  [22, 26, "s6", "slides/s6.png"],
  [33, 38, "s7", "slides/s7.png"],
];

describe("play <セッションのフォルダ>", () => {
  it.effect("待ち時間なしの play --screen で作ったセッションを流し直すと、呼び出しの区切り・添えた画面・Claude へのメッセージ（画像のバイト列を含む）・題名・screens/ が元と同じになる", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const { transcriptPath, tsvPath } = meeting(root, FOUR_REMARKS, ROWS);
      const original = yield* played(dependencies(join(root, "original-sessions")), [transcriptPath, "--screen", tsvPath]);

      const replayDeps = dependencies(join(root, "replay-sessions"));
      const replay = yield* played(replayDeps, [original]);

      // 否定の比較なので、両方の play が実際に Claude を呼んだことを先に確かめる
      expect(external.created).toHaveLength(2);
      expect(external.created[0]!.messages.length).toBeGreaterThan(0);
      const originalLines = logLines(original);
      const replayLines = logLines(replay);
      expect(originalLines.filter((l) => l.type === "screen").length).toBeGreaterThan(0);
      expect(diffInputs(originalLines).some((input) => "screens" in input)).toBe(true);

      // 呼び出しの区切りと、添えた画面（input の全体: recent・fresh・nodeCount・screens・screenCount）
      expect(diffInputs(replayLines)).toEqual(diffInputs(originalLines));
      // Claude へ送ったメッセージ（見出し・画像のバイト列・発言を含む）
      expect(external.created[1]!.messages).toEqual(external.created[0]!.messages);
      // 題名は元の start の行から。フォルダ名（開始時刻）ではない
      const startOf = (lines: Line[]) => lines.find((l) => l.type === "start");
      expect(startOf(replayLines)).toMatchObject({ title: "meeting" });
      expect(startOf(replayLines)!.title).toBe(startOf(originalLines)!.title);
      // screen の行と screens/ の画像（名前は新しいセッションが付ける。同じ start から付くので同じになる）
      const screens = (lines: Line[]) => lines.filter((l) => l.type === "screen").map(({ start, image }) => ({ start, image }));
      expect(screens(replayLines)).toEqual(screens(originalLines));
      const files = readdirSync(join(replay, "screens")).sort();
      expect(files).toEqual(readdirSync(join(original, "screens")).sort());
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) expect(readFileSync(join(replay, "screens", file))).toEqual(readFileSync(join(original, "screens", file)));
      // 画像は元のフォルダの screens/ から読む。変換は呼ばない
      expect(replayDeps.convert.calls).toEqual([]);
    }));

  it.effect("共有画面の無いセッションも流せる（発言だけ）。screen の行も screens/ も作らず、発言は元のログのまま入る", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const fixture = parseLog(readFileSync(join(import.meta.dirname, "fixtures/session.log.jsonl"), "utf8"));
      const original = sessionFolder(root, fixture.map(({ at: _at, ...event }) => event));
      const deps = dependencies(join(root, "sessions"));
      const replay = yield* played(deps, [original]);

      expect(external.created.flatMap((c) => c.messages).length).toBeGreaterThan(0);
      const lines = logLines(replay);
      expect(lines.find((l) => l.type === "start")).toMatchObject({ title: "定例" });
      // 発言は remark の行の remark がそのまま入る（重複の印・中身の無い発言の印は中核が付ける）
      const remarks = (list: Line[]) => list.filter((l) => l.type === "remark").map(({ remark, noContent }) => ({ remark, noContent }));
      expect(remarks(lines)).toEqual(remarks(fixture));
      expect(remarks(lines)).toHaveLength(9);
      expect(lines.some((l) => l.type === "screen" || l.type === "screen-off")).toBe(false);
      expect(readdirSync(replay)).not.toContain("screens");
      expect(deps.convert.calls).toEqual([]);
    }));

  it.effect("screen-off が新しいログにも、同じ start・同じ reason・同じ並び（同じ時刻の screen との前後を含む）で残り、差分更新に添える画面には載らない。時刻はファイル名ではなくログの start", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      // 同じ時刻（3 と 6）で screen-off と screen が混ざる。画像のファイル名は時刻と関係ない名前にする
      const original = sessionFolder(
        root,
        [
          { type: "start", title: "手書きの会議" },
          remarkLine("r1", 0, 5),
          { type: "screen", start: 1, image: "first.jpg" },
          { type: "screen-off", start: 3, reason: "指定" },
          { type: "screen", start: 3, image: null },
          { type: "screen-off", start: 6, reason: "許可なし" },
          { type: "screen", start: 6, image: "second.jpg" },
          remarkLine("r2", 6, 9),
          { type: "screen", start: 20, image: null },
          { type: "screen-off", start: 25, reason: "指定" },
        ],
        { "first.jpg": "bytes-first", "second.jpg": "bytes-second" },
      );
      const deps = dependencies(join(root, "sessions"));
      const replay = yield* played(deps, [original]);

      const lines = logLines(replay);
      expect(lines.find((l) => l.type === "start")).toMatchObject({ title: "手書きの会議" });
      const sequence = lines
        .filter((l) => l.type === "remark" || l.type === "screen" || l.type === "screen-off")
        .map((l) => {
          if (l.type === "remark") return `remark:${(l.remark as { id: string }).id}`;
          if (l.type === "screen") return `screen:${l.start}:${l.image}`;
          return `screen-off:${l.start}:${l.reason}`;
        });
      expect(sequence).toEqual([
        "remark:r1",
        "screen:1:0001.0.jpg",
        "screen-off:3:指定",
        "screen:3:null",
        "screen-off:6:許可なし",
        "screen:6:0006.0.jpg",
        "remark:r2",
        "screen:20:null",
        "screen-off:25:指定",
      ]);
      // 画像は元のフォルダの screens/ から読み、新しい名前で書く
      expect(readFileSync(join(replay, "screens", "0001.0.jpg"), "utf8")).toBe("bytes-first");
      expect(readFileSync(join(replay, "screens", "0006.0.jpg"), "utf8")).toBe("bytes-second");
      expect(readdirSync(join(replay, "screens")).sort()).toEqual(["0001.0.jpg", "0006.0.jpg"]);
      // 差分更新に添える画面は screen だけ
      expect(diffInputs(lines)[0]).toMatchObject({
        fresh: ["r1", "r2"],
        screens: [
          { start: 1, image: "0001.0.jpg" },
          { start: 3, image: null },
          { start: 6, image: "0006.0.jpg" },
        ],
      });
      expect(deps.convert.calls).toEqual([]);
    }));

  it.effect("元のフォルダの screens/ の画像が読めないときは CommandFailed で失敗する", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const original = sessionFolder(root, [{ type: "start", title: "t" }, remarkLine("r1", 0, 5), { type: "screen", start: 1, image: "missing.jpg" }]);
      const error = yield* failure(dependencies(join(root, "sessions")), [original]);
      expect(error).toMatchObject({ _tag: "CommandFailed" });
      expect(error!.message).toContain("missing.jpg");
    }));

  for (const [name, imageOf] of [
    ["screens/ の外へ出る相対パス", () => "../../outside.jpg"],
    ["screens/ の外を指す絶対パス", (root: string) => join(root, "outside.jpg")],
    ["screens/ 直下を指す絶対パス", (root: string) => join(root, "original", "screens", "inside.jpg")],
    ["screens/ に戻ってくる相対パス", () => "../screens/inside.jpg"],
  ] as const) {
    it.effect(`ログの image が ${name}のときは、読む前に CommandFailed で失敗し、何も始めない（外のファイルを screens/ に取り込まない）`, () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory;
        writeFileSync(join(root, "outside.jpg"), "secret");
        const image = imageOf(root);
        const original = sessionFolder(root, [{ type: "start", title: "t" }, remarkLine("r1", 0, 5), { type: "screen", start: 1, image }], { "inside.jpg": "secret" });
        const sessionsDir = join(root, "sessions");
        const error = yield* failure(dependencies(sessionsDir), [original]);
        expect(error).toMatchObject({ _tag: "CommandFailed" });
        expect(error!.message).toContain(image);
        expect(external.openListener).not.toHaveBeenCalled();
        expect(sessionFolders(sessionsDir)).toEqual([]);
        expect(external.created).toEqual([]);
      }));
  }

  describe("ログの読み方", () => {
    it.effect("流さない行（intake-*・diff・知らない type）は、中身が壊れていても読み飛ばす", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory;
        const original = sessionFolder(root, [
          { type: "start", title: "t" },
          { type: "intake-restarted", trigger: "auto" },
          { type: "diff", input: 5 },
          remarkLine("r1", 0, 5),
          { type: "future-event", payload: 1 },
          remarkLine("r2", 6, 9),
        ]);
        const replay = yield* played(dependencies(join(root, "sessions")), [original]);
        expect(logLines(replay).filter((l) => l.type === "remark")).toHaveLength(2);
      }));

    it.effect("usage つきの diff の行（今の形式）と usage の無い diff の行（古い形式）が混ざったフォルダも、同じように再生できる", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory;
        const diff = { type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0 }, ops: [], dropped: [] };
        const usage = { input: 1, cacheWrite: 2, cacheRead: 3, output: 4, model: "claude-haiku-5-5" };
        const original = sessionFolder(root, [
          { type: "start", title: "t" },
          remarkLine("r1", 0, 5),
          { ...diff, usage },
          remarkLine("r2", 6, 9),
          diff,
        ]);
        const replay = yield* played(dependencies(join(root, "sessions")), [original]);
        expect(logLines(replay).filter((l) => l.type === "remark")).toHaveLength(2);
      }));

    for (const [name, text, line] of [
      ["JSON として壊れた行", '{"type":"start","title":"t"}\n\n{ not json\n', 3],
      ["remark の項目が壊れた行", '{"type":"start","title":"t"}\n\n{"type":"remark","remark":{"id":1}}\n', 3],
      ["screen の項目が壊れた行", '{"type":"start","title":"t"}\n\n\n{"type":"screen","start":"x","image":null}\n', 4],
      ["screen-off の reason が壊れた行", '{"type":"start","title":"t"}\n{"type":"screen-off","start":1,"reason":"?"}\n', 2],
    ] as const) {
      it.effect(`${name}は、空行を除く前の行番号つきの BrokenLogLine で失敗し、何も始めない`, () =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory;
          const original = join(root, "original");
          mkdirSync(original);
          writeFileSync(join(original, "log.jsonl"), text);
          const sessionsDir = join(root, "sessions");
          const error = yield* failure(dependencies(sessionsDir), [original]);
          expect(error).toMatchObject({ _tag: "BrokenLogLine", line });
          // 再生を始める前に失敗する: 待受けも新しいセッションのフォルダも作らない
          expect(external.openListener).not.toHaveBeenCalled();
          expect(sessionFolders(sessionsDir)).toEqual([]);
          expect(external.created).toEqual([]);
        }));
    }

    it.effect("start の行が無いログは CommandFailed で失敗する（題名が取れない）", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory;
        const original = sessionFolder(root, [remarkLine("r1", 0, 5)]);
        const sessionsDir = join(root, "sessions");
        expect(yield* failure(dependencies(sessionsDir), [original])).toMatchObject({ _tag: "CommandFailed" });
        expect(sessionFolders(sessionsDir)).toEqual([]);
      }));

    it.effect("log.jsonl が無いフォルダは CommandFailed で失敗する（log.jsonl がありません）", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory;
        const empty = join(root, "empty");
        mkdirSync(empty);
        const sessionsDir = join(root, "sessions");
        const error = yield* failure(dependencies(sessionsDir), [empty]);
        expect(error).toMatchObject({ _tag: "CommandFailed" });
        expect(error!.message).toContain("log.jsonl");
        expect(sessionFolders(sessionsDir)).toEqual([]);
      }));
  });

  it.effect("セッションのフォルダと --screen を一緒に渡すと CommandFailed で失敗し、待受けも新しいセッションのフォルダも作らない", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const original = sessionFolder(root, [{ type: "start", title: "t" }, remarkLine("r1", 0, 5)]);
      const { tsvPath } = meeting(root, FOUR_REMARKS, ROWS);
      const sessionsDir = join(root, "sessions");
      const deps = dependencies(sessionsDir);
      expect(yield* failure(deps, [original, "--screen", tsvPath])).toMatchObject({ _tag: "CommandFailed" });
      expect(external.openListener).not.toHaveBeenCalled();
      expect(sessionFolders(sessionsDir)).toEqual([]);
      expect(deps.convert.calls).toEqual([]);
      expect(external.created).toEqual([]);
    }));
});

// --realtime: 変化も発言と同じ時計で、start の時刻まで待ってから入る。実時間では待たず、TestClock を少しずつ進める。
// 発言 r1 は 0〜2 秒、r2 は 10〜12 秒。変化は 6 秒と 8 秒
describe("play --realtime で変化を時刻どおりに待つ", () => {
  const wait = (ms: number) => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // 状態が成り立つまで、実時間で短く待つ確認を上限つきで繰り返す（仮想時計は進めない）
  const eventually = (condition: () => boolean, what: string) =>
    Effect.gen(function* () {
      for (let i = 0; i < 1000 && !condition(); i++) yield* wait(5);
      expect(condition(), what).toBe(true);
    });

  // sleep だけを包んだ Clock。登録中の sleep の終点（仮想時刻の ms）を pending に持つ。TestClock が公開していない sleep の登録を観測するため
  const trackingClock = (pending: number[]) =>
    TestClock.testClockWith((testClock) =>
      Effect.succeed<Clock.Clock>({
        ...testClock,
        sleep: (duration) =>
          Effect.suspend(() => {
            const end = testClock.currentTimeMillisUnsafe() + Duration.toMillis(duration);
            pending.push(end);
            return testClock.sleep(duration).pipe(
              Effect.ensuring(Effect.sync(() => void pending.splice(pending.indexOf(end), 1))),
            );
          }),
      }),
    );

  const virtualNow = TestClock.testClockWith((testClock) => Effect.succeed(testClock.currentTimeMillisUnsafe()));

  // 新しいセッションのログ（まだ無ければ空）
  const currentLog = (sessionsDir: string): Line[] => {
    const folders = sessionFolders(sessionsDir);
    const path = folders.length > 0 ? join(sessionsDir, folders[0]!, "log.jsonl") : undefined;
    return path && existsSync(path) ? parseLog(readFileSync(path, "utf8")) : [];
  };
  const has = (sessionsDir: string, match: (l: Line) => boolean) => currentLog(sessionsDir).some(match);

  // 仮想時刻 target に終わる sleep の登録を確かめてから、target - 1 ms まで進めて行が無いことを、target まで進めて行が入ることを確かめる。
  // 仮想時計は target で止めたまま実時間で行を待つので、実 I/O の速さで観測時刻が動かない
  const advanceTo = (sessionsDir: string, pending: number[], target: number, match: (l: Line) => boolean) =>
    Effect.gen(function* () {
      yield* eventually(() => pending.includes(target), `仮想時刻 ${target} ms に終わる sleep が登録される`);
      expect(has(sessionsDir, match)).toBe(false);
      yield* TestClock.adjust(target - 1 - (yield* virtualNow));
      expect(has(sessionsDir, match)).toBe(false);
      yield* TestClock.adjust(1);
      yield* eventually(() => has(sessionsDir, match), `仮想時刻 ${target} ms で行が入る`);
      expect(yield* virtualNow).toBe(target);
    });

  const isRemark = (id: string) => (l: Line) => l.type === "remark" && (l.remark as { id: string }).id === id;

  // 再生は r1 の end（2 秒）→ 変化 2 つ → r2 の end（12 秒）の順に、同じ時計で待つ
  const observe = (sessionsDir: string, pending: number[], expectations: { screenAt: number; secondAt: number; secondType: "screen" | "screen-off" }) =>
    Effect.gen(function* () {
      yield* advanceTo(sessionsDir, pending, 2000, isRemark("r1"));
      // r1 が入った後でも、変化の start（6 秒）の手前では screen の行は無い
      expect(has(sessionsDir, (l) => l.type === "screen" && l.start === 6)).toBe(false);
      yield* advanceTo(sessionsDir, pending, expectations.screenAt * 1000, (l) => l.type === "screen" && l.start === expectations.screenAt);
      // 変化は発言の待ちに足されるのではなく、同じ時計に乗る: r2 は end の 12 秒
      expect(has(sessionsDir, isRemark("r2"))).toBe(false);
      yield* advanceTo(sessionsDir, pending, expectations.secondAt * 1000, (l) => l.type === expectations.secondType && l.start === expectations.secondAt);
      expect(has(sessionsDir, isRemark("r2"))).toBe(false);
      yield* advanceTo(sessionsDir, pending, 12000, isRemark("r2"));
    });

  it.effect("play <フォルダ> --realtime: screen は start まで、screen-off も start まで待ってから入る", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const original = sessionFolder(
        root,
        [
          { type: "start", title: "t" },
          remarkLine("r1", 0, 2),
          { type: "screen", start: 6, image: "a.jpg" },
          { type: "screen-off", start: 8, reason: "指定" },
          remarkLine("r2", 10, 12),
        ],
        { "a.jpg": "bytes-a" },
      );
      const sessionsDir = join(root, "sessions");
      const deps = dependencies(sessionsDir);
      const pending: number[] = [];
      const fiber = yield* runCli(["play", original, "--realtime"]).pipe(
        Effect.provide(deps.layer),
        Effect.provideService(Clock.Clock, yield* trackingClock(pending)),
        Effect.forkChild,
      );
      yield* observe(sessionsDir, pending, { screenAt: 6, secondAt: 8, secondType: "screen-off" });
      yield* TestClock.adjust(60_000);
      yield* Fiber.join(fiber);
      const lines = logLines(dirname(deps.stdout.join("").trim().split("\n")[0]!));
      expect(lines.filter((l) => l.type === "screen-off")).toMatchObject([{ start: 8, reason: "指定" }]);
    }), 30_000);

  it.effect("play --screen <slides.tsv> --realtime: 画像つきの変化も start まで待ってから入る（#274 は待ち時間なしだけだった）", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const { transcriptPath, tsvPath } = meeting(
        root,
        segments([[0, 2, "最初の発言"], [10, 12, "次の発言"]]),
        [[6, 8, "s1", "slides/s1.png"]],
      );
      const sessionsDir = join(root, "sessions");
      const deps = dependencies(sessionsDir);
      const pending: number[] = [];
      const fiber = yield* runCli(["play", transcriptPath, "--screen", tsvPath, "--realtime"]).pipe(
        Effect.provide(deps.layer),
        Effect.provideService(Clock.Clock, yield* trackingClock(pending)),
        Effect.forkChild,
      );
      // 6 秒に画像、8 秒に「なし」（最後の行の end）
      yield* observe(sessionsDir, pending, { screenAt: 6, secondAt: 8, secondType: "screen" });
      yield* TestClock.adjust(60_000);
      yield* Fiber.join(fiber);
      const lines = logLines(dirname(deps.stdout.join("").trim().split("\n")[0]!));
      expect(lines.filter((l) => l.type === "screen").map((l) => l.start)).toEqual([6, 8]);
    }), 30_000);
});

// Issue #644: 記録したセッションを再生すると、ログの vocab の行・screen の lines・remark の raw と words から、今の規則で発言を直し直す。
// 読みのサブコマンド（Readings）も読みを聞くモデルも呼ばない。words の無い古い発言は直さない。
describe("play <セッションのフォルダ>: 今の規則で発言を直し直す", () => {
  type Token = readonly [surface: string, romaji: string];
  // 語の並びから本文と words を組む（location / length は UTF-16 コード単位）
  const utterance = (...tokens: Token[]) => {
    let location = 0;
    const words = tokens.map(([surface, romaji]) => {
      const word = { surface, romaji, location, length: surface.length };
      location += surface.length;
      return word;
    });
    return { raw: tokens.map(([surface]) => surface).join(""), words };
  };
  // correction.test.ts と同じ読み（実際の CFStringTokenizer の値）。「全デスク」は Zendesk に直る
  const ZENDESK_UTTERANCE = utterance(["今日", "kyou"], ["は", "ha"], ["全", "zen"], ["デスク", "desuku"], ["で", "de"], ["確認", "kakunin"], ["し", "shi"], ["ます", "masu"], ["。", "｡"]);
  const NOTION_UTTERANCE = utterance(["ノー", "nō"], ["ション", "shon"], ["を", "wo"], ["使う", "tsukau"]);
  const CORRECTED = "今日はZendeskで確認します。";
  const ZENDESK_VOCAB = { type: "vocab", words: [{ surface: "Zendesk", romaji: "zendesuku", source: "user" }] };

  const recordedRemark = (id: string, start: number, end: number, utter: { raw: string; words: unknown[] }) => ({
    type: "remark",
    remark: { id, track: "相手", start, end, text: utter.raw },
    raw: utter.raw,
    words: utter.words,
  });
  const remarkTexts = (lines: Line[]) => lines.filter((l) => l.type === "remark").map((l) => (l.remark as { id: string; text: string }).text);
  const remarkLineOf = (lines: Line[], id: string) => lines.find((l) => l.type === "remark" && (l.remark as { id: string }).id === id)!;
  const sentTexts = () => external.created.flatMap((c) => c.messages).map((m) => JSON.stringify(m.message.content)).join("\n");

  it.effect("vocab の行と words を持つログを再生すると、発言が今の規則で直り、読みのサブコマンドは呼ばれない。raw と words は新しいログにも残る", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const original = sessionFolder(root, [{ type: "start", title: "t" }, ZENDESK_VOCAB, recordedRemark("r1", 0, 5, ZENDESK_UTTERANCE)]);
      const readings = fakeReadings({ Zendesk: "zendesuku" });
      const base = dependencies(join(root, "sessions"));
      const deps = { ...base, layer: Layer.mergeAll(base.layer, readings.layer) };
      const replay = yield* played(deps, [original]);

      const lines = logLines(replay);
      // 直る前の本文（raw）から直し直した本文になる。raw と words は直す前のまま残る
      expect(ZENDESK_UTTERANCE.raw).toBe("今日は全デスクで確認します。");
      expect(remarkLineOf(lines, "r1")).toMatchObject({ remark: { text: CORRECTED }, raw: ZENDESK_UTTERANCE.raw, words: ZENDESK_UTTERANCE.words });
      // 語彙の行も再生側のログに書く（読みは元の vocab の行から）
      expect(lines.filter((l) => l.type === "vocab")).toEqual([expect.objectContaining({ words: [{ surface: "Zendesk", romaji: "zendesuku", source: "user" }] })]);
      // 直った表記が差分更新まで届いている（届いたことを確かめてから、読みを呼ばないことを確かめる）
      expect(sentTexts()).toContain(CORRECTED);
      expect(sentTexts()).not.toContain("全デスク");
      expect(readings.calls).toEqual([]);
      expect(external.created).toHaveLength(1); // 差分更新の query だけ（読みを聞く呼び出しは無い）
    }));

  it.effect("補正の部品を差し替えて再生すると、直した結果が差し替えた部品のとおりに変わる", () =>
    Effect.gen(function* () {
      const { RemarkCorrection } = yield* Effect.promise(() => import("../src/replayCorrection.ts"));
      const root = yield* temporaryDirectory;
      // ライブで直した後の本文（text）と、直す前の本文（raw）を変えて記録する。補正は raw から行う
      const recorded = recordedRemark("r1", 0, 5, ZENDESK_UTTERANCE);
      const original = sessionFolder(root, [
        { type: "start", title: "t" },
        ZENDESK_VOCAB,
        { ...recorded, remark: { ...recorded.remark, text: CORRECTED } },
      ]);
      const seen: Array<{ vocabulary: readonly unknown[]; text: string }> = [];
      const replaced = ((vocabulary: readonly unknown[], text: string) => {
        seen.push({ vocabulary, text });
        return { text: `差し替え:${text}`, replacements: [] };
      }) as unknown as typeof RemarkCorrection["Service"];
      const deps = dependencies(join(root, "sessions"));
      const replay = yield* played(deps, [original]).pipe(Effect.provideService(RemarkCorrection, replaced));

      const lines = logLines(replay);
      expect(remarkLineOf(lines, "r1")).toMatchObject({ remark: { text: `差し替え:${ZENDESK_UTTERANCE.raw}` } });
      expect(remarkTexts(lines)).not.toContain(CORRECTED);
      // 差し替えた部品には、ログの raw と、vocab の行から組んだ語彙が渡る
      expect(seen).toEqual([{ vocabulary: [{ surface: "Zendesk", romaji: "zendesuku" }], text: ZENDESK_UTTERANCE.raw }]);
    }));

  it.effect("raw と words の無い古い発言は直さずに流れ、新しいログにも raw と words を付けない。同じログの words 付きの発言は直る", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const original = sessionFolder(root, [
        { type: "start", title: "t" },
        ZENDESK_VOCAB,
        remarkLine("old", 0, 5, "今日は全デスクで確認します。"),
        recordedRemark("new", 6, 9, ZENDESK_UTTERANCE),
      ]);
      const replay = yield* played(dependencies(join(root, "sessions")), [original]);

      const lines = logLines(replay);
      expect(remarkLineOf(lines, "new")).toMatchObject({ remark: { text: CORRECTED } }); // 語彙が効いている状態で、古い発言だけが直らない
      const old = remarkLineOf(lines, "old");
      expect(old).toMatchObject({ remark: { text: "今日は全デスクで確認します。" } });
      expect(old).not.toHaveProperty("raw");
      expect(old).not.toHaveProperty("words");
    }));

  it.effect("screen の lines から今の規則で候補を取り直す。screen より前の発言・今の規則で取れない語は直らない", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const original = sessionFolder(root, [
        { type: "start", title: "t" },
        // screen より前の発言（画面の語はまだ語彙に入っていない）
        recordedRemark("before", 0, 5, ZENDESK_UTTERANCE),
        { type: "vocab", words: [{ surface: "Zendesk", romaji: "zendesuku", source: "screen" }, { surface: "notion", romaji: "noshon", source: "screen" }] },
        { type: "screen", start: 6, image: null, lines: ["Zendesk 導入", "notion"] },
        recordedRemark("after", 7, 9, ZENDESK_UTTERANCE),
        // notion は vocab の行にあるが、小文字だけの英字の語は今の規則で lines から取れない
        recordedRemark("notion", 10, 12, NOTION_UTTERANCE),
      ]);
      const readings = fakeReadings({ Zendesk: "zendesuku", notion: "noshon" });
      const base = dependencies(join(root, "sessions"));
      const deps = { ...base, layer: Layer.mergeAll(base.layer, readings.layer) };
      const replay = yield* played(deps, [original]);

      const lines = logLines(replay);
      expect(remarkLineOf(lines, "after")).toMatchObject({ remark: { text: CORRECTED } });
      expect(remarkLineOf(lines, "before")).toMatchObject({ remark: { text: ZENDESK_UTTERANCE.raw } });
      expect(remarkLineOf(lines, "notion")).toMatchObject({ remark: { text: NOTION_UTTERANCE.raw } });
      // screen の lines は新しいログにも残る（もう一度再生しても同じように直せる）
      expect(lines.find((l) => l.type === "screen")).toMatchObject({ start: 6, lines: ["Zendesk 導入", "notion"] });
      expect(readings.calls).toEqual([]);
    }));

  it.effect("読みの無い語（romaji: null）は、画面の候補になっても補正に使われず、元の本文のまま流れ、新しいログには romaji: null で残る。読みのある語は同じ実行で直る", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const original = sessionFolder(root, [
        { type: "start", title: "t" },
        { type: "vocab", words: [{ surface: "Notion", romaji: null, source: "screen" }, { surface: "Zendesk", romaji: "zendesuku", source: "screen" }] },
        { type: "screen", start: 6, image: null, lines: ["Zendesk 導入", "Notion"] },
        recordedRemark("zendesk", 7, 9, ZENDESK_UTTERANCE),
        recordedRemark("notion", 10, 12, NOTION_UTTERANCE),
      ]);
      const readings = fakeReadings({ Zendesk: "zendesuku", Notion: "nōshon" });
      const base = dependencies(join(root, "sessions"));
      const deps = { ...base, layer: Layer.mergeAll(base.layer, readings.layer) };
      const replay = yield* played(deps, [original]);

      const lines = logLines(replay);
      expect(remarkLineOf(lines, "zendesk")).toMatchObject({ remark: { text: CORRECTED } });
      expect(remarkLineOf(lines, "notion")).toMatchObject({ remark: { text: NOTION_UTTERANCE.raw } });
      const vocabWords = lines.filter((l) => l.type === "vocab").flatMap((l) => l.words as Array<{ surface: string; romaji: string | null; source: string }>);
      expect(vocabWords).toContainEqual({ surface: "Notion", romaji: null, source: "screen" });
      expect(vocabWords).toContainEqual({ surface: "Zendesk", romaji: "zendesuku", source: "screen" });
      expect(readings.calls).toEqual([]);
    }));

  it.effect("lines の無い古い screen の行は、これまでどおり lines のキーを付けずに流れる", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const original = sessionFolder(root, [{ type: "start", title: "t" }, remarkLine("r1", 0, 5), { type: "screen", start: 1, image: null }]);
      const replay = yield* played(dependencies(join(root, "sessions")), [original]);
      const screen = logLines(replay).find((l) => l.type === "screen")!;
      expect(screen).toMatchObject({ start: 1, image: null });
      expect(screen).not.toHaveProperty("lines");
    }));
});
