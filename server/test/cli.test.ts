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
});
