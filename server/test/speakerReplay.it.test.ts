import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { runScript, temporaryDirectory } from "./benchRun.ts";
import {
  fillLog, logText, minRunLog, offlineLog, overlapLog, remarkLine, restartLog, segLine, settledLine, startLine, textsOf, waitLog, type Line,
} from "./speakerReplayFixtures.ts";

// Issue #1030: bench/speakerReplay.ts の CLI。標準出力は JSON 1 つ（発言・ラベル・混入・つなぎ直し・起動し直し）で、発言の本文を標準出力にも標準エラーにも出さない。

type Output = {
  remarks: Array<{ source: string; track: string; start: number; end: number; speaker?: string }>;
  labels: string[];
  mixed: unknown[];
  links: Array<{ slot: number; result: string; label?: string }>;
  restarts: Array<{ at: number; source: string }>;
};

const privateText = ["REMARKPRIVATEALPHA REMARKPRIVATEOMEGA", "RAWPRIVATEALPHA RAWPRIVATEOMEGA"];
// 本文の目印を持つ短い log（2 人に切れる）。raw にも別の目印を置く
const privateLog = (): Line[] => [
  startLine(0),
  segLine(1, 0, 0, 2), segLine(1, 1, 2, 4), settledLine(2, 4),
  { ...remarkLine(3, "r1", "相手", 0, 4, privateText[0]!, { parts: [[privateText[0]!.slice(0, 10), 0, 2], [privateText[0]!.slice(10), 2, 4]] }), raw: privateText[1]! },
];

function expectNoBody(stdout: string, stderr: string, texts: readonly string[] = privateText) {
  for (const line of [...stdout.split("\n"), ...stderr.split("\n")]) {
    const normalized = line.replace(/\s/g, "").toUpperCase();
    for (const text of texts) {
      for (const fragment of text.split(" ")) expect(normalized).not.toContain(fragment);
    }
  }
}

const speakersOf = (output: Output) => output.remarks.map((r) => r.speaker);

describe("speakerReplay の CLI（light IT）", () => {
  it.effect("セッションフォルダの log.jsonl を流し、発言・ラベル・混入・つなぎ直し・起動し直しの JSON を出し、本文を標準出力にも標準エラーにも出さない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    writeFileSync(join(dir, "log.jsonl"), logText(privateLog()));

    const { code, stdout, stderr } = yield* runScript("speakerReplay.ts", [dir]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    const output = JSON.parse(stdout) as Output;
    expect(output.remarks.map((r) => [r.source, r.track, r.start, r.end, r.speaker])).toEqual([["r1", "相手", 0, 2, "相手 A"], ["r1", "相手", 2, 4, "相手 B"]]);
    expect(output.labels).toEqual(["相手 A", "相手 B"]);
    expect(output.mixed).toEqual([]);
    expect(output.links).toEqual([]);
    expect(output.restarts).toEqual([]);
    for (const r of output.remarks) {
      expect(Object.keys(r).filter((key) => !["source", "track", "start", "end", "speaker"].includes(key))).toEqual([]);
    }
    expectNoBody(stdout, stderr);
  }).pipe(Effect.scoped));

  it.effect("log.jsonl のファイルを直接指定しても同じ結果になる", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const path = join(dir, "log.jsonl");
    writeFileSync(path, logText(privateLog()));

    const fromDir = yield* runScript("speakerReplay.ts", [dir]);
    const fromFile = yield* runScript("speakerReplay.ts", [path]);

    expect(fromFile.code).toBe(0);
    expect(fromFile.stdout).toBe(fromDir.stdout);
  }).pipe(Effect.scoped));

  it.effect("--offline で、arrival つきのオフライン出力（順不同）を arrival の順に流す", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const path = join(dir, "offline.jsonl");
    writeFileSync(path, logText(offlineLog));

    const { code, stdout, stderr } = yield* runScript("speakerReplay.ts", ["--offline", path]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(speakersOf(JSON.parse(stdout) as Output)).toEqual(["相手 A", "相手 B", undefined]);
  }).pipe(Effect.scoped));

  // 旗の名前が、対応する規則に配線されている（unit は同じ fixture で関数を直接呼ぶ）
  const flagCases = [
    { flag: "--without-longest-overlap", name: "最も長い重なり", log: overlapLog, on: ["相手 A", "相手 B", "相手 A"], off: ["相手 A", "相手 B", "相手 B"] },
    { flag: "--without-fill", name: "誰もいない語を寄せる", log: fillLog, on: ["相手 A", "相手 B"], off: ["相手 A", undefined, "相手 B"] },
    { flag: "--without-min-run", name: "0.5 秒の下限", log: minRunLog, on: ["相手 A"], off: ["相手 A", "相手 B", "相手 A"] },
    { flag: "--without-wait", name: "3 秒の待ち", log: waitLog, on: [undefined], off: ["相手 A"] },
  ];
  it.effect.each(flagCases)("$flag は「$name」の規則だけを外し、旗なしとは結果が変わる", ({ flag, log, on, off }) => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const path = join(dir, "log.jsonl");
    writeFileSync(path, logText(log));

    const plain = yield* runScript("speakerReplay.ts", [path]);
    const flagged = yield* runScript("speakerReplay.ts", [flag, path]);

    expect(plain.code).toBe(0);
    expect(flagged.code).toBe(0);
    expect(speakersOf(JSON.parse(plain.stdout) as Output)).toEqual(on);
    expect(speakersOf(JSON.parse(flagged.stdout) as Output)).toEqual(off);
    expectNoBody(flagged.stdout, flagged.stderr, textsOf(log));
  }).pipe(Effect.scoped));

  it.effect("--restart-at <秒> で、その時刻以降の発言が起動し直しを通った話者になり、つなぎ直しと起動し直しの記録が出る", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const path = join(dir, "log.jsonl");
    writeFileSync(path, logText(restartLog));

    const { code, stdout, stderr } = yield* runScript("speakerReplay.ts", ["--restart-at", "10", path]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    const output = JSON.parse(stdout) as Output;
    expect(speakersOf(output)).toEqual(["相手 A", "相手 B", undefined, "相手 A", "相手 C"]);
    expect(output.links.map((l) => [l.slot, l.result])).toEqual([[2, "linked"], [3, "new"]]);
    expect(output.restarts.map((r) => r.source)).toEqual(["flag"]);
    expectNoBody(stdout, stderr, textsOf(restartLog));
  }).pipe(Effect.scoped));

  it.effect.each([
    { name: "不正 JSON", text: `{"remark":"${privateText[0]}",BROKEN}\n`, line: "1 行目" },
    { name: "空行の後にある形が不正な既知の行（空行も数える）", text: `\n\n${logText([startLine(0), { at: "2026-01-01T00:00:01.000Z", type: "remark", remark: { id: "r1", track: "invalid", start: 0, end: 1, text: privateText[0]! }, raw: privateText[1]! }])}`, line: "4 行目" },
    { name: "形が不正な既知の行", text: logText([startLine(0), { at: "2026-01-01T00:00:01.000Z", type: "remark", remark: { id: "r1", track: "invalid", start: 0, end: 1, text: privateText[0]! }, raw: privateText[1]! }]), line: "2 行目" },
  ])("$name の log は非ゼロ終了し、診断に行番号を持ち、本文を出さない", ({ text, line }) => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const path = join(dir, "log.jsonl");
    writeFileSync(path, text);

    const { code, stdout, stderr } = yield* runScript("speakerReplay.ts", [dir]);

    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain(path);
    expect(stderr).toContain(line);
    expectNoBody(stdout, stderr);
  }).pipe(Effect.scoped));

  it.effect("壊れた --offline の行も非ゼロ終了し、診断に本文を出さない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const path = join(dir, "offline.jsonl");
    writeFileSync(path, logText([{ arrival: 0, type: "remark", track: "invalid", start: 0, end: 1, text: privateText[0]!, duplicate: false }]));

    const { code, stdout, stderr } = yield* runScript("speakerReplay.ts", ["--offline", path]);

    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain(path);
    expectNoBody(stdout, stderr);
  }).pipe(Effect.scoped));

  it.effect("空行の後にある壊れた --offline の行は、空行も数えた行番号で診断し、本文を出さない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const path = join(dir, "offline.jsonl");
    writeFileSync(path, `\n${logText([{ arrival: 0, type: "remark", track: "invalid", start: 0, end: 1, text: privateText[0]!, duplicate: false }])}`);

    const { code, stdout, stderr } = yield* runScript("speakerReplay.ts", ["--offline", path]);

    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain(path);
    expect(stderr).toContain("2 行目");
    expectNoBody(stdout, stderr);
  }).pipe(Effect.scoped));

  it.effect("セッションフォルダが無いと非ゼロ終了し、パスを診断に出す", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const missing = join(root, "missing");

    const { code, stdout, stderr } = yield* runScript("speakerReplay.ts", [missing]);

    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain(missing);
  }).pipe(Effect.scoped));

  it.effect("log.jsonl が通常ファイルでなければ非ゼロ終了する", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const path = join(dir, "log.jsonl");
    mkdirSync(path);

    const { code, stdout, stderr } = yield* runScript("speakerReplay.ts", [dir]);

    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain(path);
  }).pipe(Effect.scoped));
});
