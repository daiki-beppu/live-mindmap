import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// freePort の待機中に close() を呼ぶ順序を作るため、node:net の probe.close の callback を止められるようにする（既定は素通し）
const gate = vi.hoisted(() => {
  const state = { open: true, release: () => {}, closeCalled: () => {} };
  let wait: Promise<void> = Promise.resolve();
  let called: Promise<void> = Promise.resolve();
  return {
    state,
    hold() {
      state.open = false;
      wait = new Promise<void>((resolve) => (state.release = () => ((state.open = true), resolve())));
      called = new Promise<void>((resolve) => (state.closeCalled = resolve));
    },
    wait: () => wait,
    called: () => called,
  };
});
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      const close = server.close.bind(server);
      server.close = ((cb?: (err?: Error) => void) => {
        if (gate.state.open) return close(cb);
        gate.state.closeCalled();
        return close(() => void gate.wait().then(() => cb?.()));
      }) as typeof server.close;
      return server;
    },
  };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
import { spawn } from "node:child_process";
import { runCli } from "../src/cli.ts";
import { QUIET_MS, type DiffInput, type Op, type Snapshot, type SpeakingFrame } from "../src/core/index.ts";
import type { MapCapture } from "../src/capture.ts";
import { HELPER_STOP_TIMEOUT_MS, startServer } from "../src/server.ts";

// 通常のテストでは、テストごとに Chromium を起動しないよう、画像の撮影を偽物にする（空のファイルを書くだけ）。
// 実物の撮影は、疎通のテスト（実物の captureMap）と capture.test.ts で確かめる。
const fakeCapture: MapCapture = async (_snapshot, path) => writeFileSync(path, "");

// 疎通テスト: 偽のヘルパー（fixtures/fake-helper.ts）から発言を送り、CLI で開始・終了する。
// サーバーは実物（HTTP + WebSocket + 子プロセスの起動）で、差分更新とヘルパーだけが偽物。
const fakeHelper = join(import.meta.dirname, "fixtures/fake-helper.ts");

const APPS = [{ bundleID: "us.zoom.xos", name: "zoom.us" }];
const remark = (track: "自分" | "相手", start: number, end: number, text: string) => ({ type: "remark", track, start, end, text, duplicate: false });
// partial は発言として数えられない（r の番号を消費しない）。本文は、マップにもログにも出ない専用の文字列
const PARTIAL_1 = "はじまりの途中結果";
const PARTIAL_2 = "にかいめの途中結果";
const EVENTS = [
  { type: "partial", track: "相手", text: PARTIAL_1 },
  remark("相手", 1, 5, "採用の面接について"),
  remark("自分", 6, 9, "面接は何回にしますか"),
  { type: "partial", track: "相手", text: PARTIAL_2 },
  remark("相手", 19.2, 28, "2 回にしましょう"),
];

const OPS: Op[][] = [
  [
    { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
    { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: ["r2"] },
  ],
  [{ op: "add", ref: "t3", parent: "n2", kind: "決定", text: "2 回にする", evidence: ["r3"] }],
];

type Script = { apps: unknown; events: unknown[]; failRun?: { stderr: string; code: number }; ignoreSigterm?: boolean };
type HelperRecord = { type: "run"; argv: string[]; pid: number } | { type: "connection" } | { type: "signal"; signal: string };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(initial: Partial<Script> = {}, capture: MapCapture = fakeCapture) {
  const dir = await mkdtemp(join(tmpdir(), "live-mindmap-"));
  const sessionsDir = join(dir, "sessions");
  const scriptPath = join(dir, "script.json");
  const recordPath = join(dir, "record.jsonl");
  const writeScript = (script: Partial<Script> = {}) =>
    writeFileSync(scriptPath, JSON.stringify({ apps: APPS, events: EVENTS, ...script } satisfies Script));
  writeScript(initial);
  writeFileSync(recordPath, "");
  const records = (): HelperRecord[] =>
    readFileSync(recordPath, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));

  const calls: DiffInput[] = [];
  const updater = async (input: DiffInput) => {
    calls.push(input);
    return { ops: OPS[calls.length - 1] ?? [] };
  };
  // セッションごとに開く updater。開いた数と閉じた数を数える
  const updaters = { opened: 0, closed: 0, callsAfterClose: 0 };
  const server = await startServer({
    port: 0,
    sessionsDir,
    openUpdater: () => {
      updaters.opened++;
      let closed = false;
      return {
        update: async (input: DiffInput) => {
          if (closed) updaters.callsAfterClose++;
          return updater(input);
        },
        close: () => {
          closed = true;
          updaters.closed++;
        },
      };
    },
    helper: { command: process.execPath, args: [fakeHelper, scriptPath, recordPath] },
    capture,
  });
  cleanups.push(() => server.close());

  const out: string[] = [];
  const deps = { port: server.port, sessionsDir, stdout: (s: string) => out.push(s) };
  // CLI を実行して、その標準出力を返す
  const cli = async (...argv: string[]) => {
    out.length = 0;
    await runCli(argv, deps);
    return out.join("");
  };
  const sessionDirs = async () => (existsSync(sessionsDir) ? (await readdir(sessionsDir)).sort().map((d) => join(sessionsDir, d)) : []);
  return { server, cli, calls, writeScript, records, sessionDirs, sessionsDir, updaters };
}

// つないだクライアントに届いた frame を、スナップショットと speaking（いま話している文字）に分けて貯める
async function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const received: Snapshot[] = [];
  const speaking: SpeakingFrame[] = [];
  ws.addEventListener("message", (e) => {
    const frame = JSON.parse(String(e.data));
    (frame.type === "speaking" ? speaking : received).push(frame);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("接続できない")));
  });
  cleanups.push(async () => ws.close());
  return { ws, received, speaking };
}

const logEvents = async (dir: string) =>
  (await readFile(join(dir, "log.jsonl"), "utf8")).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));

describe("ライブのセッション", () => {
  it("CLI の apps が、ヘルパーの list の結果を標準出力に出す", async () => {
    const { cli } = await setup();

    expect(JSON.parse(await cli("apps"))).toEqual(APPS);
  });

  it("開始 → 発言 → 終了 → 終了後の観測を、同じサーバー・同じ WebSocket のまま続けても、最後のマップが残る", async () => {
    const { server, cli, calls, records, sessionDirs } = await setup();
    const before = await connect(server.port); // 開始前から接続しているブラウザ

    await cli("start", "--app", "us.zoom.xos", "--title", "週次");

    // ヘルパーは、指定したアプリと、サーバーが選んだ空きポート（既定の 8765 ではない）で起動され、サーバーだけが接続する
    await vi.waitFor(() => expect(records().filter((r) => r.type === "connection")).toHaveLength(1));
    const runs = records().filter((r) => r.type === "run");
    expect(runs).toHaveLength(1);
    const argv = runs[0]!.argv;
    expect(argv.slice(0, 3)).toEqual(["run", "--app", "us.zoom.xos"]);
    const port = Number(argv[argv.indexOf("--port") + 1]);
    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(8765);
    expect(port).not.toBe(server.port);

    // 会議中（stop の前）に、r1・r2 の反映が接続中のクライアントへ届く
    await vi.waitFor(() => expect(before.received.map((s) => s.nodes.length)).toEqual([1, 3]));

    const stderr = vi.spyOn(process.stderr, "write");
    cleanups.push(async () => stderr.mockRestore());
    const stopStartedAt = Date.now();
    const stdout = await cli("stop");

    // SIGTERM で終わるヘルパーでは、時間切れを待たず、SIGKILL にも切り替えない
    expect(Date.now() - stopStartedAt).toBeLessThan(HELPER_STOP_TIMEOUT_MS);
    expect(stderr.mock.calls.some(([chunk]) => String(chunk).includes("SIGKILL"))).toBe(false);

    // 終了で、セッションのフォルダに 4 つのファイルが書かれ、そのパスが出る
    const [dir] = await sessionDirs();
    expect(dir).toBeDefined();
    const paths = [join(dir!, "map.md"), join(dir!, "map.json"), join(dir!, "map.drawnix"), join(dir!, "map.png")];
    expect(stdout.split("\n").filter((l) => l !== "")).toEqual(paths);
    for (const path of paths) expect(existsSync(path)).toBe(true);

    // 発言は再生と同じ経路（差分更新の入力の流れ）を通る。ID はヘルパーが付けず、サーバーが発言ごとに採番する
    expect(calls.map((c) => c.fresh.map((u) => u.id))).toEqual([["r1", "r2"], ["r3"]]);
    expect(calls[0]!.fresh.map((u) => [u.track, u.text])).toEqual([
      ["相手", "採用の面接について"],
      ["自分", "面接は何回にしますか"],
    ]);
    const events = await logEvents(dir!);
    expect(events.find((e) => e.type === "start")).toMatchObject({ title: "週次" });
    expect(events.filter((e) => e.type === "remark").map((e) => e.remark.id)).toEqual(["r1", "r2", "r3"]);
    expect(events.filter((e) => e.type === "diff")).toHaveLength(2);

    // 終了前から接続しているクライアントには、初期のルート＋反映ごとのマップ全体が届き、終了で閉じられない
    await vi.waitFor(() => expect(before.received.map((s) => s.nodes.length)).toEqual([1, 3, 4]));
    expect(before.ws.readyState).toBe(WebSocket.OPEN);

    // 終了後に新しくつないだクライアントにも、最後のマップがすぐ届く
    const after = await connect(server.port);
    await vi.waitFor(() => expect(after.received).toHaveLength(1));
    expect(after.received[0]!.nodes.map((n) => n.text)).toEqual(["週次", "採用", "面接は何回か", "2 回にする"]);

    // 終了後も export --format json で、書き出した map.json と同じマップを取り出せる
    expect(JSON.parse(await cli("export", "--format", "json"))).toEqual(JSON.parse(readFileSync(paths[1]!, "utf8")));
  });

  it(
    "ブラウザ（WebSocket のクライアント）を 1 つも開いていなくても、stop で map.png が書き出される。実物の撮影で、4 つ目のパスとして出る",
    { timeout: 120_000 },
    async () => {
      const { cli, calls, sessionDirs } = await setup({}, (await import("../src/capture.ts")).captureMap);
      await cli("start", "--app", "us.zoom.xos", "--title", "週次");
      await vi.waitFor(() => expect(calls.map((c) => c.fresh.map((u) => u.id))).toEqual([["r1", "r2"]]));

      const stdout = await cli("stop"); // どのクライアントも接続していない

      const [dir] = await sessionDirs();
      const paths = stdout.split("\n").filter((l) => l !== "");
      expect(paths).toHaveLength(4);
      expect(paths[3]).toBe(join(dir!, "map.png"));
      const png = readFileSync(paths[3]!);
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(png.length).toBeGreaterThan(1000);
    },
  );

  it("stop が map.png の撮影に渡すスナップショットは、書き出す map.json と同じマップ（1 回だけ取ったもの）", async () => {
    const received: Snapshot[] = [];
    const { cli, calls, sessionDirs } = await setup({}, async (snapshot, path) => {
      received.push(snapshot);
      writeFileSync(path, "");
    });
    await cli("start", "--app", "us.zoom.xos", "--title", "週次");
    await vi.waitFor(() => expect(calls.map((c) => c.fresh.map((u) => u.id))).toEqual([["r1", "r2"]]));
    await cli("stop");

    expect(received).toHaveLength(1);
    expect(received[0]!.nodes.map((n) => n.text)).toEqual(["週次", "採用", "面接は何回か", "2 回にする"]);
    const [dir] = await sessionDirs();
    expect(readFileSync(join(dir!, "map.json"), "utf8")).toContain("2 回にする");
  });

  it("map.png の撮影が失敗しても stop は成功し、3 つのテキストファイルのパスを出す。理由は標準エラーに残し、セッションは idle に戻る", async () => {
    const stderr = vi.spyOn(process.stderr, "write");
    cleanups.push(async () => stderr.mockRestore());
    const { cli, calls, sessionDirs } = await setup({}, async () => {
      throw new Error("撮影に失敗");
    });
    await cli("start", "--app", "us.zoom.xos", "--title", "週次");
    await vi.waitFor(() => expect(calls.map((c) => c.fresh.map((u) => u.id))).toEqual([["r1", "r2"]]));

    const stdout = await cli("stop");

    const [dir] = await sessionDirs();
    const paths = ["map.md", "map.json", "map.drawnix"].map((file) => join(dir!, file));
    expect(stdout.split("\n").filter((l) => l !== "")).toEqual(paths);
    for (const path of paths) expect(existsSync(path)).toBe(true);
    expect(existsSync(join(dir!, "map.png"))).toBe(false);
    expect(stderr.mock.calls.some(([chunk]) => String(chunk).includes("map.png を書き出せませんでした: 撮影に失敗"))).toBe(true);
    await expect(cli("stop")).rejects.toThrow("進行中のセッションがありません");
  });

  it("ヘルパーの途中結果は、トラックごとの speaking として届く。終了で両トラックとも空になる。途中結果は差分更新・ログ・マップに入らない", async () => {
    const { server, cli, calls, sessionDirs } = await setup();
    const before = await connect(server.port);

    await cli("start", "--app", "us.zoom.xos", "--title", "週次");

    // 最初のイベントは相手の途中結果。そのまま、相手の「いま話している文字」の最初の frame になる
    await vi.waitFor(() => expect(before.speaking.length).toBeGreaterThan(0));
    expect(before.speaking[0]).toEqual({ type: "speaking", track: "相手", text: PARTIAL_1 });
    // 確定した発言（反映前）も、そのトラックの frame に続けて出る
    await vi.waitFor(() => expect(before.speaking.some((f) => f.track === "自分" && f.text.includes("面接は何回にしますか"))).toBe(true));

    await cli("stop");

    // 終了で、両トラックの最後の frame は空（仮のノードが残らない）
    await vi.waitFor(() => {
      for (const track of ["相手", "自分"] as const) expect(before.speaking.filter((f) => f.track === track).at(-1)?.text).toBe("");
    });

    // 差分更新に渡るのは発言だけ（途中結果は渡らず、r の番号も進めない）
    for (const fresh of calls.flatMap((c) => c.fresh)) expect([PARTIAL_1, PARTIAL_2].some((p) => fresh.text.includes(p))).toBe(false);
    // スナップショットの frame（type を持たない既存の形）は、途中結果を含まない
    for (const snapshot of before.received) expect(JSON.stringify(snapshot)).not.toContain("途中結果");
    // ログ・map.json・map.md は、行・ファイルごとに途中結果の本文を含まない
    const [dir] = await sessionDirs();
    for (const e of await logEvents(dir!)) {
      expect(["start", "remark", "diff"]).toContain(e.type);
      expect(JSON.stringify(e)).not.toContain("途中結果");
    }
    for (const file of ["map.json", "map.md", "map.drawnix", "export.json"]) expect(readFileSync(join(dir!, file), "utf8")).not.toContain("途中結果");
  });

  it("speaking は終了すると空になる。終了後に新しくつないだクライアントには、最新のスナップショットだけが届く", async () => {
    const { server, cli } = await setup();
    await cli("start", "--app", "us.zoom.xos", "--title", "週次");
    await cli("stop");

    const after = await connect(server.port);
    await vi.waitFor(() => expect(after.received).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(after.speaking).toEqual([]);
  });

  it("stop が途中で失敗しても、接続中のクライアントの speaking は空になり、新しくつないだクライアントに古い speaking は届かない", async () => {
    const { server, cli, sessionDirs } = await setup();
    const before = await connect(server.port);
    await cli("start", "--app", "us.zoom.xos", "--title", "週次");
    await vi.waitFor(() => expect(before.speaking.some((f) => f.track === "相手" && f.text.includes("2 回にしましょう"))).toBe(true));

    // 未反映の発言（r3）のログ書き込みを失敗させるため、セッションのフォルダを消す
    const [dir] = await sessionDirs();
    rmSync(dir!, { recursive: true, force: true });
    await expect(cli("stop")).rejects.toThrow();

    await vi.waitFor(() => {
      for (const track of ["相手", "自分"] as const) expect(before.speaking.filter((f) => f.track === track).at(-1)?.text).toBe("");
    });
    const after = await connect(server.port);
    await vi.waitFor(() => expect(after.received).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(after.speaking).toEqual([]);
  });

  // 実時間で QUIET_MS 待つ（server.ts の sleep は外から差し替えられない）。待ちの配線が外れると stop 前の反映が起きず失敗する
  it(
    "stop の前に発言が 1 件だけ届き QUIET_MS 新しい発言が来ないとき、その 1 件で差分更新が呼ばれ、接続中のクライアントへ反映後のマップが届く",
    { timeout: QUIET_MS + 10_000 },
    async () => {
      const { server, cli, calls, writeScript } = await setup();
      writeScript({ events: [remark("相手", 1, 5, "採用の面接について")] });
      const before = await connect(server.port);

      await cli("start", "--app", "us.zoom.xos", "--title", "週次");

      await vi.waitFor(() => expect(calls.map((c) => c.fresh.map((u) => u.id))).toEqual([["r1"]]), { timeout: QUIET_MS + 5_000 });
      await vi.waitFor(() => expect(before.received.map((s) => s.round)).toEqual([0, 1]));

      await cli("stop");
    },
  );

  it("進行中の start は拒否され、進行中のセッションを壊さない。終了後は新しいセッションを開始できる。セッションがない stop も拒否される", async () => {
    const { cli, records, sessionDirs, writeScript } = await setup();

    await expect(cli("stop")).rejects.toThrow();
    expect(await sessionDirs()).toEqual([]);

    await cli("start", "--app", "us.zoom.xos", "--title", "1 つ目");
    await expect(cli("start", "--app", "us.zoom.xos", "--title", "2 つ目")).rejects.toThrow();
    expect(records().filter((r) => r.type === "run")).toHaveLength(1);
    expect(await sessionDirs()).toHaveLength(1);

    await cli("stop"); // 拒否された start の後でも、1 つ目のセッションを終了できる
    expect(JSON.parse(await cli("export", "--format", "json")).root.text).toBe("1 つ目");
    await expect(cli("stop")).rejects.toThrow();

    writeScript({ events: [] });
    await cli("start", "--app", "us.zoom.xos", "--title", "2 つ目");
    await cli("stop");
    expect(await sessionDirs()).toHaveLength(2);
  });

  it("発言が 1 件も来ないセッションでも、終了後の export は、前のセッションではなくそのセッションのマップを返す", async () => {
    const { cli, writeScript } = await setup();
    await cli("start", "--app", "us.zoom.xos", "--title", "前");
    await cli("stop");

    writeScript({ events: [] });
    await cli("start", "--app", "us.zoom.xos", "--title", "今");
    await cli("stop");

    expect(JSON.parse(await cli("export", "--format", "json")).root).toMatchObject({ kind: "会議", text: "今", children: [] });
  });

  it("ヘルパーが起動に失敗すると、start はその stderr を伝えて失敗し、セッションは開始されないまま、続けて start できる", async () => {
    const { cli, writeScript, records } = await setup({ failRun: { stderr: "マイクが許可されていません", code: 1 } });

    await expect(cli("start", "--app", "us.zoom.xos")).rejects.toThrow("マイクが許可されていません");
    await expect(cli("stop")).rejects.toThrow(); // 進行中のセッションはない

    writeScript({});
    await cli("start", "--app", "us.zoom.xos");
    await vi.waitFor(() => expect(records().filter((r) => r.type === "connection")).toHaveLength(1));
    await cli("stop");
  });

  it("開始に失敗しても、接続中のクライアントにも新しく接続したクライアントにも、空のマップは届かず、前のセッションの最後のマップが残る", async () => {
    const { server, cli, writeScript } = await setup();
    await cli("start", "--app", "us.zoom.xos", "--title", "前");
    await cli("stop");
    const before = await connect(server.port);
    await vi.waitFor(() => expect(before.received).toHaveLength(1));

    writeScript({ failRun: { stderr: "マイクが許可されていません", code: 1 } });
    await expect(cli("start", "--app", "us.zoom.xos", "--title", "失敗")).rejects.toThrow("マイクが許可されていません");

    const after = await connect(server.port);
    await vi.waitFor(() => expect(after.received).toHaveLength(1));
    expect(after.received[0]!.nodes.map((n) => n.text)).toEqual(["前", "採用", "面接は何回か", "2 回にする"]);

    writeScript({ events: [] });
    await cli("start", "--app", "us.zoom.xos", "--title", "次");
    await cli("stop");
    await vi.waitFor(() => expect(before.received.map((s) => [s.nodes.length, s.nodes[0]!.text])).toEqual([[4, "前"], [1, "次"]]));
  });

  it("差分更新の updater は、セッションの開始で 1 つ開き、stop で閉じる。次のセッションは新しく開く", async () => {
    const { cli, updaters, calls } = await setup();
    expect(updaters).toMatchObject({ opened: 0, closed: 0 }); // サーバーを起動しただけでは開かない

    await cli("start", "--app", "us.zoom.xos", "--title", "1 つ目");
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(updaters).toMatchObject({ opened: 1, closed: 0 }); // 会議中は閉じない（発言のたびに開き直さない）

    await cli("stop");
    expect(updaters).toMatchObject({ opened: 1, closed: 1 });

    await cli("start", "--app", "us.zoom.xos", "--title", "2 つ目");
    await cli("stop");
    expect(updaters).toMatchObject({ opened: 2, closed: 2 });
  });

  it("stop が途中で失敗しても、updater は閉じられる", async () => {
    const { cli, updaters, sessionDirs } = await setup();
    await cli("start", "--app", "us.zoom.xos", "--title", "週次");
    const [dir] = await sessionDirs();
    rmSync(dir!, { recursive: true, force: true });

    await expect(cli("stop")).rejects.toThrow();

    expect(updaters).toMatchObject({ opened: 1, closed: 1 });
  });

  it("stop は、最後の差分更新が終わってから updater を閉じる（閉じたあとに呼ばれない）", async () => {
    const { cli, calls, updaters } = await setup();
    await cli("start", "--app", "us.zoom.xos", "--title", "週次");

    await cli("stop"); // stop の flush で r3 の差分更新が走る

    expect(calls.map((c) => c.fresh.map((u) => u.id))).toEqual([["r1", "r2"], ["r3"]]);
    expect(updaters).toMatchObject({ closed: 1, callsAfterClose: 0 });
  });

  it("ヘルパーにつないだ後（updater を開いた後）に、セッションのフォルダを作れず start が失敗しても、開いた updater は閉じられる", async () => {
    const { cli, updaters, sessionsDir } = await setup();
    writeFileSync(sessionsDir, ""); // フォルダの位置に通常ファイルがあり、mkdir できない

    await expect(cli("start", "--app", "us.zoom.xos")).rejects.toThrow();

    expect(updaters).toMatchObject({ opened: 1, closed: 1 });
  });

  it("進行中にサーバーが終わるとき、updater を閉じる", async () => {
    const { server, cli, updaters } = await setup();
    await cli("start", "--app", "us.zoom.xos");
    expect(updaters).toMatchObject({ opened: 1, closed: 0 });

    await server.close();

    expect(updaters).toMatchObject({ opened: 1, closed: 1 });
  });

  it("セッションが無いままサーバーが終わっても、updater は開かれない", async () => {
    const { server, updaters } = await setup();

    await server.close();

    expect(updaters).toMatchObject({ opened: 0, closed: 0 });
  });

  it("サーバーが終わるとき、起動していたヘルパーの子プロセスを残さない", async () => {
    const { server, cli, records } = await setup();
    await cli("start", "--app", "us.zoom.xos");
    const run = records().find((r) => r.type === "run");
    if (run?.type !== "run") throw new Error("ヘルパーが起動していない");
    expect(() => process.kill(run.pid, 0)).not.toThrow(); // 生きている

    await server.close();

    await vi.waitFor(() => expect(() => process.kill(run.pid, 0)).toThrow());
  });

  // 実時間で HELPER_STOP_TIMEOUT_MS 待つ（QUIET_MS と同じく、定数を export して実時間で確かめる）
  it(
    "ヘルパーが SIGTERM で終わらなくても、stop は時間内に戻り、それまでの発言でマップを確定して 4 つのファイルを書き、SIGKILL に切り替えたことを標準エラーに残す。同じサーバーで次のセッションも開始・終了できる",
    { timeout: HELPER_STOP_TIMEOUT_MS + 10_000 },
    async () => {
      const stderr = vi.spyOn(process.stderr, "write");
      cleanups.push(async () => stderr.mockRestore());
      const { cli, calls, records, sessionDirs, writeScript } = await setup({ ignoreSigterm: true });
      await cli("start", "--app", "us.zoom.xos", "--title", "週次");
      await vi.waitFor(() => expect(calls.map((c) => c.fresh.map((u) => u.id))).toEqual([["r1", "r2"]]));
      const run = records().find((r) => r.type === "run");
      if (run?.type !== "run") throw new Error("ヘルパーが起動していない");

      const startedAt = Date.now();
      const stdout = await cli("stop");
      const elapsed = Date.now() - startedAt;

      expect(elapsed).toBeLessThan(HELPER_STOP_TIMEOUT_MS + 3_000);
      const [dir] = await sessionDirs();
      const paths = [join(dir!, "map.md"), join(dir!, "map.json"), join(dir!, "map.drawnix"), join(dir!, "map.png")];
      expect(stdout.split("\n").filter((l) => l !== "")).toEqual(paths);
      for (const path of paths) expect(existsSync(path)).toBe(true);
      // 届いていた発言（r1〜r3）で確定している
      expect(calls.map((c) => c.fresh.map((u) => u.id))).toEqual([["r1", "r2"], ["r3"]]);
      expect(readFileSync(paths[1]!, "utf8")).toContain("2 回にする");
      expect(readFileSync(paths[0]!, "utf8")).toContain("2 回にする");
      // まず SIGTERM を送り、その後 SIGKILL で子を残さない
      expect(records().filter((r) => r.type === "signal")).toEqual([{ type: "signal", signal: "SIGTERM" }]);
      expect(() => process.kill(run.pid, 0)).toThrow();
      expect(stderr.mock.calls.some(([chunk]) => String(chunk).includes("SIGKILL"))).toBe(true);

      // stop の後も、同じサーバーで次のセッションを開始・終了できる
      writeScript({ events: [] });
      await cli("start", "--app", "us.zoom.xos", "--title", "次");
      await cli("stop");
      expect(await sessionDirs()).toHaveLength(2);
    },
  );

  it(
    "ヘルパーが SIGTERM で終わらなくても、サーバーの close は時間内に戻り、子プロセスを残さない",
    { timeout: HELPER_STOP_TIMEOUT_MS + 10_000 },
    async () => {
      const { server, cli, records } = await setup({ ignoreSigterm: true });
      await cli("start", "--app", "us.zoom.xos");
      await vi.waitFor(() => expect(records().filter((r) => r.type === "connection")).toHaveLength(1));
      const run = records().find((r) => r.type === "run");
      if (run?.type !== "run") throw new Error("ヘルパーが起動していない");

      const startedAt = Date.now();
      await server.close();

      expect(Date.now() - startedAt).toBeLessThan(HELPER_STOP_TIMEOUT_MS + 3_000);
      expect(() => process.kill(run.pid, 0)).toThrow();
    },
  );

  it("freePort の待機中に close() が始まったら、start はヘルパーを起動せずに失敗する", async () => {
    const { server, cli, records } = await setup();
    gate.hold();
    const started = cli("start", "--app", "us.zoom.xos").then(
      () => undefined,
      (e: unknown) => e,
    );
    await gate.called();

    await server.close();
    gate.state.release();
    await new Promise((resolve) => setImmediate(resolve));

    expect(vi.mocked(spawn).mock.calls.filter((c) => c[1]?.includes("run"))).toHaveLength(0);
    expect(records().filter((r) => r.type === "run")).toHaveLength(0);
    expect(await started).toBeInstanceOf(Error);
  });

  it("ブラウザ上の他のサイト（ローカル以外の Origin）からの開始要求は、ヘルパーを起動せずに拒否する", async () => {
    const { server, records } = await setup();

    const response = await fetch(`http://127.0.0.1:${server.port}/session/start`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ app: "us.zoom.xos" }),
    });

    expect(response.status).toBe(403);
    expect(records().filter((r) => r.type === "run")).toHaveLength(0);
  });
});
