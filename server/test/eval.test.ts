// 回帰評価（eval コマンド）。fixture は合成データで、実際の録音サンプルは使わない。
import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import { type DiffInput, type Op, parseTruth } from "../src/core/index.ts";

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

describe("eval: 正解との再現率（時刻の重なり）", () => {
  // 決定のノード「2 回にする」の根拠は r1 [0.5, 9.8] と r3 [19.2, 28.0]、TODO のノード「求人票を直す」の根拠は r2 [9.8, 19.2]。
  // 1 つのノードは正解 1 件にしか当たらないので、正解は 1 件ずつ評価する。
  const decision = ["2回"];
  const todo = ["求人票"];
  const overlap: [string, "決定" | "TODO", number, number, string[], string][] = [
    ["2 つ目の根拠 r3 の中", "決定", 20, 25, decision, "1/1 (100%)"],
    ["1 つ目の根拠 r1 の中", "決定", 1, 5, decision, "1/1 (100%)"],
    ["r3 の終わりに接する", "決定", 28, 30, decision, "1/1 (100%)"],
    ["r3 の始まりに接する", "決定", 10, 19.2, decision, "1/1 (100%)"],
    ["TODO の根拠とだけ重なる（種別が違う）", "決定", 10, 19, todo, "0/1 (0%)"],
    ["r3 の終わりの外", "決定", 28.1, 40, decision, "0/1 (0%)"],
    ["r2 の中", "TODO", 10, 15, todo, "1/1 (100%)"],
    ["決定の根拠とだけ重なる（種別が違う）", "TODO", 20, 25, decision, "0/1 (0%)"],
  ];

  it.each(overlap)("%s", async (_name, kind, from, to, keywords, expected) => {
    const dir = await play(scriptA);
    const truth = { 決定: [], TODO: [], [kind]: [{ text: "x", from, to, keywords }] };
    const { header, rows } = parseTable(await evalCli(["--truth", await writeTruth(truth), dir]));

    expect(header.slice(-2)).toEqual(["決定の再現率", "TODO の再現率"]);
    expect(rows[0]![kind === "決定" ? "決定の再現率" : "TODO の再現率"]).toBe(expected);
  });

  it("正解が 0 件の種別は 0/0 とし、割合は付けない", async () => {
    const dir = await play(scriptA);
    const truth = { 決定: [{ text: "x", from: 20, to: 25, keywords: decision }], TODO: [] };
    const { rows } = parseTable(await evalCli(["--truth", await writeTruth(truth), dir]));
    expect(rows[0]).toMatchObject({ 決定の再現率: "1/1 (100%)", "TODO の再現率": "0/0" });
  });

  const both = {
    決定: [{ text: "x", from: 20, to: 25, keywords: decision }],
    TODO: [{ text: "y", from: 10, to: 15, keywords: todo }],
  };

  it("AI のノードが無ければ 0 件の再現になる", async () => {
    const dir = await play([[], []]);
    const { rows } = parseTable(await evalCli(["--truth", await writeTruth(both), dir]));
    expect(rows[0]).toMatchObject({ 決定の再現率: "0/1 (0%)", "TODO の再現率": "0/1 (0%)" });
  });

  it("同じ正解を複数のランに当てて、ランごとの再現率を並べる", async () => {
    const dirA = await play(scriptA);
    const dirEmpty = await play([[], []]);
    const { rows } = parseTable(await evalCli(["--truth", await writeTruth(both), dirA, dirEmpty]));
    expect(rows.map((r) => r["決定の再現率"])).toEqual(["1/1 (100%)", "0/1 (0%)"]);
    expect(rows.map((r) => r["TODO の再現率"])).toEqual(["1/1 (100%)", "0/1 (0%)"]);
  });
});

describe("eval: 正解との再現率（キーワード）", () => {
  // 決定の親は論点に限る。議題と論点を 1 回目で作り、決定は 2 回目で足す（r3 は 2 回目から根拠に使える。論点は scriptA と同じく n2）
  const base: Op[] = [
    { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
    { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: ["r2"] },
  ];
  const decisionNodes = (...nodes: { text: string; evidence?: string[] }[]): Op[][] => [
    base,
    nodes.map(({ text, evidence = ["r1"] }, i): Op => ({ op: "add", ref: `d${i}`, parent: "n2", kind: "決定", text, evidence })),
  ];
  const decisionNode = (text: string, evidence?: string[]) => decisionNodes({ text, evidence });
  // 決定の再現率の列だけを返す
  const decisionRecall = async (script: Op[][], items: { from: number; to: number; keywords: unknown }[]) => {
    const truth = { 決定: items.map((i) => ({ text: "x", ...i })), TODO: [] };
    const { rows } = parseTable(await evalCli(["--truth", await writeTruth(truth), await play(script)]));
    return rows[0]!["決定の再現率"];
  };

  it("時刻が重なっても、キーワードを含まないノードは正解として数えない（含む正解は当たる）", async () => {
    const script = decisionNode("面接は 2 回にする");
    expect(await decisionRecall(script, [{ from: 1, to: 5, keywords: ["2回"] }])).toBe("1/1 (100%)");
    expect(await decisionRecall(script, [{ from: 1, to: 5, keywords: ["3回"] }])).toBe("0/1 (0%)");
  });

  it("keywords の要素すべてが本文に含まれて初めて当たる（1 つ欠ければ外れる）", async () => {
    const script = decisionNode("面接は 2 回にする");
    expect(await decisionRecall(script, [{ from: 1, to: 5, keywords: ["面接", "2回"] }])).toBe("1/1 (100%)");
    expect(await decisionRecall(script, [{ from: 1, to: 5, keywords: ["面接", "3回"] }])).toBe("0/1 (0%)");
  });

  it("1 つのノードは、区間が重なる 2 件の正解のうち 1 件にしか当たらない", async () => {
    const script = decisionNode("予算の上限を決める", ["r1", "r3"]);
    const items = [
      { from: 1, to: 5, keywords: ["予算"] },
      { from: 20, to: 25, keywords: ["上限"] },
    ];
    expect(await decisionRecall(script, items)).toBe("1/2 (50%)");
  });

  it("当てられる組み合わせが複数あるときは、当たる件数が最大になる割り当てを選ぶ（先頭から貪欲に当てると 1 件になる例）", async () => {
    // N1「予算」「上限」を含む / N2「予算」だけ。T1「予算」は N1・N2 に、T2「上限」は N1 にだけ当たる。
    // T1 を先に N1 へ当てると T2 が余る。T1→N2、T2→N1 なら 2 件。
    const script = decisionNodes({ text: "予算の上限を決める" }, { text: "予算は据え置く" });
    const items = [
      { from: 1, to: 5, keywords: ["予算"] },
      { from: 1, to: 5, keywords: ["上限"] },
    ];
    expect(await decisionRecall(script, items)).toBe("2/2 (100%)");
  });

  it("言い換えの候補（配列の要素）のどれか 1 つで当たる", async () => {
    const keywords = ["切り替え", ["二月末", "2月末"]];
    expect(await decisionRecall(decisionNode("切り替えは2月末にする"), [{ from: 1, to: 5, keywords }])).toBe("1/1 (100%)");
    expect(await decisionRecall(decisionNode("切り替えは二月末にする"), [{ from: 1, to: 5, keywords }])).toBe("1/1 (100%)");
  });

  it("どの候補も含まれなければ外れる", async () => {
    const keywords = ["切り替え", ["三月末", "3月末"]];
    expect(await decisionRecall(decisionNode("切り替えは2月末にする"), [{ from: 1, to: 5, keywords }])).toBe("0/1 (0%)");
  });

  it("全角・半角と空白の違いで外れない（本文の側でもキーワードの側でも）", async () => {
    expect(await decisionRecall(decisionNode("切り替えは ２ 月末"), [{ from: 1, to: 5, keywords: ["切り替え", "2月末"] }])).toBe("1/1 (100%)");
    expect(await decisionRecall(decisionNode("切り替えは2月末"), [{ from: 1, to: 5, keywords: ["切り 替え", "２月末"] }])).toBe("1/1 (100%)");
    expect(await decisionRecall(decisionNode("製品はＡ社にする"), [{ from: 1, to: 5, keywords: ["A社"] }])).toBe("1/1 (100%)");
    expect(await decisionRecall(decisionNode("製品はA社にする"), [{ from: 1, to: 5, keywords: ["Ａ　社"] }])).toBe("1/1 (100%)");
  });

  it("漢数字と算用数字は読み替えない", async () => {
    expect(await decisionRecall(decisionNode("切り替えは二月末にする"), [{ from: 1, to: 5, keywords: ["2月末"] }])).toBe("0/1 (0%)");
  });
});

describe("eval: 正解ファイルの検証", () => {
  const item = { text: "x", from: 1, to: 2, keywords: ["x"] };
  const invalid: [string, unknown][] = [
    ["JSON として読めない", "{ not json"],
    ["オブジェクトでない", []],
    ["決定のキーが無い", { TODO: [item] }],
    ["TODO のキーが無い", { 決定: [item] }],
    ["決定が配列でない", { 決定: item, TODO: [] }],
    ["from が数でない", { 決定: [{ ...item, from: "1" }], TODO: [] }],
    ["to が数でない", { 決定: [], TODO: [{ text: "x", from: 1, keywords: ["x"] }] }],
    ["from が to より大きい", { 決定: [{ ...item, from: 5, to: 2 }], TODO: [] }],
    ["keywords が無い", { 決定: [{ text: "x", from: 1, to: 2 }], TODO: [] }],
    ["keywords が空", { 決定: [{ ...item, keywords: [] }], TODO: [] }],
    ["keywords が配列でなく文字列", { 決定: [{ ...item, keywords: "x" }], TODO: [] }],
    ["keywords の要素が数", { 決定: [{ ...item, keywords: [1] }], TODO: [] }],
    ["keywords の配列の中身が数", { 決定: [{ ...item, keywords: [["a", 1]] }], TODO: [] }],
    ["keywords の要素が空の配列", { 決定: [{ ...item, keywords: [[]] }], TODO: [] }],
    ["keywords の要素が空文字", { 決定: [{ ...item, keywords: [""] }], TODO: [] }],
    ["keywords の要素が空白だけ", { 決定: [{ ...item, keywords: [" \u3000"] }], TODO: [] }],
  ];

  it.each(invalid)("%s正解は、ファイルのパスを含むエラーで止まる", async (_name, bad) => {
    const dir = await play(scriptA);
    const path = await writeTruth(bad);
    await expect(evalCli(["--truth", path, dir])).rejects.toThrow(path);
  });

  it("エラーは、どの種別の何件目かを含む", async () => {
    const dir = await play(scriptA);
    const path = await writeTruth({ 決定: [], TODO: [item, { text: "y", from: 1, to: 2 }] });
    await expect(evalCli(["--truth", path, dir])).rejects.toThrow("「TODO」の 2 件目");
  });
});

describe("eval: bench の正解ファイル", () => {
  const meetings = join(import.meta.dirname, "../bench/meetings");
  it.each(["deciding", "long", "sharing"])("%s.truth.json は、全件に keywords があり parseTruth を通る", (name) => {
    expect(() => parseTruth(JSON.parse(readFileSync(join(meetings, `${name}.truth.json`), "utf8")))).not.toThrow();
  });
});
