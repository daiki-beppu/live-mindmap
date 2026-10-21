import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { command } from "../bench/peopleAccuracy.ts";
import { reportFailure } from "../bench/entry.ts";
import { consoleCapture, runCommand, taggedFailure, temporaryDirectory } from "./benchRun.ts";

const metrics = ["案 再現", "出した人 合う", "出した人 人なし", "TODO 再現", "担当 合う", "担当 人なし", "誤った名前", "名前 付いたラベル", "名前 正しい", "名前まで"];
const assertRowValues = (row: string[], header: string[]) => {
  expect(row).toHaveLength(header.length);
  for (const [i, value] of row.entries()) {
    if (metrics.includes(header[i]!)) expect(value).toMatch(/^(?:\d+(?:\.\d+)?%?|\d+\/\d+(?: \(\d+(?:\.\d+)?%\))?|n\/a|—)$/);
    else expect(value).toMatch(/^(?:first|second)$/);
  }
};

describe("人の採点CLI", () => {
  it.effect.each(["truth.json", "export.json", "log.jsonl"])("不正な %s を本文なしの診断で拒否し、表を出さない", (badFile) => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const timeline = join(dir, "timeline.tsv");
    const truth = join(dir, "truth.json");
    writeFileSync(timeline, "司会\t0\t1\t開始\n");
    writeFileSync(truth, JSON.stringify({ 決定: [], TODO: [] }));
    writeFileSync(join(dir, "export.json"), JSON.stringify({ root: { id: "root", kind: "会議", text: "会議", evidence: [], children: [] } }));
    writeFileSync(join(dir, "log.jsonl"), JSON.stringify({ type: "start" }) + "\n");
    const secret = "PRIVATEINPUTBODY";
    const bad = badFile === "log.jsonl"
      ? { type: "remark", remark: { text: secret }, at: "not-a-time" }
      : { text: secret };
    const badPath = join(dir, badFile);
    writeFileSync(badPath, JSON.stringify(bad));
    const { result, stdout } = yield* runCommand(command, ["--self", "司会", timeline, truth, dir]);
    const failure = taggedFailure(result);
    expect(failure).toMatchObject({ _tag: "InvalidInputFile", path: badPath });
    expect(stdout).toBe("");
    const capture = consoleCapture();
    yield* reportFailure(Cause.fail(failure)).pipe(Effect.provide(capture.layer));
    expect(capture.stderr).toHaveLength(1);
    expect(capture.stderr[0]).toContain(badPath);
    expect(capture.stderr[0]).not.toContain(secret);
  }).pipe(Effect.scoped));

  it.effect("二つの保存済みセッションを別々に採点し、数値の表だけを出す", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const timelinePath = join(dir, "timeline.tsv");
    const truthPath = join(dir, "truth.json");
    const secrets = ["TIMELINESECRETBODY", "TRUTHSECRETBODY", "REMARKSECRETBODY", "EXPORTSECRETBODY", "TITLESECRETBODY"];
    writeFileSync(timelinePath, `甲\t0\t1\t${secrets[0]}\n司会\t2\t3\t開始\n`);
    const expected = { from: 0, to: 1, keywords: [secrets[3]], text: secrets[1] };
    writeFileSync(truthPath, JSON.stringify({ 決定: [], TODO: [{ ...expected, 担当: "甲" }], 案: [{ ...expected, 出した人: "甲" }] }));
    const paths: string[] = [];
    for (const { name, label } of [{ name: "first", label: "相手 A" }, { name: "second", label: "相手 B" }]) {
      const folder = join(dir, name);
      paths.push(folder);
      mkdirSync(folder);
      const remark = { id: "r1", track: "相手", speaker: label, start: 0, end: 1, text: secrets[2] };
      const evidence = [remark];
      const children = name === "first" ? [
        { id: "n1", kind: "案", text: secrets[3], proposer: label, evidence, children: [] },
        { id: "n2", kind: "TODO", text: secrets[3], assigneeSpeaker: label, evidence, children: [] },
      ] : [];
      writeFileSync(join(folder, "export.json"), JSON.stringify({ root: { id: "root", kind: "会議", text: secrets[4], evidence: [], children } }));
      writeFileSync(join(folder, "log.jsonl"), [
        { type: "start", title: secrets[4], at: "2026-01-01T00:00:00Z" },
        { type: "remark", remark, at: "2026-01-01T00:00:01Z" },
        ...(name === "first" ? [{ type: "speaker-name", label, name: "甲", source: "推定", at: "2026-01-01T00:00:03Z" }] : []),
      ].map((line) => JSON.stringify(line)).join("\n") + "\n");
    }
    const { result, stdout, stderr } = yield* runCommand(command, ["--self", "司会", timelinePath, truthPath, ...paths]);
    expect(result._tag).toBe("Success");
    expect(stderr).toBe("");
    const lines = stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    const cells = lines.map((line) => {
      expect(line).toMatch(/^\|.*\|$/);
      return line.slice(1, -1).split("|").map((value) => value.trim());
    });
    const [header, separator, ...rows] = cells;
    expect(header).toEqual(expect.arrayContaining(metrics));
    expect(separator!.every((value) => /^:?-+:?$/.test(value))).toBe(true);
    expect(header!.indexOf("誤った名前")).toBeLessThan(header!.indexOf("名前 付いたラベル"));
    expect(header!.indexOf("誤った名前")).toBeLessThan(header!.indexOf("名前 正しい"));
    const column = (row: string[], name: string) => row[header!.indexOf(name)]!;
    for (const row of rows) assertRowValues(row, header!);
    expect(column(rows[0]!, "案 再現")).toMatch(/^1\/1(?: |$)/);
    expect(column(rows[1]!, "案 再現")).toMatch(/^0\/1(?: |$)/);
    expect(column(rows[0]!, "TODO 再現")).toMatch(/^1\/1(?: |$)/);
    expect(column(rows[1]!, "TODO 再現")).toMatch(/^0\/1(?: |$)/);
    expect(rows.map((row) => column(row, "名前 付いたラベル"))).toEqual(["1", "0"]);
    expect(rows.map((row) => column(row, "誤った名前"))).toEqual(["0", "0"]);
    expect(rows.map((row) => column(row, "名前まで"))).toEqual(["2.0", "—"]);
    appendFileSync(join(paths[1]!, "log.jsonl"), JSON.stringify({ type: "speaker-name", label: "相手 B", name: "乙", source: "推定", at: "2026-01-01T00:00:03Z" }));
    const updated = yield* runCommand(command, ["--self", "司会", timelinePath, truthPath, ...paths]);
    expect(updated.result._tag).toBe("Success");
    const updatedLines = updated.stdout.trimEnd().split("\n");
    expect(updatedLines[2]).toBe(lines[2]);
    const second = updatedLines[3]!.slice(1, -1).split("|").map((value) => value.trim());
    expect(column(second, "名前 付いたラベル")).toBe("1");
    expect(column(second, "誤った名前")).toBe("1");
    for (const output of [stdout, stderr]) for (const secret of secrets) expect(output).not.toContain(secret);
  }).pipe(Effect.scoped));

  it.effect("推定名のないセッションの名前までをダッシュで出す", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const timeline = join(dir, "timeline.tsv");
    const truth = join(dir, "truth.json");
    writeFileSync(timeline, "司会\t0\t1\t開始\n");
    writeFileSync(truth, JSON.stringify({ 決定: [], TODO: [] }));
    writeFileSync(join(dir, "export.json"), JSON.stringify({ root: { id: "root", kind: "会議", text: "会議", evidence: [], children: [] } }));
    writeFileSync(join(dir, "log.jsonl"), JSON.stringify({ type: "start", title: "会議", at: "2026-01-01T00:00:00Z" }) + "\n");
    const { result, stdout } = yield* runCommand(command, ["--self", "司会", timeline, truth, dir]);
    expect(result._tag).toBe("Success");
    const lines = stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    const cells = (line: string) => line.slice(1, -1).split("|").map((value) => value.trim());
    const header = cells(lines[0]!);
    expect(header).toContain("名前まで");
    expect(cells(lines[2]!)[header.indexOf("名前まで")]).toBe("—");
  }).pipe(Effect.scoped));
});

const at = (second: number) => `2026-01-01T00:00:0${second}Z`;
const loggedRemark = (label: string, start: number, end: number) => ({
  type: "remark", at: at(0), remark: { id: "r1", track: "相手", speaker: label, start, end, text: "PRIVATEBODYあいうえお".repeat(20) },
});
const named = (name: string, second: number, source = "推定") => ({ type: "speaker-name", label: "相手 A", name, source, at: at(second) });
const cells = (line: string) => line.slice(1, -1).split("|").map((value) => value.trim());
const rowOf = (stdout: string) => {
  const lines = stdout.trimEnd().split("\n");
  const header = cells(lines[0]!);
  const row = cells(lines[2]!);
  return (column: string) => row[header.indexOf(column)];
};
const savedSession = (dir: string) => {
  const timeline = join(dir, "timeline.tsv");
  const truth = join(dir, "truth.json");
  writeFileSync(timeline, "甲\t0\t10\t台本甲\n乙\t10\t20\t台本乙\n司会\t30\t31\t開始\n");
  const item = (word: string) => ({ from: 0, to: 20, keywords: [word] });
  writeFileSync(truth, JSON.stringify({ 決定: [], 案: [{ ...item("first"), 出した人: "乙" }, { ...item("second"), 出した人: "甲" }], TODO: [{ ...item("task"), 担当: "甲" }] }));
  const node = (id: string, kind: string, attributes: object) => ({ id, kind, text: id, evidence: [loggedRemark("相手 A", 0, 19).remark], children: [], ...attributes });
  writeFileSync(join(dir, "export.json"), JSON.stringify({ root: { id: "root", kind: "会議", text: "会議", evidence: [], children: [
    node("first", "案", { proposer: "相手 A" }), node("second", "案", { proposer: "相手 B" }), node("task", "TODO", { assigneeSpeaker: "相手 B" }),
  ] } }));
  return ["--self", "司会", timeline, truth, dir];
};

describe("人の採点CLIの逐次読込", () => {
  it.effect.each([
    { start: 0, name: "乙", ideas: "100.0%", todos: "100.0%", correct: "100.0%" },
    { start: 10, name: "乙", ideas: "0.0%", todos: "0.0%", correct: "0.0%" },
    { start: 0, name: "甲", ideas: "100.0%", todos: "100.0%", correct: "0.0%" },
  ])("複数チャンクの末尾の対応・訂正を採点し、最終改行の有無で変えない ($start, $name)", (sample) => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const args = savedSession(dir);
    const logPath = join(dir, "log.jsonl");
    const log = [loggedRemark("相手 A", 0, 19), named("甲", 2),
      ...Array.from({ length: 600 }, () => loggedRemark("相手 A", 21, 22)),
      loggedRemark("相手 B", sample.start, sample.start + 8), named(sample.name, 5),
    ].map((event) => JSON.stringify(event)).join("\n");
    let previous: string | undefined;
    for (const ending of ["\n", ""]) {
      writeFileSync(logPath, log + ending);
      const { result, stdout, stderr } = yield* runCommand(command, args);
      expect(result._tag).toBe("Success");
      expect(stderr).toBe("");
      expect(stdout).not.toContain("PRIVATEBODY");
      const row = rowOf(stdout);
      expect(row("案 再現")).toBe("2/2");
      expect(row("出した人 合う")).toBe(sample.ideas);
      expect(row("出した人 人なし")).toBe("0.0%");
      expect(row("TODO 再現")).toBe("1/1");
      expect(row("担当 合う")).toBe(sample.todos);
      expect(row("担当 人なし")).toBe("0.0%");
      expect(row("名前 付いたラベル")).toBe("1");
      expect(row("名前 正しい")).toBe(sample.correct);
      expect(row("誤った名前")).toBe(sample.correct === "100.0%" ? "0" : "1");
      expect(row("名前まで")).toBe("2.0");
      if (previous !== undefined) expect(stdout).toBe(previous);
      previous = stdout;
    }
  }).pipe(Effect.scoped));

  it.effect.each([
    { source: "推定", remark: true, labels: "1", correct: "100.0%", seconds: "3.0" },
    { source: "手入力", remark: true, labels: "0", correct: "n/a", seconds: "—" },
    { source: "推定", remark: false, labels: "1", correct: "0.0%", seconds: "—" },
  ])("末尾の名前のsourceとremarkの有無を区別する ($source, $remark)", (sample) => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const args = savedSession(dir);
    writeFileSync(join(dir, "log.jsonl"), [
      ...(sample.remark ? [loggedRemark("相手 A", 0, 10)] : []), named("甲", 3, sample.source),
    ].map((event) => JSON.stringify(event)).join("\n"));
    const { result, stdout } = yield* runCommand(command, args);
    expect(result._tag).toBe("Success");
    const row = rowOf(stdout);
    expect(row("名前 付いたラベル")).toBe(sample.labels);
    expect(row("名前 正しい")).toBe(sample.correct);
    expect(row("名前まで")).toBe(sample.seconds);
  }).pipe(Effect.scoped));

  it.effect.each(["schema", "JSON"])("後続セッションの改行なし最終行の%s不正は行番号付きで拒否し、表も本文も出さない", (kind) => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const args = savedSession(dir);
    const first = join(dir, "log.jsonl");
    const event = loggedRemark("相手 A", 0, 10);
    writeFileSync(first, JSON.stringify(event));
    const second = join(dir, "second");
    mkdirSync(second);
    savedSession(second);
    const path = join(second, "log.jsonl");
    const prefix = [JSON.stringify(event), "", "  ", ...Array.from({ length: 600 }, () => JSON.stringify(event))];
    const tail = kind === "schema" ? JSON.stringify({ ...event, at: "not-a-time" }) : JSON.stringify(event).slice(0, -1);
    writeFileSync(path, [...prefix, tail].join("\n"));
    const failed = yield* runCommand(command, [...args, second]);
    expect(failed.stdout).toBe("");
    const failure = taggedFailure(failed.result);
    expect(failure).toMatchObject({ _tag: "InvalidInputFile", path });
    expect(failure?.reason).toContain(`${prefix.length + 1} 行目`);
    const capture = consoleCapture();
    yield* reportFailure(Cause.fail(failure)).pipe(Effect.provide(capture.layer));
    expect(capture.stderr).toHaveLength(1);
    expect(capture.stderr[0]).toContain(path);
    expect(capture.stderr[0]).not.toContain("PRIVATEBODY");
    writeFileSync(path, [...prefix, JSON.stringify(event)].join("\n"));
    const valid = yield* runCommand(command, [...args, second]);
    expect(valid.result._tag).toBe("Success");
    expect(valid.stdout.trimEnd().split("\n")).toHaveLength(4);
  }).pipe(Effect.scoped));
});
