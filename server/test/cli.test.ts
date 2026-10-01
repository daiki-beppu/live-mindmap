import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import type { DiffInput, Op, Snapshot } from "../src/core/index.ts";

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
    const deps = { updater, sessionsDir, port: 0, stdout: (s: string) => out.push(s) };

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

  describe("ブラウザへの配信と再生の速さ", () => {
    const script: Op[][] = [
      [
        { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
        { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: ["r2"] },
      ],
      [{ op: "add", ref: "t3", parent: "n2", kind: "決定", text: "2 回にする", evidence: ["r3"] }],
    ];

    // play の WebSocket につなぎ、届いたスナップショットを貯める。つながって最初のものが届くまで updater を待たせる。
    function listener() {
      const received: Snapshot[] = [];
      let firstReceived: () => void = () => {};
      const first = new Promise<void>((r) => (firstReceived = r));
      const onListening = (port: number) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.addEventListener("message", (e) => {
          received.push(JSON.parse(String(e.data)));
          firstReceived();
        });
      };
      return { received, first, onListening };
    }

    it("反映のたびに、マップ全体のスナップショットが WebSocket で届く（初期のルート＋反映ごとに 1 つ）。標準出力は変わらない", async () => {
      const sessionsDir = await mkdtemp(join(tmpdir(), "live-mindmap-"));
      const { received, first, onListening } = listener();
      let n = 0;
      const updater = async () => {
        await first; // 接続して最初のスナップショットが届くまで、反映を待たせる
        return { ops: script[n++] ?? [] };
      };
      const out: string[] = [];
      await runCli(["play", fixture], { updater, sessionsDir, port: 0, onListening, stdout: (s) => out.push(s) });
      await new Promise((r) => setTimeout(r, 100)); // close 前に送られたものが届くのを待つ

      expect(received.map((s) => s.nodes.length)).toEqual([1, 3, 4]);
      expect(received[0]!.nodes.map((x) => x.kind)).toEqual(["会議"]);
      const last = received.at(-1)!;
      expect(last.nodes.map((x) => x.text)).toEqual(["short", "採用", "面接は何回か", "2 回にする"]);
      expect(last.nodes.find((x) => x.kind === "論点")).toMatchObject({ pointStatus: "決定済み" });
      expect(out.join("")).toMatch(/^[^\n]+\n$/); // セッションのフォルダ 1 行だけ
    });

    it("失敗した反映（マップが変わらない）ではスナップショットを送らない", async () => {
      const sessionsDir = await mkdtemp(join(tmpdir(), "live-mindmap-"));
      const { received, first, onListening } = listener();
      let n = 0;
      const updater = async () => {
        await first;
        if (n++ === 0) throw new Error("失敗");
        return { ops: [] as Op[] };
      };
      await runCli(["play", fixture], { updater, sessionsDir, port: 0, onListening, stdout: () => {} });
      await new Promise((r) => setTimeout(r, 100));
      expect(received.map((s) => s.nodes.length)).toEqual([1, 1]); // 初期のルート＋成功した 1 回（変更なし）だけ
    });

    it("--realtime のときだけ、発言の end の差だけ待つ", async () => {
      const sessionsDir = await mkdtemp(join(tmpdir(), "live-mindmap-"));
      const slept: number[] = [];
      const deps = {
        updater: async () => ({ ops: [] as Op[] }),
        sessionsDir,
        port: 0,
        sleep: async (ms: number) => {
          slept.push(Math.round(ms));
        },
        stdout: () => {},
      };
      await runCli(["play", fixture], deps);
      expect(slept).toEqual([]); // 指定しなければ待たない（待ち時間なし）

      await runCli(["play", fixture, "--realtime"], deps);
      expect(slept).toEqual([9800, 9400, 8800]);
    });

    it("再生が終わると WebSocket サーバーを閉じる（同じポートで続けて起動できる）", async () => {
      const sessionsDir = await mkdtemp(join(tmpdir(), "live-mindmap-"));
      let port = 0;
      const deps = {
        updater: async () => ({ ops: [] as Op[] }),
        sessionsDir,
        port: 0,
        onListening: (p: number) => (port = p),
        stdout: () => {},
      };
      await runCli(["play", fixture], deps);
      await expect(
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}`);
          ws.addEventListener("open", () => resolve());
          ws.addEventListener("error", () => reject(new Error("閉じている")));
        }),
      ).rejects.toThrow("閉じている");
    });
  });
});
