import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { type LogEvent } from "../src/core/index.ts";
import { runScript, temporaryDirectory } from "./benchRun.ts";

const privateText = ["TITLEPRIVATEALPHA TITLEPRIVATEOMEGA", "REMARKPRIVATEALPHA REMARKPRIVATEOMEGA", "NODEPRIVATEALPHA NODEPRIVATEOMEGA"];
const log = (): LogEvent[] => [
  { type: "start", title: privateText[0]! },
  { type: "remark", remark: { id: "r1", track: "相手", start: 0, end: 90, text: privateText[1]! } },
  { type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0 }, dropped: [], ops: [
    { op: "add", ref: "t", parent: "root", kind: "議題", text: privateText[2]!, evidence: ["r1"] },
    { op: "add", ref: "p", parent: "t", kind: "論点", text: privateText[2]!, evidence: ["r1"] },
    { op: "add", ref: "a", parent: "p", kind: "案", text: privateText[2]!, evidence: ["r1"] },
  ] },
];
const logText = (events: readonly unknown[]) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const cells = (line: string) => line.split("|").slice(1, -1).map((cell) => cell.trim());
const tableLines = (stdout: string) => stdout.split("\n").filter((line) => line.startsWith("|"));

function expectNoBody(stdout: string, stderr: string) {
  for (const line of [...stdout.split("\n"), ...stderr.split("\n")]) {
    const normalized = line.replace(/\s/g, "").toUpperCase();
    for (const text of privateText) {
      for (const fragment of text.split(" ")) expect(normalized).not.toContain(fragment);
    }
  }
}

describe("mapShape の CLI（light IT）", () => {
  it.effect("複数のセッションフォルダから、本文を含まない形の Markdown 表を出す", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const a = join(root, "run-a");
    const b = join(root, "run-b");
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, "log.jsonl"), logText(log()));
    writeFileSync(join(b, "log.jsonl"), logText(log().slice(0, 2)));

    const { code, stdout, stderr } = yield* runScript("mapShape.ts", [a, b]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    const lines = tableLines(stdout);
    expect(lines).toHaveLength(4);
    expect(cells(lines[0]!)).toEqual(["セッション", "分", "ノード", "議題（入れ子）", "議題/時", "最大の議題", "最大のまとまり", "派生の論点", "子が 1 つ", "鎖の最長", "同じ種別の鎖の最長", "最大の深さ", "子の数の分布（0/1/2/3/4/5/6+）"]);
    const first = cells(lines[2]!);
    const second = cells(lines[3]!);
    expect(first[0]).toMatch(/run-a$/);
    expect(first.slice(1)).toEqual(["2", "4", "1（0）", "40.0", "1", "1", "0", "3（75%）", "3", "0", "3", "1/3/0/0/0/0/0"]);
    expect(second[0]).toMatch(/run-b$/);
    expect(second.slice(1)).toEqual(["2", "1", "0（0）", "0.0", "0", "0", "0", "0（0%）", "0", "0", "0", "1/0/0/0/0/0/0"]);
    expectNoBody(stdout, stderr);
  }).pipe(Effect.scoped));

  it.effect.each([
    { name: "不正 JSON", text: `{"text":"${privateText[2]}",BROKEN}\n` },
    { name: "形が不正な既知イベント", text: logText([{ type: "start", title: privateText[0]! }, { type: "remark", remark: { id: "r1", track: "invalid", start: 0, end: 1, text: privateText[1]! } }]) },
    { name: "復元できない発言参照", text: logText([{ type: "start", title: privateText[0]! }, { type: "diff", input: { recent: [], fresh: [privateText[1]!], nodeCount: 0 }, ops: [], dropped: [] }]) },
  ])("$name で非ゼロ終了し、本文を診断にも出さない", ({ text }) => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const path = join(dir, "log.jsonl");
    writeFileSync(path, text);

    const { code, stdout, stderr } = yield* runScript("mapShape.ts", [dir]);

    expect(code).not.toBe(0);
    expect(stderr).not.toBe("");
    expect(stderr).toContain(path);
    expect(tableLines(stdout).slice(2)).toEqual([]);
    expectNoBody(stdout, stderr);
  }).pipe(Effect.scoped));

  it.effect("セッションフォルダが無いと非ゼロ終了する", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const missing = join(root, "missing");

    const { code, stdout, stderr } = yield* runScript("mapShape.ts", [missing]);

    expect(code).not.toBe(0);
    expect(stderr).toContain(missing);
    expect(tableLines(stdout).slice(2)).toEqual([]);
  }).pipe(Effect.scoped));

  it.effect("log.jsonl が通常ファイルでなければ非ゼロ終了する", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const path = join(dir, "log.jsonl");
    mkdirSync(path);

    const { code, stdout, stderr } = yield* runScript("mapShape.ts", [dir]);

    expect(code).not.toBe(0);
    expect(stderr).toContain(path);
    expect(tableLines(stdout).slice(2)).toEqual([]);
  }).pipe(Effect.scoped));
});
