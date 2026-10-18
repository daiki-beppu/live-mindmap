import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { runScript, temporaryDirectory } from "./benchRun.ts";
import { logText, type Line } from "./speakerReplayFixtures.ts";

// Issue #1031: bench/speakerAccuracy.ts の CLI（light IT）。
// 呼び方: node bench/speakerAccuracy.ts --self <話者> [--without-* の旗] <timeline.tsv> <events.jsonl>
// events.jsonl は `stt-bench run --events` の出力（届いた時刻 arrival つき）。speakerReplay --offline の経路で中核に通して採点する。
// 標準出力は Markdown の表 1 つ（見出し + 1 行）。割合の列は百分率（66.7% のように）、数の列は整数。
// 列（見出しの先頭の語）: 正解・取り違え・話者なし・DER・仮→確定 / 規則の効き目: 切った・3秒で話者なし・切れなかった。発言の本文は出さない

const BODY = ["TIMELINESECRETALPHA", "EVENTSSECRETBETA", "EVENTSSECRETGAMMA", "EVENTSSECRETDELTA", "SELFSECRETOMEGA"];

const timelineText = (rows: ReadonlyArray<readonly [string, number, number, string]>) =>
  ["#MARK\tslide:a\t2.50", ...rows.map(([speaker, start, end, text]) => `${speaker}\t${start.toFixed(2)}\t${end.toFixed(2)}\t${text}`)].join("\n") + "\n";

type Part = readonly [text: string, start: number, end: number];
const wordTimes = (parts: readonly Part[]) => {
  let location = 0;
  return parts.map(([text, start, end]) => {
    const word = { location, length: text.length, start, end };
    location += text.length;
    return word;
  });
};

const remark = (arrival: number, track: "相手" | "自分", start: number, end: number, text: string, parts?: readonly Part[]): Line => ({
  arrival, type: "remark", track, start, end, text, duplicate: false, ...(parts === undefined ? {} : { wordTimes: wordTimes(parts) }),
});
const segment = (arrival: number, slot: number, start: number, end: number, final = true): Line => ({ arrival, type: "speaker", track: "相手", start, end, slot, final });
const settled = (arrival: number, to: number): Line => ({ arrival, type: "speaker-settled", track: "相手", to });

// 相手 2 人が 1 発言ずつ話し、すべて正解。1 件目は、1 つ前の更新の後の字幕で枠 1 が先に現れていて、枠 0 の仮のラベルは 相手 B と予想されるが、発言には 相手 A が振られる（替わる）。2 件目は、枠 1 の仮のラベルも発言のラベルも 相手 B（替わらない）
const basicTimeline = timelineText([["森川", 0, 2, BODY[4]!], ["甲", 3, 5, BODY[0]!], ["乙", 6, 8, BODY[0]!]]);
const basicEvents: Line[] = [
  remark(3, "自分", 0, 2, BODY[4]!),
  segment(4, 1, 3, 5, false), settled(4.1, 3),
  segment(5, 0, 3, 5), settled(5.1, 5),
  remark(6, "相手", 3, 5, BODY[1]!),
  segment(8, 1, 6, 8), settled(8.1, 8),
  remark(9, "相手", 6, 8, BODY[2]!),
];

// 1 つの発言 [0,4] の途中の語 [2,3] は、どの区間とも重ならない。旗なしでは前の枠に寄せて 2 断片、寄せる規則を外すと 3 断片（途中の断片は話者なし）
const fillTimeline = timelineText([["森川", 20, 21, BODY[4]!], ["甲", 0, 3, BODY[0]!], ["乙", 3, 4, BODY[0]!]]);
const fillEvents: Line[] = [
  segment(2, 0, 0, 2), segment(2, 1, 3, 4), settled(2.1, 4),
  remark(3, "相手", 0, 4, BODY[1]! + BODY[2]! + BODY[3]!, [[BODY[1]!, 0, 2], [BODY[2]!, 2, 3], [BODY[3]!, 3, 4]]),
];

// 正解では甲 [10,12.5]・乙 [12.5,14] にまたがる発言を、ダイアライザが 1 つの枠にまとめた（切れない）
const unsplitTimeline = timelineText([["森川", 30, 31, BODY[4]!], ["甲", 10, 12.5, BODY[0]!], ["乙", 12.5, 14, BODY[0]!]]);
const unsplitEvents: Line[] = [
  segment(2, 0, 10, 14), settled(2.1, 14),
  remark(3, "相手", 10, 14, BODY[1]!),
];

type Table = { header: string[]; row: string[] };
function parseTable(stdout: string): Table {
  const rows = stdout.split("\n").filter((line) => line.trim().startsWith("|")).map((line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
  const body = rows.filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)));
  expect(body).toHaveLength(2);
  return { header: body[0]!, row: body[1]! };
}
const cell = (table: Table, name: string): number => {
  const index = table.header.findIndex((h) => h.startsWith(name));
  expect(index, `列 ${name}`).toBeGreaterThanOrEqual(0);
  return Number.parseFloat(table.row[index]!);
};

function expectNoBody(stdout: string, stderr: string) {
  for (const body of BODY) {
    expect(stdout).not.toContain(body);
    expect(stderr).not.toContain(body);
  }
  // 標準出力は表の行だけで、セルは百分率・n/a・整数・見出しの語・区切りのどれか（本文の断片が混ざれば外れる）
  const known = /^(\d+(\.\d+)?%|n\/a|\d+|-+|発言数|正解|取り違え|話者なし|採点対象外|DER|仮→確定|切った|3秒で話者なし|切れなかった)$/;
  for (const line of stdout.split("\n").filter((l) => l.trim() !== "")) {
    expect(line.trim().startsWith("|") && line.trim().endsWith("|"), "表の行").toBe(true);
    for (const c of line.trim().replace(/^\||\|$/g, "").split("|").map((x) => x.trim())) expect(c).toMatch(known);
  }
}

const setup = (timeline: string, events: readonly Line[]) => Effect.gen(function* () {
  const dir = yield* temporaryDirectory;
  const timelinePath = join(dir, "timeline.tsv");
  const eventsPath = join(dir, "events.jsonl");
  writeFileSync(timelinePath, timeline);
  writeFileSync(eventsPath, logText(events));
  return { timelinePath, eventsPath };
});

describe("speakerAccuracy の CLI（light IT）", () => {
  it.effect("--self の行を除いた台本と、オフライン出力を採点し、正解・取り違え・話者なし・DER・仮→確定・規則の効き目の表を 1 つ出し、本文を出さない", () => Effect.gen(function* () {
    const { timelinePath, eventsPath } = yield* setup(basicTimeline, basicEvents);

    const { code, stdout, stderr } = yield* runScript("speakerAccuracy.ts", ["--self", "森川", timelinePath, eventsPath]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    const table = parseTable(stdout);
    expect([cell(table, "正解"), cell(table, "取り違え"), cell(table, "話者なし")]).toEqual([100, 0, 0]);
    // 参照に --self の行が入っていれば、仮説に無い 2 秒が取りこぼしになり 0 にならない
    expect(cell(table, "DER")).toBeCloseTo(0, 0);
    expect(cell(table, "仮→確定")).toBeCloseTo(50, 0);
    expect([cell(table, "切った"), cell(table, "3秒で話者なし"), cell(table, "切れなかった")]).toEqual([0, 0, 0]);
    expectNoBody(stdout, stderr);
  }).pipe(Effect.scoped));

  it.effect("規則の効き目は 0 のときも列を出し、旗なしでは「切った」が数えられる（2 人に切る）。DER は枠の確定区間の物差しで、旗に左右されない", () => Effect.gen(function* () {
    const { timelinePath, eventsPath } = yield* setup(fillTimeline, fillEvents);

    const { code, stdout, stderr } = yield* runScript("speakerAccuracy.ts", ["--self", "森川", timelinePath, eventsPath]);

    expect(code).toBe(0);
    const table = parseTable(stdout);
    expect([cell(table, "正解"), cell(table, "取り違え"), cell(table, "話者なし")]).toEqual([100, 0, 0]);
    expect([cell(table, "切った"), cell(table, "3秒で話者なし"), cell(table, "切れなかった")]).toEqual([1, 0, 0]);
    // 参照 4 秒 − collar 1.0 秒 = 3 秒のうち、確定区間が無い [2,2.75] の 0.75 秒が取りこぼし
    expect(cell(table, "DER")).toBeCloseTo(25, 0);
    expectNoBody(stdout, stderr);
  }).pipe(Effect.scoped));

  it.effect("--without-fill は寄せる規則だけを外す: 断片が 3 つになって切った数が 2、途中の断片が話者なしになり、DER は変わらない", () => Effect.gen(function* () {
    const { timelinePath, eventsPath } = yield* setup(fillTimeline, fillEvents);

    const plain = yield* runScript("speakerAccuracy.ts", ["--self", "森川", timelinePath, eventsPath]);
    const flagged = yield* runScript("speakerAccuracy.ts", ["--self", "森川", "--without-fill", timelinePath, eventsPath]);

    expect(flagged.code).toBe(0);
    const before = parseTable(plain.stdout);
    const after = parseTable(flagged.stdout);
    expect([cell(after, "正解"), cell(after, "取り違え"), cell(after, "話者なし")].map((x) => Math.round(x))).toEqual([67, 0, 33]);
    expect(cell(after, "切った")).toBe(2);
    expect(cell(after, "DER")).toBeCloseTo(cell(before, "DER"), 5);
    expectNoBody(flagged.stdout, flagged.stderr);
  }).pipe(Effect.scoped));

  it.effect("正解では 2 人にまたがるのに 1 断片のまま出た発言を、切れなかった発言として数える（切った数は 0）", () => Effect.gen(function* () {
    const { timelinePath, eventsPath } = yield* setup(unsplitTimeline, unsplitEvents);

    const { code, stdout, stderr } = yield* runScript("speakerAccuracy.ts", ["--self", "森川", timelinePath, eventsPath]);

    expect(code).toBe(0);
    const table = parseTable(stdout);
    expect([cell(table, "切った"), cell(table, "切れなかった")]).toEqual([0, 1]);
    // 長く重なる甲が正解の人
    expect(cell(table, "正解")).toBe(100);
    expectNoBody(stdout, stderr);
  }).pipe(Effect.scoped));

  it.effect("3 秒の待ちを外す旗 --without-wait が中核に届く（時間切れの話者なし 1 → 0）", () => Effect.gen(function* () {
    // 確定結果 [3,5] の後に時計が 3 秒進み（自分の途中結果）、区間が届く前に時間切れで話者なしになる
    const events: Line[] = [
      remark(1, "相手", 3, 5, BODY[1]!),
      { arrival: 2, type: "partial", track: "自分", start: 10, end: 11, text: "", duplicate: false },
      segment(3, 0, 3, 5), settled(3, 5),
    ];
    const { timelinePath, eventsPath } = yield* setup(basicTimeline, events);

    const plain = yield* runScript("speakerAccuracy.ts", ["--self", "森川", timelinePath, eventsPath]);
    const flagged = yield* runScript("speakerAccuracy.ts", ["--self", "森川", "--without-wait", timelinePath, eventsPath]);

    expect(plain.code).toBe(0);
    expect(flagged.code).toBe(0);
    const before = parseTable(plain.stdout);
    const after = parseTable(flagged.stdout);
    expect([cell(before, "3秒で話者なし"), cell(before, "話者なし")]).toEqual([1, 100]);
    expect([cell(after, "3秒で話者なし"), cell(after, "正解")]).toEqual([0, 100]);
  }).pipe(Effect.scoped));

  it.effect("--self が台本に無い話者だと非ゼロ終了し、台本の本文を出さない", () => Effect.gen(function* () {
    const { timelinePath, eventsPath } = yield* setup(basicTimeline, basicEvents);

    const { code, stdout, stderr } = yield* runScript("speakerAccuracy.ts", ["--self", "いない人", timelinePath, eventsPath]);

    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expectNoBody(stdout, stderr);
  }).pipe(Effect.scoped));

  it.effect("壊れた events の行は非ゼロ終了し、診断に行番号を持ち、行の原文（本文）を出さない", () => Effect.gen(function* () {
    const { timelinePath, eventsPath } = yield* setup(basicTimeline, basicEvents);
    writeFileSync(eventsPath, `${logText(basicEvents.slice(0, 1))}{"text":"${BODY[1]}",BROKEN}\n`);

    const { code, stdout, stderr } = yield* runScript("speakerAccuracy.ts", ["--self", "森川", timelinePath, eventsPath]);

    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("2 行目");
    expectNoBody(stdout, stderr);
  }).pipe(Effect.scoped));

  it.effect("events のファイルが無いと非ゼロ終了し、パスを診断に出す", () => Effect.gen(function* () {
    const { timelinePath, eventsPath } = yield* setup(basicTimeline, basicEvents);
    const missing = `${eventsPath}.missing`;

    const { code, stdout, stderr } = yield* runScript("speakerAccuracy.ts", ["--self", "森川", timelinePath, missing]);

    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain(missing);
  }).pipe(Effect.scoped));
});
