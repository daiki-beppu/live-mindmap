import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.ts";
import { QUIET_MS, type DiffInput, type Op, type Snapshot } from "../src/core/index.ts";

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
    const deps = { updater, sessionsDir, port: 0, stdout: (s: string) => out.push(s) };
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
    const playing = runCli(["play", fixture], { updater, sessionsDir, port: 0, stdout: (s) => playOut.push(s) });
    await secondCallReached;

    const [session] = await readdir(sessionsDir);
    const dir = join(sessionsDir, session!);
    const before = (await readdir(dir)).sort();
    expect(before).toEqual(["export.json", "log.jsonl"]);

    const deps = { updater, sessionsDir, port: 0, stdout: (s: string) => out.push(s) };
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
      const deps = { updater, sessionsDir, port: 0, stdout: (s: string) => out.push(s) };
      await runCli(["play", fixture], deps);
      const dir = dirname(out.join("").split("\n")[0]!); // play は書き出したファイルのパスを出す（#41）
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
      const deps = { updater, sessionsDir, port: 0, stdout: (s: string) => out.push(s) };

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
      // 変わったこと: 反映ごとに round が進み、その反映の新しい発言の end の最大値を時刻として、記録が積み上がって届く
      expect(received.map((s) => s.round)).toEqual([0, 1, 2]);
      expect(received[0]!.changes).toEqual([]);
      expect(received[1]!.changes).toEqual([
        { round: 1, at: 19.2, change: "追加", node: "n1", kind: "議題", text: "採用" },
        { round: 1, at: 19.2, change: "追加", node: "n2", kind: "論点", text: "面接は何回か" },
      ]);
      expect(last.changes).toEqual([
        ...received[1]!.changes,
        { round: 2, at: 28, change: "決定済み化", node: "n2", kind: "論点", text: "面接は何回か" },
        { round: 2, at: 28, change: "追加", node: "n3", kind: "決定", text: "2 回にする" },
      ]);
      // 根拠: 届いたスナップショットから、ノードの根拠の ID で発言（時刻・本文）を引ける
      const n1 = last.nodes.find((x) => x.id === "n1")!;
      const r1 = last.remarks.find((r) => r.id === n1.evidence[0])!;
      expect(r1).toMatchObject({ start: 0.5, end: 9.8, text: "今日は採用の進め方を決めます" });
      expect(["自分", "相手"]).toContain(r1.track);
      for (const node of last.nodes) for (const id of node.evidence) expect(last.remarks.some((r) => r.id === id)).toBe(true);
      expect(out.join("")).toMatch(/^([^\n]+\n){3}$/); // 書き出した 3 ファイルのパスだけ
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
      // 再生の待ち。セッションが差分更新を呼ぶまでの待ち（QUIET_MS）も同じ sleep を通るので、それを除いて見る
      expect(slept.filter((ms) => ms !== QUIET_MS)).toEqual([9800, 9400, 8800]);
    });

    it("--realtime では、1 つ目の発言が QUIET_MS 経っても 2 つ目が来なければ、2 つ目を待たずにその 1 つで差分更新を呼ぶ", async () => {
      const sessionsDir = await mkdtemp(join(tmpdir(), "live-mindmap-"));
      // 待ちはすべてテストの側から解決する（再生の待ちも、セッションの待ちも）
      const timers: { ms: number; fired: boolean; fire: () => void }[] = [];
      const sleep = (ms: number) =>
        new Promise<void>((resolve) => timers.push({ ms: Math.round(ms), fired: false, fire: resolve }));
      const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
      const calls: string[][] = [];
      const updater = async (input: DiffInput) => {
        calls.push(input.fresh.map((u) => u.id));
        return { ops: [] as Op[] };
      };
      let finished = false;
      const playing = runCli(["play", fixture, "--realtime"], { updater, sessionsDir, port: 0, sleep, stdout: () => {} }).then(
        () => (finished = true),
      );

      // 1 つ目の発言までの再生の待ちを解決する。r1 が流れ、続く再生の待ち（r2 まで）と、r1 の QUIET_MS の待ちが仕掛かる
      await vi.waitFor(() => expect(timers.length).toBeGreaterThan(0));
      expect(timers[0]!.ms).toBe(9800);
      timers[0]!.fired = true;
      timers[0]!.fire();
      await vi.waitFor(() => expect(timers.some((t) => t.ms === QUIET_MS)).toBe(true));
      expect(calls).toEqual([]); // 待ちが切れる前は呼ばない

      // r2 はまだ来ていない（再生の待ちは解決していない）。QUIET_MS が切れた時点で r1 だけで呼ぶ
      const quiet = timers.find((t) => t.ms === QUIET_MS)!;
      quiet.fired = true;
      quiet.fire();
      await vi.waitFor(() => expect(calls).toEqual([["r1"]]));

      // 残りを流して再生を終わらせる
      while (!finished) {
        for (const t of timers) {
          if (t.fired) continue;
          t.fired = true;
          t.fire();
        }
        await settle();
      }
      await playing;
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
