import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import type { DiffInput, Op } from "../src/core/index.ts";

const fixture = join(import.meta.dirname, "fixtures/short.transcript.json");

describe("CLI", () => {
  it("文字起こしを再生すると、export --format json がその時点のマップを標準出力に出す", async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), "live-mindmap-"));
    const calls: DiffInput[] = [];
    const script: Op[][] = [
      [
        { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
        { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: ["r2"] },
      ],
      [{ op: "add", ref: "t3", parent: "n2", kind: "決定", text: "2 回にする", evidence: ["r3"] }],
    ];
    const updater = async (input: DiffInput) => {
      calls.push(input);
      return { ops: script[calls.length - 1] ?? [] };
    };
    const out: string[] = [];
    const deps = { updater, sessionsDir, stdout: (s: string) => out.push(s) };

    await runCli(["play", fixture], deps);
    expect(calls.map((c) => c.fresh.map((u) => u.id))).toEqual([["r1", "r2"], ["r3"]]);

    out.length = 0;
    await runCli(["export", "--format", "json"], deps);
    const exported = JSON.parse(out.join(""));
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
  });

  const script: Op[][] = [
    [
      { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
      { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: ["r2"] },
    ],
    [{ op: "add", ref: "t3", parent: "n2", kind: "決定", text: "2 回にする", evidence: ["r3"] }],
  ];
  async function played() {
    const sessionsDir = await mkdtemp(join(tmpdir(), "live-mindmap-"));
    let n = 0;
    const updater = async () => ({ ops: script[n++] ?? [] });
    const out: string[] = [];
    const deps = { updater, sessionsDir, stdout: (s: string) => out.push(s) };
    await runCli(["play", fixture], deps);
    const [session] = await readdir(sessionsDir);
    const dir = join(sessionsDir, session!);
    const paths = out.join("").trim().split("\n");
    out.length = 0;
    return { deps, out, dir, paths, sessionsDir };
  }

  it("再生が終わると、ログと同じフォルダに map.md・map.json・map.drawnix を書き出し、そのパスを順に出力する", async () => {
    const { dir, paths } = await played();
    expect(paths).toEqual([join(dir, "map.md"), join(dir, "map.json"), join(dir, "map.drawnix")]);
    expect((await readdir(dir)).sort()).toEqual(expect.arrayContaining(["log.jsonl", "map.md", "map.json", "map.drawnix"]));
    const md = await readFile(join(dir, "map.md"), "utf8");
    expect(md).toContain("# short");
    expect(md).toContain("面接は何回か → 2 回にする");
    const drawnix = JSON.parse(await readFile(join(dir, "map.drawnix"), "utf8"));
    expect(drawnix).toMatchObject({ type: "drawnix", elements: [{ type: "mindmap" }] });
  });

  it("map.json は、直後の export --format json の出力と同じ内容", async () => {
    const { deps, out, dir } = await played();
    await runCli(["export", "--format", "json"], deps);
    expect(await readFile(join(dir, "map.json"), "utf8")).toBe(out.join(""));
  });

  it("形式を指定しない export は Markdown を標準出力に出し、ファイルは作らない", async () => {
    const { deps, out, dir } = await played();
    const before = (await readdir(dir)).sort();
    await runCli(["export"], deps);
    const md = out.join("");
    expect(md.startsWith("# short")).toBe(true);
    expect(md).toContain("面接は何回か → 2 回にする");
    expect((await readdir(dir)).sort()).toEqual(before);
    expect(md).toBe(await readFile(join(dir, "map.md"), "utf8"));
  });

  it("再生の途中でも、export はその時点のマップを標準出力に出し、ファイルは作らない", async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), "live-mindmap-"));
    let calls = 0;
    let reachedSecond!: () => void;
    const secondCallReached = new Promise<void>((resolve) => (reachedSecond = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const updater = async () => {
      const ops = script[calls++] ?? [];
      if (calls === 2) {
        reachedSecond();
        await released; // 2 回目の更新が終わらない、進行中の状態で止める
      }
      return { ops };
    };
    const playOut: string[] = [];
    const out: string[] = [];
    const playing = runCli(["play", fixture], { updater, sessionsDir, stdout: (s) => playOut.push(s) });
    await secondCallReached;

    const [session] = await readdir(sessionsDir);
    const dir = join(sessionsDir, session!);
    const before = (await readdir(dir)).sort();
    expect(before).toEqual(["export.json", "log.jsonl"]);

    const deps = { updater, sessionsDir, stdout: (s: string) => out.push(s) };
    await runCli(["export"], deps);
    const md = out.join("");
    expect(md.startsWith("# short")).toBe(true);
    expect(md).toContain("面接は何回か（未決）");
    expect(md).not.toContain("→ 決定");

    out.length = 0;
    await runCli(["export", "--format", "json"], deps);
    const exported = JSON.parse(out.join(""));
    expect(exported.root.children[0].children[0]).toMatchObject({ kind: "論点", text: "面接は何回か", pointStatus: "未決", children: [] });
    expect((await readdir(dir)).sort()).toEqual(before);

    release();
    await playing;
  });

  it("未対応の形式はエラーにする", async () => {
    const { deps } = await played();
    await expect(runCli(["export", "--format", "xml"], deps)).rejects.toThrow("xml");
  });
});
