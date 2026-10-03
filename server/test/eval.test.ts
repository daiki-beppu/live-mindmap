// 回帰評価（eval コマンド）。fixture は合成データで、実際の録音サンプルは使わない。
import { copyFile, mkdtemp, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import type { DiffInput, Op } from "../src/core/index.ts";

const fixture = join(import.meta.dirname, "fixtures/short.transcript.json");
// short.transcript.json の発言: r1 [0.5, 9.8] / r2 [9.8, 19.2] / r3 [19.2, 28.0]。差分更新の呼び出しは [r1, r2] と [r3] の 2 回。

// 入れ子のあるマップ（深さ 3）。決定は r1 と r3、TODO は r2 を根拠にする。
const scriptA: Op[][] = [
  [
    { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
    { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: ["r2"] },
    { op: "add", ref: "t3", parent: "t2", kind: "案", text: "1 回で足りる", evidence: ["r2"] },
    { op: "add", ref: "t4", parent: "t1", kind: "TODO", text: "求人票を直す", evidence: ["r2"] },
  ],
  [{ op: "add", ref: "t5", parent: "n2", kind: "決定", text: "2 回にする", evidence: ["r1", "r3"] }],
];

// 浅いマップ（深さ 2）。議題 2、課題 1。
const scriptB: Op[][] = [
  [
    { op: "add", ref: "t1", parent: "root", kind: "議題", text: "予算", evidence: ["r1"] },
    { op: "add", ref: "t2", parent: "root", kind: "議題", text: "日程", evidence: ["r2"] },
    { op: "add", ref: "t3", parent: "t1", kind: "課題", text: "上限が不明", evidence: ["r2"] },
  ],
  [],
];

// play を 1 回流し、ランのフォルダを返す。ランごとにセッションの置き場を分けて、開始時刻の衝突を避ける。
async function play(script: Op[][], file = fixture): Promise<string> {
  const sessionsDir = await mkdtemp(join(tmpdir(), "live-mindmap-run-"));
  let n = 0;
  const updater = async (_input: DiffInput) => ({ ops: script[n++] ?? [] });
  const out: string[] = [];
  await runCli(["play", file], { updater, sessionsDir, stdout: (s) => out.push(s) });
  return dirname(out[0]!.split("\n")[0]!); // play は書き出したファイルのパスを出す（#41）
}

async function evalCli(args: string[]): Promise<string> {
  const out: string[] = [];
  await runCli(["eval", ...args], { stdout: (s) => out.push(s) });
  return out.join("");
}

// Markdown の表を、見出しをキーにした行の配列にする
function parseTable(text: string): { header: string[]; rows: Record<string, string>[] } {
  const lines = text.split("\n").filter((l) => l.trim().startsWith("|"));
  // GFM と同じく `\` とその次の 1 文字を一組として読み、エスケープされていない `|` だけで区切る
  const cells = (l: string) => {
    const inner = l.trim().replace(/^\|/, "").replace(/(?<!\\(?:\\\\)*)\|$/, "");
    const out: string[] = [];
    let cur = "";
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i]!;
      if (ch === "\\" && i + 1 < inner.length) {
        const next = inner[++i]!;
        cur += next === "|" || next === "\\" ? next : ch + next;
      } else if (ch === "|") {
        out.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const [headerLine, separator, ...body] = lines;
  expect(headerLine, "表の見出し行").toBeDefined();
  expect(cells(separator ?? "").every((c) => /^:?-+:?$/.test(c)), "見出しの次は区切り行").toBe(true);
  const header = cells(headerLine!);
  return {
    header,
    rows: body.map((l) => {
      const row = cells(l);
      expect(row, `どの行もセル数が見出しと同じ: ${l}`).toHaveLength(header.length);
      return Object.fromEntries(row.map((c, i) => [header[i]!, c]));
    }),
  };
}

async function writeTruth(truth: unknown): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "live-mindmap-truth-")), "short.truth.json");
  await writeFile(path, typeof truth === "string" ? truth : JSON.stringify(truth));
  return path;
}

describe("eval: ノード数・深さ・種別ごとの数", () => {
  it("ルートを除くノード数、ルートの子を 1 とする深さ、6 種別ごとの数（0 件は 0）を 1 行に出す", async () => {
    const dir = await play(scriptA);
    const { header, rows } = parseTable(await evalCli([dir]));

    expect(header.slice(0, 4)).toEqual(["ラン", "会議", "ノード", "深さ"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ラン: basename(dir),
      会議: "short",
      ノード: "5",
      深さ: "3",
      議題: "1",
      論点: "1",
      案: "1",
      決定: "1",
      課題: "0",
      TODO: "1",
      要点: "0",
    });
  });

  it("種別ごとの数の列に「要点」があり、要点のノードを数える", async () => {
    const scriptPoints: Op[][] = [
      [
        { op: "add", ref: "t1", parent: "root", kind: "議題", text: "ツールの共有", evidence: ["r1"] },
        { op: "add", ref: "t2", parent: "t1", kind: "要点", text: "justの紹介", evidence: ["r2"] },
        { op: "add", ref: "t3", parent: "t1", kind: "要点", text: "辞書は二十語でも効く", evidence: ["r2"] },
      ],
      [{ op: "add", ref: "t4", parent: "n3", kind: "要点", text: "作り方は手作業で十分", evidence: ["r3"] }],
    ];
    const { header, rows } = parseTable(await evalCli([await play(scriptPoints)]));

    expect(header).toContain("要点");
    expect(rows[0]).toMatchObject({ ノード: "4", 議題: "1", 要点: "3", 決定: "0", TODO: "0" });
  });

  it("--truth を付けないときは再現率の列を出さない", async () => {
    const { header } = parseTable(await evalCli([await play(scriptA)]));
    expect(header.some((h) => h.includes("再現率"))).toBe(false);
  });

  it("結果をフォルダに書き足さない（標準出力だけに書く）", async () => {
    const dir = await play(scriptA);
    const before = (await readdir(dir)).sort();
    await evalCli([dir]);
    expect((await readdir(dir)).sort()).toEqual(before);
  });

  it("ノードが無いランは、ノード数 0・深さ 0 になる", async () => {
    const dir = await play([[], []]);
    const { rows } = parseTable(await evalCli([dir]));
    expect(rows[0]).toMatchObject({ ノード: "0", 深さ: "0", 議題: "0", 論点: "0", 案: "0", 決定: "0", 課題: "0", TODO: "0" });
  });

  it("エクスポートの無いフォルダは、フォルダ名を含むエラーで止まる", async () => {
    const empty = await mkdtemp(join(tmpdir(), "live-mindmap-empty-"));
    await expect(evalCli([empty])).rejects.toThrow(empty);
  });
});

describe("eval: 複数のランを並べる", () => {
  it("渡した順に 1 ラン 1 行で並び、行ごとにランの名前・会議の名前・指標が違う", async () => {
    const other = join(await mkdtemp(join(tmpdir(), "live-mindmap-sample-")), "other.transcript.json");
    await copyFile(fixture, other);
    const dirA = await play(scriptA);
    const dirB = await play(scriptB, other);

    const { rows } = parseTable(await evalCli([dirB, dirA]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ラン: basename(dirB), 会議: "other", ノード: "3", 深さ: "2", 議題: "2", 課題: "1", 決定: "0", TODO: "0" });
    expect(rows[1]).toMatchObject({ ラン: basename(dirA), 会議: "short", ノード: "5", 深さ: "3", 議題: "1", 課題: "0", 決定: "1", TODO: "1" });
  });

  it("ランの名前・会議の名前に `|`・`\\`・改行があっても、1 ラン 1 行でセルがずれない", async () => {
    const odd = join(await mkdtemp(join(tmpdir(), "live-mindmap-sample-")), "会議|A\\B\nC.transcript.json");
    await copyFile(fixture, odd);
    const played = await play(scriptA, odd);
    const dirOdd = join(dirname(played), "run|x\\");
    await rename(played, dirOdd);
    const dirB = await play(scriptB);

    const text = await evalCli([dirOdd, dirB]);
    expect(text.split("\n").filter((l) => l.trim() !== "")).toHaveLength(4);
    const { rows } = parseTable(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ラン: basename(dirOdd), 会議: "会議|A\\B C", ノード: "5", 深さ: "3" });
    expect(rows[1]).toMatchObject({ ラン: basename(dirB), 会議: "short", ノード: "3", 深さ: "2" });
  });
});

describe("eval: 正解との再現率", () => {
  // 決定のノードの根拠は r1 [0.5, 9.8] と r3 [19.2, 28.0]、TODO のノードの根拠は r2 [9.8, 19.2]
  const truth = {
    決定: [
      { text: "r3 の中", from: 20, to: 25 }, // 2 つ目の根拠 r3 と重なる
      { text: "r1 の中", from: 1, to: 5 }, // 1 つ目の根拠 r1 と重なる
      { text: "r3 の終わりに接する", from: 28, to: 30 },
      { text: "r3 の始まりに接する", from: 10, to: 19.2 },
      { text: "TODO の根拠とだけ重なる（種別が違う）", from: 10, to: 19 },
      { text: "r3 の終わりの外", from: 28.1, to: 40 },
    ],
    TODO: [
      { text: "r2 の中", from: 10, to: 15 },
      { text: "決定の根拠とだけ重なる（種別が違う）", from: 20, to: 25 },
    ],
  };

  it("根拠の発言のどれか 1 つが正解の区間と重なれば再現できた（端が接するのも重なり）。種別が違うノードは数えない", async () => {
    const dir = await play(scriptA);
    const { header, rows } = parseTable(await evalCli(["--truth", await writeTruth(truth), dir]));

    expect(header.slice(-2)).toEqual(["決定の再現率", "TODO の再現率"]);
    expect(rows[0]).toMatchObject({ 決定の再現率: "4/6 (67%)", "TODO の再現率": "1/2 (50%)" });
  });

  it("正解が 0 件の種別は 0/0 とし、割合は付けない", async () => {
    const dir = await play(scriptA);
    const { rows } = parseTable(await evalCli(["--truth", await writeTruth({ 決定: [{ text: "x", from: 20, to: 25 }], TODO: [] }), dir]));
    expect(rows[0]).toMatchObject({ 決定の再現率: "1/1 (100%)", "TODO の再現率": "0/0" });
  });

  it("AI のノードが無ければ 0 件の再現になる", async () => {
    const dir = await play([[], []]);
    const { rows } = parseTable(await evalCli(["--truth", await writeTruth(truth), dir]));
    expect(rows[0]).toMatchObject({ 決定の再現率: "0/6 (0%)", "TODO の再現率": "0/2 (0%)" });
  });

  it("同じ正解を複数のランに当てて、ランごとの再現率を並べる", async () => {
    const dirA = await play(scriptA);
    const dirEmpty = await play([[], []]);
    const { rows } = parseTable(await evalCli(["--truth", await writeTruth(truth), dirA, dirEmpty]));
    expect(rows.map((r) => r["決定の再現率"])).toEqual(["4/6 (67%)", "0/6 (0%)"]);
  });
});

describe("eval: 正解ファイルの検証", () => {
  const item = { text: "x", from: 1, to: 2 };
  const invalid: [string, unknown][] = [
    ["JSON として読めない", "{ not json"],
    ["オブジェクトでない", []],
    ["決定のキーが無い", { TODO: [item] }],
    ["TODO のキーが無い", { 決定: [item] }],
    ["決定が配列でない", { 決定: item, TODO: [] }],
    ["from が数でない", { 決定: [{ text: "x", from: "1", to: 2 }], TODO: [] }],
    ["to が数でない", { 決定: [], TODO: [{ text: "x", from: 1 }] }],
    ["from が to より大きい", { 決定: [{ text: "x", from: 5, to: 2 }], TODO: [] }],
  ];

  it.each(invalid)("%s正解は、ファイルのパスを含むエラーで止まる", async (_name, bad) => {
    const dir = await play(scriptA);
    const path = await writeTruth(bad);
    await expect(evalCli(["--truth", path, dir])).rejects.toThrow(path);
  });
});
