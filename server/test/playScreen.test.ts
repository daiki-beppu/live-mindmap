import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Console, Effect, Layer } from "effect";
import { beforeEach, vi } from "vitest";
import { MapCapture } from "../src/capture.ts";
import { runCli } from "../src/cli.ts";
import { ReviewBuild } from "../src/review.ts";
import { fakeListener } from "./fakeListener.ts";
import { fakeAudioMix } from "./fixtures/audioMix.ts";
import { fakeJpegBytes, fakeScreenJpeg } from "./fixtures/screenJpeg.ts";

// play --screen を、CLI の入口から偽の Agent SDK の query まで通して確かめる（試すシームは CLI の play + 偽の query）。
// cli.test.ts は claude.ts ごと偽の DiffUpdater に替えるので、メッセージの中身を見るこのファイルは別にして、
// 本物の ClaudeDiffUpdater を残したまま AgentSdk.layer だけを偽物に替える。
// 共有画面の画像の変換（PNG → JPEG）は Service ScreenJpeg の偽物（CI の ubuntu では sips を使えない）。

type Block = { type: string; text?: string; source?: { type: string; media_type: string; data: string } };
type SentMessage = { type: string; message: { role: string; content: string | Block[] } };
type Created = { messages: SentMessage[]; options: { systemPrompt: string } };

const external = vi.hoisted(() => ({
  created: [] as Created[],
  openListener: vi.fn(),
  // 全 query を通した何通目（0 から）の user メッセージを、どう終わらせるか。既定は成功
  calls: 0,
  behave: ((_n: number): "ok" | "fail" | "end" => "ok") as (n: number) => "ok" | "fail" | "end",
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
        const behavior = external.behave(external.calls++);
        if (behavior === "end") return; // result を出さずにストリームが終わる
        yield { type: "assistant" };
        if (behavior === "fail") yield { type: "result", subtype: "error_during_execution" };
        else yield { type: "result", subtype: "success", structured_output: { ops: [{ op: "noop", reason: "テスト" }] } };
      }
    })();
    return Object.assign(gen, { close: () => {} });
  }) as unknown as import("../src/claude.ts").AgentSdk["Service"]["query"];
  return { ...actual, AgentSdk: { layer: L.succeed(actual.AgentSdk, actual.AgentSdk.of({ query })) } };
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

// 発言 4 つ: r1・r2 が最初の呼び出し（end の最大 19.2）、r3・r4 が 2 回目の呼び出し（end の最大 40）
const FOUR_REMARKS = segments([
  [0.5, 9.8, "今日は採用の進め方を決めます"],
  [9.8, 19.2, "面接を何回にするかですね"],
  [19.2, 28.0, "この図の右側を見てください"],
  [30, 40, "2 回にしましょう"],
]);

// 素材を置いた「会議のフォルダ」を作る。slides.tsv は 1 行目が見出しで、image は tsv のあるフォルダからの相対パス。
// 画像ファイルの中身は "png:<スラッグ>"（偽の変換はこの中身から JPEG のバイト列を作る）
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
    NodeServices.layer,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({ LIVE_MINDMAP_SESSIONS: sessionsDir, LIVE_MINDMAP_PORT: "0" })),
    Layer.succeed(Console.Console, consoleService),
    Layer.succeed(MapCapture, MapCapture.of({ capture: (_s, path) => Effect.sync(() => writeFileSync(path, "")) })),
    Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.succeed("<!doctype html><html><body></body></html>") })),
    fakeAudioMix().layer,
    convert.layer,
  );
  return { layer, stdout, convert };
}

// play を 1 回流し、セッションのフォルダを返す（標準出力の 1 行目のパスの親）
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
// 見出しの text は前後の空白・改行に依らず比べる
const heading = (b: Block | undefined) => (b?.type === "text" ? b.text?.trim() : undefined);
const imageBytes = (b: Block | undefined) => Buffer.from(b!.source!.data, "base64");

// 時刻（秒）ごとの共有画面の変化。ファイル名は映り始めた時刻から付く
//   0 s1 / 3 なし（end 3 と次の start 4 の間に隙間） / 4 s2 / 8 gallery（顔だけの行も画面） / 12 s4 / 15 s5 / 18 なし / 22 s6 / 26 なし / 33 s7 / 38 なし（最後の行の end の後）
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
  it.effect("共有画面の節が、見出しと画像のブロックとして、マップと発言より前に、時刻順に載る。「なし」は見出しだけ。gallery の行も画像", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const { transcriptPath, tsvPath } = meeting(root, FOUR_REMARKS, ROWS);
      const deps = dependencies(join(root, "sessions"));
      yield* played(deps, [transcriptPath, "--screen", tsvPath]);

      expect(external.created).toHaveLength(1);
      const sent = external.created[0]!.messages;
      expect(sent).toHaveLength(2); // r1+r2 と r3+r4 の 2 回

      // 1 回目: 発言 r2 の start（9.8）までに映り始めた 0・3・4・8 のうち、新しい 3 件（3 なし・4・8 gallery）だけ
      const first = blocksOf(sent[0]!);
      expect(first.map((b) => b.type)).toEqual(["text", "text", "image", "text", "image", "text"]);
      expect(heading(first[0])).toBe("## 共有画面：なし（[00:03] から）");
      expect(heading(first[1])).toBe("## 共有画面 [00:04] から");
      expect(first[2]!.source).toMatchObject({ type: "base64", media_type: "image/jpeg" });
      expect(imageBytes(first[2])).toEqual(Buffer.from(fakeJpegBytes("png:slides/s2.png")));
      expect(heading(first[3])).toBe("## 共有画面 [00:08] から");
      expect(imageBytes(first[4])).toEqual(Buffer.from(fakeJpegBytes("png:slides/gallery.png")));
      // 節はマップと発言（buildPrompt の文字列）より前
      const prompt = first[5]!.text!;
      expect(prompt).toContain("## 現在のマップ");
      expect(prompt).toContain("今日は採用の進め方を決めます");
      expect(prompt).toContain("面接を何回にするかですね");
      expect(prompt).not.toContain("共有画面");

      // 2 回目: 後から映り始めた 12・15・18・22・26 のうち、新しい 3 件（18 なし・22・26 なし）。12・15 は古いので載らない
      const second = blocksOf(sent[1]!);
      expect(second.map((b) => b.type)).toEqual(["text", "text", "image", "text", "text"]);
      expect(heading(second[0])).toBe("## 共有画面：なし（[00:18] から）");
      expect(heading(second[1])).toBe("## 共有画面 [00:22] から");
      expect(imageBytes(second[2])).toEqual(Buffer.from(fakeJpegBytes("png:slides/s6.png")));
      expect(heading(second[3])).toBe("## 共有画面：なし（[00:26] から）");
      // 2 通目はマップの全体の代わりに変更が載る（buildPrompt の中身は変わらない）
      expect(second[4]!.text).toContain("## 前回からのマップの変更");
      expect(second[4]!.text).toContain("2 回にしましょう");
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
      // 発言の流れに混ぜて流すので、screen の行は、その変化を入れた後の発言より前に書かれる（添えたかどうかに関わらず 1 件ずつ）
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

      // diff の入力の要約: 添えた画面だけ（一覧の形は screen の行と同じ { start, image }）
      const diffs = lines.filter((l) => l.type === "diff") as unknown as { input: Record<string, unknown> }[];
      expect(diffs).toHaveLength(2);
      expect(diffs[0]!.input.screens).toEqual([
        { start: 3, image: null },
        { start: 4, image: "0004.0.jpg" },
        { start: 8, image: "0008.0.jpg" },
      ]);
      expect(diffs[1]!.input.screens).toEqual([
        { start: 18, image: null },
        { start: 22, image: "0022.0.jpg" },
        { start: 26, image: null },
      ]);

      // screens/ の画像: 映り始めた時刻から付いた名前で、変化ごとに 1 ファイル（添えなかった画面も書く）
      const files = readdirSync(join(session, "screens")).sort();
      expect(files).toEqual(["0000.0.jpg", "0004.0.jpg", "0008.0.jpg", "0012.0.jpg", "0015.0.jpg", "0022.0.jpg", "0033.0.jpg"]);
      // 送ったものと同じバイト列
      const sent = external.created[0]!.messages;
      const sentFirst = blocksOf(sent[0]!);
      expect(readFileSync(join(session, "screens", "0004.0.jpg"))).toEqual(imageBytes(sentFirst[2]));
      expect(readFileSync(join(session, "screens", "0008.0.jpg"))).toEqual(imageBytes(sentFirst[4]));
      expect(readFileSync(join(session, "screens", "0022.0.jpg"))).toEqual(imageBytes(blocksOf(sent[1]!)[2]));
      // 添えなかった画面も、変換したバイト列がそのまま書かれる
      expect(readFileSync(join(session, "screens", "0033.0.jpg"))).toEqual(Buffer.from(fakeJpegBytes("png:slides/s7.png")));
    }));

  it.effect("変化の無い呼び出しには節が載らず、content は文字列のまま", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      // 最初の呼び出しの前にだけ変化があり、2 回目の呼び出しの前には新しい変化が無い（最後の行の end の後の「なし」は 100 秒で、どの呼び出しにも届かない）
      const { transcriptPath, tsvPath } = meeting(root, FOUR_REMARKS, [[0, 100, "s1", "slides/s1.png"]]);
      const deps = dependencies(join(root, "sessions"));
      const session = yield* played(deps, [transcriptPath, "--screen", tsvPath]);

      const sent = external.created[0]!.messages;
      // 否定のテストなので、2 回目の呼び出しが実際に起きたことを先に確かめる
      expect(sent).toHaveLength(2);
      expect(blocksOf(sent[0]!).map((b) => b.type)).toEqual(["text", "image", "text"]);
      expect(typeof sent[1]!.message.content).toBe("string");
      expect(sent[1]!.message.content).toContain("2 回にしましょう");
      expect(sent[1]!.message.content).not.toContain("共有画面");

      const diffs = logLines(session).filter((l) => l.type === "diff") as unknown as { input: Record<string, unknown> }[];
      expect(diffs).toHaveLength(2);
      expect("screens" in diffs[1]!.input).toBe(false);
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
      expect(section).toMatch(/映り続け/); // 添えた画面は次まで映り続ける
      expect(section).toMatch(/発言の時刻/); // 時刻つきで複数なら発言の時刻のものを使う
      expect(section).toMatch(/顔/); // 顔の一覧だけなら共有画面は無い
    }));

  it.effect("--screen を付けない play は、content が文字列で、screens キーも screen の行も screens/ も無い", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const { transcriptPath } = meeting(root, FOUR_REMARKS, ROWS);
      const deps = dependencies(join(root, "sessions"));
      const session = yield* played(deps, [transcriptPath]);

      const sent = external.created[0]!.messages;
      expect(sent).toHaveLength(2);
      expect(sent.map((m) => typeof m.message.content)).toEqual(["string", "string"]);
      const lines = logLines(session);
      expect(lines.filter((l) => l.type === "diff")).toHaveLength(2);
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

  // 開き直した query の最初のメッセージへの、共有画面の送り直し。
  // 発言 30 個（2 個ずつ 15 回の呼び出し。呼び出し k の区切りは 20k-1 秒）。QUERY_RENEW_CALLS = 14 なので 15 回目は開き直した query の最初のメッセージ。
  // 変化は、映り始めがその呼び出しの 2 つ目の発言の start 以下なら、その呼び出しに添わる（20k-15 秒は呼び出し k）
  const THIRTY_REMARKS = segments(Array.from({ length: 30 }, (_, i): [number, number, string] => [i * 10, i * 10 + 9, `発言${i}`]));
  const textHeadings = (blocks: Block[]) => blocks.filter((b) => b.type === "text").map((b) => b.text!.trim());
  const imagesOf = (blocks: Block[]) => blocks.filter((b) => b.type === "image").map((b) => imageBytes(b));
  const jpeg = (slide: string) => Buffer.from(fakeJpegBytes(`png:slides/${slide}.png`));

  it.effect("14 回ごとに開き直した query の最初のメッセージに、最後に添えた画面とその前の 1 件が、時刻つきで載る", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      // s1 は呼び出し 1、s2 は呼び出し 2、s3 は呼び出し 3 に添わる。その後は 15 回目まで新しい変化が無い
      const { transcriptPath, tsvPath } = meeting(root, THIRTY_REMARKS, [
        [5, 25, "s1", "slides/s1.png"],
        [25, 45, "s2", "slides/s2.png"],
        [45, 1000, "s3", "slides/s3.png"],
      ]);
      const deps = dependencies(join(root, "sessions"));
      const session = yield* played(deps, [transcriptPath, "--screen", tsvPath]);

      expect(external.created).toHaveLength(2);
      expect(external.created[0]!.messages).toHaveLength(14);
      expect(external.created[1]!.messages).toHaveLength(1);
      const reopened = blocksOf(external.created[1]!.messages[0]!);
      expect(reopened.map((b) => b.type)).toEqual(["text", "image", "text", "image", "text"]);
      expect(textHeadings(reopened).slice(0, 2)).toEqual(["## 共有画面 [00:25] から", "## 共有画面 [00:45] から"]);
      expect(imagesOf(reopened)).toEqual([jpeg("s2"), jpeg("s3")]);
      // 最後は buildPrompt の text。開き直しなのでマップは全体
      expect(reopened[4]!.text).toContain("## 現在のマップ");
      // 開き直さなかった 2 通目以降には送り直しが付かない（呼び出し 4〜14 は新しい変化も無いので文字列）
      expect(external.created[0]!.messages.slice(3).map((m) => typeof m.message.content)).toEqual(Array(11).fill("string"));

      // 送り直しはログに残らない: 15 回目の diff に screens は無い
      const diffs = logLines(session).filter((l) => l.type === "diff") as unknown as { input: Record<string, unknown> }[];
      expect(diffs).toHaveLength(15);
      expect("screens" in diffs[14]!.input).toBe(false);
      expect(diffs.some((d) => "previousScreens" in d.input)).toBe(false);
    }));

  it.effect("最後に添えたのが「なし」なら、「なし」とその前の画面が載る。新しく添える画面は別に続き、画像は最大 5 枚", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      // s1 は呼び出し 1、s2 は呼び出し 2、45 秒の「なし」は呼び出し 3。15 回目（区切り 299 秒、14 回目は 279 秒）には s4・s5・s6 が新しく添わる
      const { transcriptPath, tsvPath } = meeting(root, THIRTY_REMARKS, [
        [5, 25, "s1", "slides/s1.png"],
        [25, 45, "s2", "slides/s2.png"],
        [280, 285, "s4", "slides/s4.png"],
        [285, 290, "s5", "slides/s5.png"],
        [290, 400, "s6", "slides/s6.png"],
      ]);
      const deps = dependencies(join(root, "sessions"));
      const session = yield* played(deps, [transcriptPath, "--screen", tsvPath]);

      expect(external.created).toHaveLength(2);
      const reopened = blocksOf(external.created[1]!.messages[0]!);
      expect(textHeadings(reopened).slice(0, -1)).toEqual([
        // 送り直し（その呼び出しより前に最後に添えた 2 件）
        "## 共有画面 [00:25] から",
        "## 共有画面：なし（[00:45] から）",
        // その呼び出しで新しく添える画面
        "## 共有画面 [04:40] から",
        "## 共有画面 [04:45] から",
        "## 共有画面 [04:50] から",
      ]);
      expect(imagesOf(reopened)).toEqual([jpeg("s2"), jpeg("s4"), jpeg("s5"), jpeg("s6")]);
      expect(reopened[reopened.length - 1]!.text).toContain("## 現在のマップ");

      // ログの screens は、その呼び出しで新しく添えた 3 件だけ
      const diffs = logLines(session).filter((l) => l.type === "diff") as unknown as { input: { screens?: unknown } }[];
      expect(diffs[14]!.input.screens).toEqual([
        { start: 280, image: "0280.0.jpg" },
        { start: 285, image: "0285.0.jpg" },
        { start: 290, image: "0290.0.jpg" },
      ]);
    }));

  for (const mode of ["fail", "end"] as const) {
    it.effect(`${mode === "fail" ? "失敗" : "ストリームの終わり"}の後に開いた query の最初のメッセージにも、最後に添えた 2 件が載る（失敗した呼び出しで選んだ画面も数える）`, () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory;
        // 呼び出し 3（0 から数えて 2 通目）が失敗: そこで選んだ「なし」（45 秒）も添えたものに数える。呼び出し 4 が新しい query の最初のメッセージ
        external.behave = (n) => (n === 2 ? mode : "ok");
        const { transcriptPath, tsvPath } = meeting(root, THIRTY_REMARKS, [
          [5, 25, "s1", "slides/s1.png"],
          [25, 45, "s2", "slides/s2.png"],
        ]);
        const deps = dependencies(join(root, "sessions"));
        const session = yield* played(deps, [transcriptPath, "--screen", tsvPath]);

        expect(external.created).toHaveLength(2);
        expect(external.created[0]!.messages).toHaveLength(3);
        expect(external.created[1]!.messages).toHaveLength(12);
        const reopened = blocksOf(external.created[1]!.messages[0]!);
        expect(reopened.map((b) => b.type)).toEqual(["text", "image", "text", "text"]);
        expect(textHeadings(reopened).slice(0, 2)).toEqual(["## 共有画面 [00:25] から", "## 共有画面：なし（[00:45] から）"]);
        expect(imagesOf(reopened)).toEqual([jpeg("s2")]);
        // 同じ query の 2 通目以降には付かない
        expect(typeof external.created[1]!.messages[1]!.message.content).toBe("string");

        // 失敗した回の diff には error が付き、続きも流れる。ログに送り直しは残らない
        const diffs = logLines(session).filter((l) => l.type === "diff") as unknown as { error?: string; input: Record<string, unknown> }[];
        expect(diffs).toHaveLength(15);
        expect(diffs[2]!.error).toBeDefined();
        expect(diffs[2]!.input.screens).toEqual([{ start: 45, image: null }]);
        expect("screens" in diffs[3]!.input).toBe(false);
      }));
  }

  it.effect("送り直すものも新しく添える画面も無い開き直しの最初のメッセージは、content が文字列のまま（共有画面を一度も添えていないとき）", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      external.behave = (n) => (n === 0 ? "fail" : "ok");
      // 画面の変化は 15 回目より後（最後の呼び出しの区切り 299 秒より後）にだけある
      const { transcriptPath, tsvPath } = meeting(root, THIRTY_REMARKS, [[500, 600, "s1", "slides/s1.png"]]);
      const deps = dependencies(join(root, "sessions"));
      yield* played(deps, [transcriptPath, "--screen", tsvPath]);

      expect(external.created).toHaveLength(2);
      expect(typeof external.created[1]!.messages[0]!.message.content).toBe("string");
      expect(external.created.flatMap((c) => c.messages).every((m) => typeof m.message.content === "string")).toBe(true);
    }));
});
