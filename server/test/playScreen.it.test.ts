import { unusedApple } from "./fixtures/appleIntelligence.ts";
import { readyManagedDeps } from "./fixtures/readyManagedDeps.ts";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Console, Effect, Layer } from "effect";
import { beforeEach, vi } from "vitest";
import { MapCapture } from "../src/capture.ts";
import { runCli } from "../src/cli.ts";
import { ReviewBuild } from "../src/review.ts";
import { fakeListener } from "./fakeListener.ts";
import { fakeAudioMix } from "./fixtures/audioMix.ts";
import { fakeJpegBytes, fakeScreenJpeg } from "./fixtures/screenJpeg.ts";

type Block = { type: string; text?: string; source?: { type: string; media_type: string; data: string } };
type SentMessage = { type: string; message: { role: string; content: string | Block[] } };
type Created = { messages: SentMessage[]; options: { systemPrompt: string } };

const external = vi.hoisted(() => ({
  created: [] as Created[],
  openListener: vi.fn(),
  calls: 0,
  behave: ((_n: number): "ok" | "fail" | "end" => "ok") as (n: number) => "ok" | "fail" | "end",
}));

vi.mock("../src/claude.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/claude.ts")>();
  const { Layer: L } = await import("effect");
  const query = ((params: { prompt: AsyncIterable<SentMessage>; options: Created["options"] }) => {
    const record: Created = { messages: [], options: params.options };
    external.created.push(record);
    const gen = (async function* () {
      for await (const message of params.prompt) {
        record.messages.push(message);
        const behavior = external.behave(external.calls++);
        if (behavior === "end") return;
        yield { type: "assistant", message: { model: "fake-model", usage: { input_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens: 0 } } };
        if (behavior === "fail") yield { type: "result", subtype: "error_during_execution" };
        else yield { type: "result", subtype: "success", structured_output: { ops: [{ op: "noop", reason: "テスト" }] } };
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
  external.calls = 0;
  external.behave = () => "ok";
  external.openListener.mockReset();
  external.openListener.mockImplementation(fakeListener().open);
});

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-screen-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

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

const FOUR_REMARKS = segments([
  [0.5, 9.8, "今日は採用の進め方を決めます"],
  [9.8, 19.2, "面接を何回にするかですね"],
  [19.2, 28.0, "この図の右側を見てください"],
  [30, 40, "2 回にしましょう"],
]);

function meeting(root: string, transcript: string, rows: [start: number, end: number, slide: string, image: string][]) {
  const folder = join(root, "meeting");
  mkdirSync(join(folder, "slides"), { recursive: true });
  const transcriptPath = join(folder, "meeting.transcript.json");
  writeFileSync(transcriptPath, transcript);
  const tsv = ["start\tend\tslide\timage", ...rows.map((r) => r.join("\t"))].join("\n") + "\n";
  const tsvPath = join(folder, "slides.tsv");
  writeFileSync(tsvPath, tsv);
  for (const [, , , image] of rows) writeFileSync(join(folder, image), `png:${image}`);
  return { transcriptPath, tsvPath };
}

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

const played = (deps: ReturnType<typeof dependencies>, args: string[]) =>
  Effect.gen(function* () {
    yield* runCli(["play", ...args]).pipe(Effect.provide(deps.layer));
    return dirname(deps.stdout.join("").trim().split("\n")[0]!);
  });

const logLines = (session: string) =>
  readFileSync(join(session, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown> & { type: string });

const blocksOf = (message: SentMessage): Block[] => {
  expect(Array.isArray(message.message.content)).toBe(true);
  return message.message.content as Block[];
};
const heading = (b: Block | undefined) => (b?.type === "text" ? b.text?.trim() : undefined);
const imageBytes = (b: Block | undefined) => Buffer.from(b!.source!.data, "base64");

const ROWS: [number, number, string, string][] = [
  [0, 3, "s1", "slides/s1.png"],
  [4, 8, "s2", "slides/s2.png"],
  [8, 12, "gallery", "slides/gallery.png"],
  [12, 15, "s4", "slides/s4.png"],
  [15, 18, "s5", "slides/s5.png"],
  [22, 26, "s6", "slides/s6.png"],
  [33, 38, "s7", "slides/s7.png"],
];

describe("play --screen", () => {
  it.effect("保存ログの OCR 失敗印を再生先へ残し、失敗画像もコピーする", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const source = join(root, "source");
    mkdirSync(join(source, "screens"), { recursive: true });
    const image = Buffer.from([0xff, 0xd8, 0xff, 1]);
    writeFileSync(join(source, "screens", "0001.0.jpg"), image);
    writeFileSync(join(source, "log.jsonl"), [
      { type: "start", title: "OCR" },
      { type: "screen", start: 1, image: "0001.0.jpg", ocrFailed: true },
      { type: "remark", remark: { id: "r1", track: "相手", start: 2, end: 3, text: "共有画面を確認します" } },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
    const deps = dependencies(join(root, "sessions"));
    const session = yield* played(deps, [source]);
    const screens = logLines(session).filter((event) => event.type === "screen");
    expect(screens).toHaveLength(1);
    expect.soft(screens[0]).toMatchObject({ start: 1, ocrFailed: true });
    expect(screens[0]).not.toHaveProperty("lines");
    const name = screens[0]!.image;
    if (typeof name !== "string") throw new Error("screen の画像ファイル名が必要");
    expect(readFileSync(join(session, "screens", name))).toEqual(image);
  }));

  it.effect("共有画面の節が、見出しと画像のブロックとして、マップと発言より前に、時刻順に載る。「なし」は見出しだけ。gallery の行も画像", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const { transcriptPath, tsvPath } = meeting(root, FOUR_REMARKS, ROWS);
      const deps = dependencies(join(root, "sessions"));
      yield* played(deps, [transcriptPath, "--screen", tsvPath]);

      expect(external.created).toHaveLength(1);
      const sent = external.created[0]!.messages;
      expect(sent).toHaveLength(4);

      const first = blocksOf(sent[0]!);
      expect(first.map((b) => b.type)).toEqual(["text", "image", "text"]);
      expect(heading(first[0])).toBe("## 共有画面 [00:00] から");
      expect(first[1]!.source).toMatchObject({ type: "base64", media_type: "image/jpeg" });
      expect(imageBytes(first[1])).toEqual(Buffer.from(fakeJpegBytes("png:slides/s1.png")));
      const prompt = first[2]!.text!;
      expect(prompt).toContain("## 現在のマップ");
      expect(prompt).toContain("今日は採用の進め方を決めます");
      expect(prompt).not.toContain("面接を何回にするかですね");
      expect(prompt).not.toContain("共有画面");

      const second = blocksOf(sent[1]!);
      expect(second.map((b) => b.type)).toEqual(["text", "text"]);
      expect(heading(second[0])).toBe("## 共有画面：なし（[00:03] から）");
      expect(second[1]!.text).toContain("## 前回からのマップの変更");
      expect(second[1]!.text).toContain("面接を何回にするかですね");

      const third = blocksOf(sent[2]!);
      expect(third.map((b) => b.type)).toEqual(["text", "image", "text", "text"]);
      expect(heading(third[0])).toBe("## 共有画面 [00:08] から");
      expect(imageBytes(third[1])).toEqual(Buffer.from(fakeJpegBytes("png:slides/gallery.png")));
      expect(heading(third[2])).toBe("## 共有画面：なし（[00:18] から）");
      expect(third[3]!.text).toContain("この図の右側を見てください");

      const fourth = blocksOf(sent[3]!);
      expect(fourth.map((b) => b.type)).toEqual(["text", "image", "text", "text"]);
      expect(heading(fourth[0])).toBe("## 共有画面 [00:22] から");
      expect(imageBytes(fourth[1])).toEqual(Buffer.from(fakeJpegBytes("png:slides/s6.png")));
      expect(heading(fourth[2])).toBe("## 共有画面：なし（[00:26] から）");
      expect(fourth[3]!.text).toContain("2 回にしましょう");
    }));

  it.effect("image の列は slides.tsv のあるフォルダからの相対パスで引かれ、変換は画像ごとに 1 回", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const { transcriptPath, tsvPath } = meeting(root, FOUR_REMARKS, ROWS);
      const deps = dependencies(join(root, "sessions"));
      yield* played(deps, [transcriptPath, "--screen", tsvPath]);
      expect(deps.convert.calls.map((p) => p.replace(`${dirname(tsvPath)}/`, ""))).toEqual(ROWS.map((r) => r[3]));
    }));

  it.effect("ログに screen の行（変化 1 件ごと）と diff の screens が残り、screens/ の画像は送ったのと同じバイト列", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const { transcriptPath, tsvPath } = meeting(root, FOUR_REMARKS, ROWS);
      const deps = dependencies(join(root, "sessions"));
      const session = yield* played(deps, [transcriptPath, "--screen", tsvPath]);

      const lines = logLines(session);
      expect(lines.filter((l) => l.type === "screen").map(({ type, start, image }) => ({ type, start, image }))).toEqual([
        { type: "screen", start: 0, image: "0000.0.jpg" },
        { type: "screen", start: 3, image: null },
        { type: "screen", start: 4, image: "0004.0.jpg" },
        { type: "screen", start: 8, image: "0008.0.jpg" },
        { type: "screen", start: 12, image: "0012.0.jpg" },
        { type: "screen", start: 15, image: "0015.0.jpg" },
        { type: "screen", start: 18, image: null },
        { type: "screen", start: 22, image: "0022.0.jpg" },
        { type: "screen", start: 26, image: null },
        { type: "screen", start: 33, image: "0033.0.jpg" },
        { type: "screen", start: 38, image: null },
      ]);
      const indexOf = (match: (l: (typeof lines)[number]) => boolean) => lines.findIndex(match);
      const remarkIndex = (id: string) => indexOf((l) => l.type === "remark" && (l.remark as { id: string }).id === id);
      const screenIndex = (start: number) => indexOf((l) => l.type === "screen" && l.start === start);
      expect(screenIndex(0)).toBeLessThan(remarkIndex("r1"));
      expect(screenIndex(8)).toBeLessThan(remarkIndex("r2"));
      expect(screenIndex(12)).toBeGreaterThan(remarkIndex("r2"));
      expect(screenIndex(12)).toBeLessThan(remarkIndex("r3"));

      const diffs = lines.filter((l) => l.type === "diff") as unknown as { input: Record<string, unknown> }[];
      expect(diffs).toHaveLength(4);
      expect(diffs[0]!.input.screens).toEqual([{ start: 0, image: "0000.0.jpg" }]);
      expect(diffs[1]!.input.screens).toEqual([{ start: 3, image: null }]);
      expect(diffs[2]!.input.screens).toEqual([
        { start: 8, image: "0008.0.jpg" },
        { start: 18, image: null },
      ]);
      expect(diffs[3]!.input.screens).toEqual([
        { start: 22, image: "0022.0.jpg" },
        { start: 26, image: null },
      ]);

      const files = readdirSync(join(session, "screens")).sort();
      expect(files).toEqual(["0000.0.jpg", "0004.0.jpg", "0008.0.jpg", "0012.0.jpg", "0015.0.jpg", "0022.0.jpg", "0033.0.jpg"]);
      const sent = external.created[0]!.messages;
      const sentSecond = blocksOf(sent[1]!);
      expect(sentSecond.some((b) => b.type === "image")).toBe(false);
      expect(readFileSync(join(session, "screens", "0008.0.jpg"))).toEqual(imageBytes(blocksOf(sent[2]!)[1]));
      expect(readFileSync(join(session, "screens", "0022.0.jpg"))).toEqual(imageBytes(blocksOf(sent[3]!)[1]));
      expect(readFileSync(join(session, "screens", "0004.0.jpg"))).toEqual(Buffer.from(fakeJpegBytes("png:slides/s2.png")));
      expect(readFileSync(join(session, "screens", "0033.0.jpg"))).toEqual(Buffer.from(fakeJpegBytes("png:slides/s7.png")));
    }));

  it.effect("変化の無い呼び出しには節が載らず、content は文字列のまま", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const { transcriptPath, tsvPath } = meeting(root, FOUR_REMARKS, [[0, 100, "s1", "slides/s1.png"]]);
      const deps = dependencies(join(root, "sessions"));
      const session = yield* played(deps, [transcriptPath, "--screen", tsvPath]);

      const sent = external.created[0]!.messages;
      expect(sent).toHaveLength(4);
      expect(blocksOf(sent[0]!).map((b) => b.type)).toEqual(["text", "image", "text"]);
      for (const message of sent.slice(1)) {
        expect(typeof message.message.content).toBe("string");
        expect(message.message.content).not.toContain("共有画面");
      }
      expect(sent[3]!.message.content).toContain("2 回にしましょう");

      const diffs = logLines(session).filter((l) => l.type === "diff") as unknown as { input: Record<string, unknown> }[];
      expect(diffs).toHaveLength(4);
      for (const diff of diffs.slice(1)) expect("screens" in diff.input).toBe(false);
      expect(diffs[0]!.input.screens).toEqual([{ start: 0, image: "0000.0.jpg" }]);
    }));

  it.effect("system に「# 共有画面」の節があり、既存の節（# 会話の扱い など）も残る", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const { transcriptPath, tsvPath } = meeting(root, FOUR_REMARKS, ROWS);
      const deps = dependencies(join(root, "sessions"));
      yield* played(deps, [transcriptPath, "--screen", tsvPath]);

      const system = external.created[0]!.options.systemPrompt;
      expect(system).toContain("# 共有画面");
      expect(system).toContain("# 会話の扱い");
      const section = system.slice(system.indexOf("# 共有画面")).split(/\n# /)[0]!;
      expect(section).toMatch(/映り続け/);
      expect(section).toMatch(/発言の時刻/);
      expect(section).toMatch(/顔/);
    }));

  it.effect("--screen を付けない play は、content が文字列で、screens キーも screen の行も screens/ も無い", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const { transcriptPath } = meeting(root, FOUR_REMARKS, ROWS);
      const deps = dependencies(join(root, "sessions"));
      const session = yield* played(deps, [transcriptPath]);

      const sent = external.created[0]!.messages;
      expect(sent).toHaveLength(4);
      expect(sent.map((m) => typeof m.message.content)).toEqual(["string", "string", "string", "string"]);
      const lines = logLines(session);
      expect(lines.filter((l) => l.type === "diff")).toHaveLength(4);
      expect(lines.some((l) => l.type === "screen")).toBe(false);
      expect(lines.some((l) => "screens" in ((l.input as object | undefined) ?? {}))).toBe(false);
      expect(readdirSync(session)).not.toContain("screens");
      expect(deps.convert.calls).toEqual([]);
    }));

  it.effect("画像が読めない行があれば、再生を始める前にコマンドが失敗する（CommandFailed）", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const { transcriptPath, tsvPath } = meeting(root, FOUR_REMARKS, ROWS);
      yield* Effect.promise(() => rm(join(dirname(tsvPath), "slides/s2.png")));
      const deps = dependencies(join(root, "sessions"));
      const result = yield* Effect.result(runCli(["play", transcriptPath, "--screen", tsvPath]).pipe(Effect.provide(deps.layer)));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure).toMatchObject({ _tag: "CommandFailed" });
      expect(external.created.flatMap((c) => c.messages)).toEqual([]);
    }));

  it.effect("slides.tsv の列が足りない・数値でない行があれば CommandFailed", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const { transcriptPath, tsvPath } = meeting(root, FOUR_REMARKS, ROWS);
      writeFileSync(tsvPath, "start\tend\tslide\timage\nabc\t3\ts1\tslides/s1.png\n");
      const deps = dependencies(join(root, "sessions"));
      const result = yield* Effect.result(runCli(["play", transcriptPath, "--screen", tsvPath]).pipe(Effect.provide(deps.layer)));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure).toMatchObject({ _tag: "CommandFailed" });
    }));

  const FIFTEEN_REMARKS = segments(Array.from({ length: 15 }, (_, i): [number, number, string] => [i * 10, i * 10 + 9, `発言${i}`]));
  const textHeadings = (blocks: Block[]) => blocks.filter((b) => b.type === "text").map((b) => b.text!.trim());
  const imagesOf = (blocks: Block[]) => blocks.filter((b) => b.type === "image").map((b) => imageBytes(b));
  const jpeg = (slide: string) => Buffer.from(fakeJpegBytes(`png:slides/${slide}.png`));

  it.effect("14 回ごとに開き直した query の最初のメッセージに、最後に添えた画面とその前の 1 件が、時刻つきで載る", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const { transcriptPath, tsvPath } = meeting(root, FIFTEEN_REMARKS, [
        [0, 10, "s1", "slides/s1.png"],
        [10, 20, "s2", "slides/s2.png"],
        [20, 1000, "s3", "slides/s3.png"],
      ]);
      const deps = dependencies(join(root, "sessions"));
      const session = yield* played(deps, [transcriptPath, "--screen", tsvPath]);

      expect(external.created).toHaveLength(2);
      expect(external.created[0]!.messages).toHaveLength(14);
      expect(external.created[1]!.messages).toHaveLength(1);
      const reopened = blocksOf(external.created[1]!.messages[0]!);
      expect(reopened.map((b) => b.type)).toEqual(["text", "image", "text", "image", "text"]);
      expect(textHeadings(reopened).slice(0, 2)).toEqual(["## 共有画面 [00:10] から", "## 共有画面 [00:20] から"]);
      expect(imagesOf(reopened)).toEqual([jpeg("s2"), jpeg("s3")]);
      expect(reopened[4]!.text).toContain("## 現在のマップ");
      expect(external.created[0]!.messages.slice(3).map((m) => typeof m.message.content)).toEqual(Array(11).fill("string"));

      const diffs = logLines(session).filter((l) => l.type === "diff") as unknown as { input: Record<string, unknown> }[];
      expect(diffs).toHaveLength(15);
      expect("screens" in diffs[14]!.input).toBe(false);
      expect(diffs.some((d) => "previousScreens" in d.input)).toBe(false);
    }));

  it.effect("最後に添えたのが画像でも「なし」でも、直前の 2 件が載る。新しく添える画面（持ち越した変化を含む）は別に続く", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const { transcriptPath, tsvPath } = meeting(root, FIFTEEN_REMARKS, [
        [0, 10, "s1", "slides/s1.png"],
        [10, 20, "s2", "slides/s2.png"],
        [125, 127, "s4", "slides/s4.png"],
        [127, 137, "s5", "slides/s5.png"],
        [137, 400, "s6", "slides/s6.png"],
      ]);
      const deps = dependencies(join(root, "sessions"));
      const session = yield* played(deps, [transcriptPath, "--screen", tsvPath]);

      expect(external.created).toHaveLength(2);
      const reopened = blocksOf(external.created[1]!.messages[0]!);
      expect(textHeadings(reopened).slice(0, -1)).toEqual([
        "## 共有画面：なし（[00:20] から）",
        "## 共有画面 [02:05] から",
        "## 共有画面 [02:07] から",
        "## 共有画面 [02:17] から",
      ]);
      expect(imagesOf(reopened)).toEqual([jpeg("s4"), jpeg("s5"), jpeg("s6")]);
      expect(reopened[reopened.length - 1]!.text).toContain("## 現在のマップ");

      const diffs = logLines(session).filter((l) => l.type === "diff") as unknown as { input: { screens?: unknown } }[];
      expect(diffs[13]!.input.screens).toEqual([{ start: 125, image: "0125.0.jpg" }]);
      expect(diffs[14]!.input.screens).toEqual([
        { start: 127, image: "0127.0.jpg" },
        { start: 137, image: "0137.0.jpg" },
      ]);
    }));

  for (const mode of ["fail", "end"] as const) {
    it.effect(`${mode === "fail" ? "失敗" : "ストリームの終わり"}の後に開いた query の最初のメッセージにも、最後に添えた 2 件が載る（失敗した呼び出しで選んだ画面も数える）`, () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory;
        external.behave = (n) => (n === 2 ? mode : "ok");
        const { transcriptPath, tsvPath } = meeting(root, FIFTEEN_REMARKS, [
          [0, 10, "s1", "slides/s1.png"],
          [10, 20, "s2", "slides/s2.png"],
        ]);
        const deps = dependencies(join(root, "sessions"));
        const session = yield* played(deps, [transcriptPath, "--screen", tsvPath]);

        expect(external.created).toHaveLength(2);
        expect(external.created[0]!.messages).toHaveLength(3);
        expect(external.created[1]!.messages).toHaveLength(12);
        const reopened = blocksOf(external.created[1]!.messages[0]!);
        expect(reopened.map((b) => b.type)).toEqual(["text", "image", "text", "text"]);
        expect(textHeadings(reopened).slice(0, 2)).toEqual(["## 共有画面 [00:10] から", "## 共有画面：なし（[00:20] から）"]);
        expect(imagesOf(reopened)).toEqual([jpeg("s2")]);
        expect(typeof external.created[1]!.messages[1]!.message.content).toBe("string");

        const diffs = logLines(session).filter((l) => l.type === "diff") as unknown as { error?: string; input: Record<string, unknown> }[];
        expect(diffs).toHaveLength(15);
        expect(diffs[2]!.error).toBeDefined();
        expect(diffs[2]!.input.screens).toEqual([{ start: 20, image: null }]);
        expect("screens" in diffs[3]!.input).toBe(false);
      }));
  }

  it.effect("送り直すものも新しく添える画面も無い開き直しの最初のメッセージは、content が文字列のまま（共有画面を一度も添えていないとき）", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      external.behave = (n) => (n === 0 ? "fail" : "ok");
      const { transcriptPath, tsvPath } = meeting(root, FIFTEEN_REMARKS, [[500, 600, "s1", "slides/s1.png"]]);
      const deps = dependencies(join(root, "sessions"));
      yield* played(deps, [transcriptPath, "--screen", tsvPath]);

      expect(external.created).toHaveLength(2);
      expect(typeof external.created[1]!.messages[0]!.message.content).toBe("string");
      expect(external.created.flatMap((c) => c.messages).every((m) => typeof m.message.content === "string")).toBe(true);
    }));
});
