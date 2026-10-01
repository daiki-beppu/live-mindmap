import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
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

  describe("restore", () => {
    // 再生したセッションと、その export の出力を用意する
    const adoptionScript: Op[][] = [
      [
        { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
        { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: ["r2"] },
      ],
      [{ op: "add", ref: "t3", parent: "n2", kind: "決定", text: "2 回にする", evidence: ["r3"] }],
    ];

    // sessionsDir に script で 1 セッション再生し、そのフォルダと export の出力を返す
    async function playInto(sessionsDir: string, script: Op[][]) {
      let n = 0;
      const updater = async (_: DiffInput) => ({ ops: script[n++] ?? [] });
      const out: string[] = [];
      const deps = { updater, sessionsDir, stdout: (s: string) => out.push(s) };
      await runCli(["play", fixture], deps);
      const dir = out.join("").trim();
      out.length = 0;
      await runCli(["export", "--format", "json"], deps);
      return { dir, before: out.join(""), out };
    }

    async function played() {
      const sessionsDir = await mkdtemp(join(tmpdir(), "live-mindmap-"));
      return { sessionsDir, ...(await playInto(sessionsDir, adoptionScript)) };
    }

    const noUpdater = async (_: DiffInput): Promise<{ ops: Op[] }> => ({ ops: [] });

    it("落ちた後に、ログから差分更新を呼ばずに元と同じマップへ戻し、export で読める", async () => {
      const { sessionsDir, dir, before, out } = await played();
      // 落ちた状態: エクスポートは残っておらず、ログには知らない種類の行がある
      rmSync(join(dir, "export.json"));
      appendFileSync(join(dir, "log.jsonl"), JSON.stringify({ type: "jev", at: "2026-10-01T00:00:00.000Z" }) + "\n");
      let called = 0;
      const updater = async (_: DiffInput): Promise<{ ops: Op[] }> => {
        called++;
        throw new Error("復元で差分更新が呼ばれた");
      };
      const deps = { updater, sessionsDir, stdout: (s: string) => out.push(s) };

      out.length = 0;
      await runCli(["restore"], deps);
      expect(out.join("").trim()).toBe(dir);
      expect(called).toBe(0);

      out.length = 0;
      await runCli(["export", "--format", "json"], deps);
      expect(out.join("")).toBe(before);
    });

    it("復元してもログを書き足さない", async () => {
      const { sessionsDir, dir } = await played();
      const logBefore = readFileSync(join(dir, "log.jsonl"), "utf8");
      const updater = async (_: DiffInput): Promise<{ ops: Op[] }> => ({ ops: [] });
      await runCli(["restore"], { updater, sessionsDir, stdout: () => {} });
      expect(readFileSync(join(dir, "log.jsonl"), "utf8")).toBe(logBefore);
    });

    it("ログの行が JSON として壊れていれば、行番号を付けたエラーにする", async () => {
      const { sessionsDir, dir } = await played();
      const lines = readFileSync(join(dir, "log.jsonl"), "utf8").split("\n");
      lines.splice(1, 0, "{壊れた行");
      writeFileSync(join(dir, "log.jsonl"), lines.join("\n"));
      const updater = async (_: DiffInput): Promise<{ ops: Op[] }> => ({ ops: [] });
      await expect(runCli(["restore"], { updater, sessionsDir, stdout: () => {} })).rejects.toThrow(/2/);
    });

    it("セッションが複数あれば最新のものを復元し、export がその最新のマップを出す", async () => {
      const sessionsDir = await mkdtemp(join(tmpdir(), "live-mindmap-"));
      const first = await playInto(sessionsDir, adoptionScript);
      const oldDir = join(sessionsDir, "2000-01-01T00-00-00.000Z");
      renameSync(first.dir, oldDir);
      const second = await playInto(sessionsDir, [
        [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "予算", evidence: ["r1"] }],
      ]);
      expect(second.dir).not.toBe(oldDir);
      expect(first.before).not.toBe(second.before);
      rmSync(join(second.dir, "export.json"));

      const out: string[] = [];
      const deps = { updater: noUpdater, sessionsDir, stdout: (s: string) => out.push(s) };
      await runCli(["restore"], deps);
      expect(out.join("").trim()).toBe(second.dir);

      out.length = 0;
      await runCli(["export", "--format", "json"], deps);
      expect(out.join("")).toBe(second.before);
    });

    it("ログのない、より新しいフォルダがあっても、ログのある最新のセッションを復元する", async () => {
      const { sessionsDir, dir } = await played();
      mkdirSync(join(sessionsDir, "9999-12-31T00-00-00.000Z"));
      const out: string[] = [];
      await runCli(["restore"], { updater: noUpdater, sessionsDir, stdout: (s: string) => out.push(s) });
      expect(out.join("").trim()).toBe(dir);
    });

    it("セッションがなければエラーにする", async () => {
      const sessionsDir = await mkdtemp(join(tmpdir(), "live-mindmap-"));
      await expect(runCli(["restore"], { sessionsDir, stdout: () => {} })).rejects.toThrow("セッションがありません");
    });
  });
});
