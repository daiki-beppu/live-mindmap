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
// partial は、確定結果に覆われたとき（区間の中央が、直後の確定結果の区間に入る）は発言にならない（r の番号を消費しない）。
// 本文は、マップにもログにも出ない専用の文字列
const PARTIAL_1 = "はじまりの途中結果";
const PARTIAL_2 = "にかいめの途中結果";
const EVENTS = [
  { type: "partial", track: "相手", start: 1, end: 3, text: PARTIAL_1 },
  remark("相手", 1, 5, "採用の面接について"),
  remark("自分", 6, 9, "面接は何回にしますか"),
  { type: "partial", track: "相手", start: 19.2, end: 25, text: PARTIAL_2 },
  remark("相手", 19.2, 28, "2 回にしましょう"),
];

const OPS: Op[][] = [
  [
    { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
    { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: ["r2"] },
  ],
  [{ op: "add", ref: "t3", parent: "n2", kind: "決定", text: "2 回にする", evidence: ["r3"] }],
];

type Script = {
  apps: unknown;
  events: unknown[];
  delayedEvents?: { afterMs: number; event: unknown }[];
  failRun?: { stderr: string; code: number };
  ignoreSigterm?: boolean;
  originHostTime?: string;
  unexpectedExit?: { afterMs: number; code?: number; signal?: NodeJS.Signals };
  attempts?: Partial<Script>[];
  listenDelayMs?: number;
  stderrLines?: string[];
};
type HelperRecord =
  | { type: "run"; argv: string[]; pid: number; attempt: number }
  | { type: "connection" }
  | { type: "signal"; signal: string }
  | { type: "unexpectedExit"; code?: number; signal?: string };

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

// つないだクライアントに届いた frame を、スナップショットと speaking（いま話している文字）に分けて貯める。
// 状態のフレーム（type: "intake" 等。Issue #161）はスナップショットではないので、ここでは無視する
// （スナップショットは type を持たない。connectClassified と同じ振り分け規則）
async function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const received: Snapshot[] = [];
  const speaking: SpeakingFrame[] = [];
  ws.addEventListener("message", (e) => {
    const frame = JSON.parse(String(e.data));
    if (frame.type === "speaking") speaking.push(frame);
    else if (!("type" in frame)) received.push(frame);
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

  it("ヘルパーの途中結果は、トラックごとの speaking として届く。終了で両トラックとも空になる。確定結果に覆われた途中結果は差分更新・ログ・マップに入らない", async () => {
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

  it(
    "確定結果が来なくても、相手の途中結果は 1 秒更新されなければ、最後の本文・区間で発言が 1 件、差分更新に渡る。ID は r1 で、ログにも発言として残る",
    { timeout: 20_000 },
    async () => {
      const { cli, calls, sessionDirs } = await setup({
        events: [
          { type: "partial", track: "相手", start: 5, end: 6, text: "あしたの" },
          { type: "partial", track: "相手", start: 5, end: 8, text: "あしたの会議は" },
        ],
      });
      await cli("start", "--app", "us.zoom.xos", "--title", "週次");

      await vi.waitFor(() => expect(calls.flatMap((c) => c.fresh)).toHaveLength(1), { timeout: 10_000 });
      expect(calls.flatMap((c) => c.fresh)[0]).toMatchObject({ id: "r1", track: "相手", start: 5, end: 8, text: "あしたの会議は" });

      await cli("stop");

      expect(calls.flatMap((c) => c.fresh)).toHaveLength(1); // 停止で増えない
      const [dir] = await sessionDirs();
      const remarks = (await logEvents(dir!)).filter((e) => e.type === "remark");
      expect(remarks.map((e) => [e.remark.id, e.remark.text])).toEqual([["r1", "あしたの会議は"]]);
    },
  );

  it(
    "出した後に届いた確定結果は捨てる。発言は増えず、次の発言の ID は r2 で番号が飛ばない",
    { timeout: 20_000 },
    async () => {
      const { cli, calls, sessionDirs } = await setup({
        events: [{ type: "partial", track: "相手", start: 5, end: 8, text: "あしたの会議" }],
        delayedEvents: [
          { afterMs: 2_000, event: remark("相手", 5.2, 8.2, "明日の会議は十時です。") }, // r1 を覆う確定結果。本文が違っても捨てる
          { afterMs: 2_200, event: remark("相手", 30, 32, "べつの確定結果") },
        ],
      });
      await cli("start", "--app", "us.zoom.xos", "--title", "週次");

      await vi.waitFor(() => expect(calls.flatMap((c) => c.fresh).map((u) => [u.id, u.text])).toEqual([["r1", "あしたの会議"], ["r2", "べつの確定結果"]]), {
        timeout: 10_000,
      });
      await cli("stop");

      const fresh = calls.flatMap((c) => c.fresh);
      expect(fresh.map((u) => u.id)).toEqual(["r1", "r2"]);
      expect(fresh.some((u) => u.text.includes("十時です"))).toBe(false);
      const [dir] = await sessionDirs();
      const remarks = (await logEvents(dir!)).filter((e) => e.type === "remark");
      expect(remarks.map((e) => [e.remark.id, e.remark.text])).toEqual([["r1", "あしたの会議"], ["r2", "べつの確定結果"]]);
    },
  );

  it("停止は、まだ出ていない発話を落とさない。stop の後に、途中結果の最後の本文が差分更新に渡っている", { timeout: 20_000 }, async () => {
    const { cli, calls } = await setup({ events: [{ type: "partial", track: "相手", start: 5, end: 8, text: "とちゅうでとめた" }] });
    await cli("start", "--app", "us.zoom.xos", "--title", "週次");

    await cli("stop");

    expect(calls.flatMap((c) => c.fresh).map((u) => [u.id, u.text])).toEqual([["r1", "とちゅうでとめた"]]);
  });

  it("自分の途中結果は、1 秒を超えても発言にならない（相手の同じ入力は発言になる）。自分の発言は確定結果だけから作られる", { timeout: 20_000 }, async () => {
    const { cli, calls, sessionDirs } = await setup({
      events: [
        { type: "partial", track: "相手", start: 5, end: 6, text: "あいてのとちゅう" },
        { type: "partial", track: "自分", start: 5, end: 6, text: "じぶんのとちゅう" },
        remark("自分", 20, 22, "じぶんの確定結果"),
      ],
    });
    await cli("start", "--app", "us.zoom.xos", "--title", "週次");

    // 守っている状態に到達する: 相手の途中結果は T 経って出ている（自分の途中結果は同時に届いており、出るなら同じ時刻に出る）
    await vi.waitFor(() => expect(calls.flatMap((c) => c.fresh).some((u) => u.text === "あいてのとちゅう")).toBe(true), { timeout: 10_000 });
    await cli("stop");

    const fresh = calls.flatMap((c) => c.fresh);
    expect(fresh.map((u) => [u.track, u.text])).toEqual(
      expect.arrayContaining([
        ["相手", "あいてのとちゅう"],
        ["自分", "じぶんの確定結果"],
      ]),
    );
    expect(fresh).toHaveLength(2);
    expect(fresh.some((u) => u.text === "じぶんのとちゅう")).toBe(false);
    const [dir] = await sessionDirs();
    expect((await logEvents(dir!)).filter((e) => e.type === "remark")).toHaveLength(2);
  });

  it("ヘルパーが重複の印を付けた自分の途中結果は字幕（speaking）に出ない。印のない自分の途中結果は出る", async () => {
    const LEAKED = "もれたあいてのこえ";
    const OWN = "じぶんのこえ";
    const { server, cli } = await setup({
      events: [
        { type: "partial", track: "自分", start: 1, end: 2, text: LEAKED, duplicate: true },
        { type: "partial", track: "自分", start: 3, end: 4, text: OWN, duplicate: false },
      ],
    });
    const before = await connect(server.port);
    await cli("start", "--app", "us.zoom.xos", "--title", "週次");

    // 守っている状態に到達する: 印のない自分の途中結果は字幕に出る（印付きは、その前に届いている）
    await vi.waitFor(() => expect(before.speaking.some((f) => f.track === "自分" && f.text.includes(OWN))).toBe(true));
    await cli("stop");

    expect(before.speaking.filter((f) => f.track === "自分").some((f) => f.text.includes(LEAKED))).toBe(false);
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

  it("セッションのフォルダを作れず start が失敗しても、ヘルパーも updater も起動せず、フォルダを直せば続けて start できる", async () => {
    const { cli, records, updaters, sessionsDir } = await setup();
    writeFileSync(sessionsDir, ""); // フォルダの位置に通常ファイルがあり、mkdir できない

    await expect(cli("start", "--app", "us.zoom.xos")).rejects.toThrow();

    expect(records().filter((r) => r.type === "run")).toHaveLength(0);
    expect(updaters).toMatchObject({ opened: 0, closed: 0 });

    rmSync(sessionsDir);
    await cli("start", "--app", "us.zoom.xos");
    await cli("stop");
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
    { timeout: 2 * HELPER_STOP_TIMEOUT_MS + 10_000 },
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
      // 録音していたので、録音の書き終わりを確認できなかったことも標準エラーに残す
      expect(stderr.mock.calls.some(([chunk]) => String(chunk).includes("録音の書き終わりを確認できない"))).toBe(true);

      // 録音していないセッションでは、強制終了しても録音の警告は出さない
      stderr.mockClear();
      writeScript({ events: [], ignoreSigterm: true });
      await cli("start", "--app", "us.zoom.xos", "--title", "録音なし", "--no-audio");
      await cli("stop");
      expect(stderr.mock.calls.some(([chunk]) => String(chunk).includes("SIGKILL"))).toBe(true);
      expect(stderr.mock.calls.some(([chunk]) => String(chunk).includes("録音の書き終わり"))).toBe(false);

      // stop の後も、同じサーバーで次のセッションを開始・終了できる
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

  describe("録音", () => {
    const audioDirArg = (argv: string[]) => argv[argv.indexOf("--audio-dir") + 1];

    it("既定の start は、ヘルパーに --audio-dir としてセッションのフォルダ（log.jsonl があるフォルダ）を渡す", async () => {
      const { cli, records, sessionDirs } = await setup();

      await cli("start", "--app", "us.zoom.xos");

      const argv = records().find((r) => r.type === "run")!.argv;
      expect(argv).toContain("--audio-dir");
      const dirs = await sessionDirs();
      expect(dirs).toHaveLength(1);
      expect(audioDirArg(argv)).toBe(dirs[0]);
      expect(existsSync(join(dirs[0]!, "log.jsonl"))).toBe(true);
      await cli("stop");
    });

    it("start に --no-audio を付けると、ヘルパーに --audio-dir を渡さず、セッションのフォルダに録音ファイルができない", async () => {
      const { cli, records, sessionDirs } = await setup();

      await cli("start", "--app", "us.zoom.xos", "--no-audio");
      await cli("stop");

      expect(records().find((r) => r.type === "run")!.argv).not.toContain("--audio-dir");
      const [dir] = await sessionDirs();
      expect(existsSync(join(dir!, "相手.m4a"))).toBe(false);
      expect(existsSync(join(dir!, "自分.m4a"))).toBe(false);
    });

    it("HTTP の body に audio がなければ録音し、audio: false なら録音しない", async () => {
      const { server, records } = await setup();
      const post = (body: object) =>
        fetch(`http://127.0.0.1:${server.port}/session/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const stop = () => fetch(`http://127.0.0.1:${server.port}/session/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

      expect((await post({ app: "us.zoom.xos" })).status).toBe(200);
      expect((await stop()).status).toBe(200);
      expect((await post({ app: "us.zoom.xos", audio: false })).status).toBe(200);
      expect((await stop()).status).toBe(200);

      const runs = records().filter((r) => r.type === "run");
      expect(runs.map((r) => r.argv.includes("--audio-dir"))).toEqual([true, false]);
    });

    it("body の audio が boolean 以外なら 400 を返し、ヘルパーを起動せず、セッションのフォルダも作らない", async () => {
      const { server, records, sessionDirs } = await setup();

      for (const audio of ["no", 0, "false"]) {
        const response = await fetch(`http://127.0.0.1:${server.port}/session/start`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ app: "us.zoom.xos", audio }),
        });
        expect(response.status).toBe(400);
      }

      expect(records().filter((r) => r.type === "run")).toHaveLength(0);
      expect(await sessionDirs()).toEqual([]);
    });

    it("stop は、ヘルパーが録音を書き終えて終了するまで待ち、戻った時点で 2 つの録音が最後まで書かれている", async () => {
      const stderr = vi.spyOn(process.stderr, "write");
      cleanups.push(async () => stderr.mockRestore());
      const { cli, sessionDirs } = await setup();
      await cli("start", "--app", "us.zoom.xos");

      await cli("stop");

      // 強制終了していないので、録音の警告は出ない
      expect(stderr.mock.calls.some(([chunk]) => String(chunk).includes("録音の書き終わり"))).toBe(false);
      const [dir] = await sessionDirs();
      for (const name of ["相手.m4a", "自分.m4a"]) {
        expect(readFileSync(join(dir!, name), "utf8")).toBe("complete");
      }
      // 録音を待った後に、セッションの書き出しまで終わっている
      expect(existsSync(join(dir!, "map.json"))).toBe(true);
    });

    it("stop の標準出力は、録音のパスを足さず、これまでどおり 4 つのパスだけ", async () => {
      const { cli } = await setup();
      await cli("start", "--app", "us.zoom.xos");

      const stdout = await cli("stop");

      expect(stdout.split("\n").filter((l) => l !== "").map((p) => p.split("/").pop())).toEqual(["map.md", "map.json", "map.drawnix", "map.png"]);
    });
  });
});

// Issue #161: ヘルパーが予期せず終わっても、サーバーはヘルパーを起動し直し、同じセッションへ発言を流し続ける。
// 止まり方（落ちる／エラーで終わる）で扱いを分けない（order.md:42）ので、テストは code・signal の両方を使う。
describe("ヘルパーが予期せず終わったときの、起動し直し・諦め・resume（Issue #161）", () => {
  const runs = (records: ReturnType<Awaited<ReturnType<typeof setup>>["records"]>) => records.filter((r) => r.type === "run");

  // 届いた frame を、スナップショット（type なし）・speaking（type === "speaking"）・それ以外（状態のフレームの候補）に分ける。
  // useLiveFeed.ts の振り分け規則（CT-FRAME-DISPATCH）と同じ分類で、配信（ws.ts）側の契約だけを確かめる
  async function connectClassified(port: number) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const snapshots: Snapshot[] = [];
    const speaking: SpeakingFrame[] = [];
    const other: Record<string, unknown>[] = [];
    ws.addEventListener("message", (e) => {
      const frame = JSON.parse(String(e.data));
      if (frame && typeof frame === "object" && "type" in frame) {
        if (frame.type === "speaking") speaking.push(frame);
        else other.push(frame);
      } else {
        snapshots.push(frame);
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("接続できない")));
    });
    cleanups.push(async () => ws.close());
    return { ws, snapshots, speaking, other };
  }

  it(
    "予期せず終了すると、同じセッション（同じフォルダ・同じ log.jsonl・同じマップ）へ起動し直す。発言の ID は起動し直しをまたいで重複しない（SCN-CT-REMARK-ID-P1 / N1）",
    { timeout: 20_000 },
    async () => {
      const { server, cli, calls, records, sessionDirs, updaters } = await setup({
        events: [],
        attempts: [
          { events: [remark("相手", 1, 5, "採用の面接について"), remark("自分", 6, 9, "面接は何回にしますか")], unexpectedExit: { afterMs: 500, code: 1 } },
          { events: [remark("相手", 19, 21, "次の議題です")] },
        ],
      });
      const before = await connect(server.port); // 接続を保ったままのクライアント

      await cli("start", "--app", "us.zoom.xos", "--title", "週次");
      // 1 回目は 2 件の発言が BATCH（2 件）に達してすぐ反映される（QUIET_MS を待たない）
      await vi.waitFor(() => expect(calls.flatMap((c) => c.fresh).map((u) => u.id)).toEqual(["r1", "r2"]), { timeout: 10_000 });
      // 1 回目が終了し、2 回目が自動で起動する。updater は開き直されない（同じセッションのまま）
      await vi.waitFor(() => expect(runs(records())).toHaveLength(2), { timeout: 10_000 });
      expect(updaters).toMatchObject({ opened: 1, closed: 0 });
      expect(await sessionDirs()).toHaveLength(1); // 新しいセッションのフォルダは作られない

      // 2 回目の発言（r3）が届くのは wireListen をセットアップした後なので、この時点で起動し直しは
      // 確実に成功している。cli status の「起動し直した回数」が、成功した回数（1）を値として示すことを確認する
      // （0 のケースしか検証されていないという companion 指摘への対応。回帰で成功後も常に 0 を返すのを検出する）
      await vi.waitFor(() => expect(calls.flatMap((c) => c.fresh).some((u) => u.id === "r3")).toBe(true), { timeout: 10_000 });
      expect(await cli("status")).toContain("起動し直した回数: 1");

      await cli("stop"); // flush() が、2 回目で届いた 1 件（r3）を落とさずに反映する

      const [dir] = await sessionDirs();
      const events = await logEvents(dir!);
      const remarkIds = events.filter((e) => e.type === "remark").map((e) => e.remark.id);
      expect(remarkIds).toEqual(["r1", "r2", "r3"]); // r1・r2 が再利用されず、通し番号で重複もない
      expect(new Set(remarkIds).size).toBe(remarkIds.length);
      expect(calls.flatMap((c) => c.fresh).map((u) => [u.id, u.text])).toEqual([
        ["r1", "採用の面接について"],
        ["r2", "面接は何回にしますか"],
        ["r3", "次の議題です"],
      ]);

      // 接続を保ったままのクライアントにも、起動し直しをまたいで反映が届き続ける
      await vi.waitFor(() => expect(before.received.map((s) => s.nodes.length).at(-1)).toBeGreaterThan(1));

      // マップには途切れ・起動し直しの情報が入らない
      for (const file of ["map.json", "map.md", "map.drawnix", "export.json"]) {
        const content = readFileSync(join(dir!, file), "utf8");
        for (const word of ["途切れ", "起動し直", "諦め", "intake"]) expect(content).not.toContain(word);
      }
      await server.close();
    },
  );

  it(
    "起動し直しに成功して動いている状態へ戻ると、途中から接続したクライアントにも {type:\"intake\",status:\"running\"} が届く（SCN-U-A-P2）",
    { timeout: 20_000 },
    async () => {
      const { server, cli, records } = await setup({
        events: [],
        attempts: [{ unexpectedExit: { afterMs: 500, code: 1 } }, { events: [remark("相手", 1, 5, "いちかいめ")] }],
      });
      await cli("start", "--app", "us.zoom.xos", "--title", "週次");
      await vi.waitFor(() => expect(runs(records())).toHaveLength(2), { timeout: 10_000 });
      await vi.waitFor(async () => expect(await cli("status")).toContain("動いている"), { timeout: 10_000 });

      // 起動し直しが成功した後に接続したクライアント（途中から参加したブラウザ）にも、今の状態（動いている）が届く。
      // 保持していなければ、何も届かないまま（CT-LATE-JOIN の running への拡張）
      const after = await connectClassified(server.port);
      await vi.waitFor(() => expect(after.snapshots.length).toBeGreaterThan(0));
      await vi.waitFor(() => expect(after.other).toEqual([{ type: "intake", status: "running" }]));

      await cli("stop");
      await server.close();
    },
  );

  it("途切れた瞬間に残っていた途中結果は、settling.drain() と同じ規則で発言になる（CT-DRAIN）。字幕はその瞬間に空になるが、以後も送れる状態を保つ（CT-SPEAKING-CLEAR）", { timeout: 20_000 }, async () => {
    const { server, cli, calls, sessionDirs } = await setup({
      events: [],
      attempts: [
        { events: [{ type: "partial", track: "相手", start: 1, end: 3, text: "とちゅうでとぎれたはなし" }], unexpectedExit: { afterMs: 500, code: 1 } },
        { events: [{ type: "partial", track: "相手", start: 20, end: 22, text: "さいかいしたはなし" }] },
      ],
    });
    const before = await connect(server.port);
    await cli("start", "--app", "us.zoom.xos", "--title", "週次");

    await vi.waitFor(() => expect(before.speaking.some((f) => f.track === "相手" && f.text.includes("とちゅうでとぎれたはなし"))).toBe(true));
    // 途切れた直後、相手トラックの最後の speaking frame は空になる（覆われなかった途中結果は発言として drain される）。
    // SETTLE_QUIET_MS（1 秒）より十分短い時間で確かめ、「1 秒更新がなければ発言にする」既存の自然な確定（settle.ts）が
    // たまたま間に合って偽成功にならないようにする（crash は接続後 afterMs=500ms で起こす）。
    // 既定で録音（--audio-dir）が付くので、fake-helper は crash の signal を送る前に AUDIO_FLUSH_MS（300ms）分の
    // 録音の書き終わりを待ってから終了する（実物のヘルパーも、録音を閉じてから WebSocket を止める。helper/README.md）。
    // そのため実際の無音化は afterMs + AUDIO_FLUSH_MS 付近まで遅れる。900ms はその実測の遅れを含みつつ、
    // SETTLE_QUIET_MS（1000ms）の自然な確定より十分短い
    await vi.waitFor(() => expect(before.speaking.filter((f) => f.track === "相手").at(-1)?.text).toBe(""), { timeout: 900 });
    // 起動し直し後、字幕がまた届く（speaking.stop() のように永久停止していない）
    await vi.waitFor(() => expect(before.speaking.some((f) => f.track === "相手" && f.text.includes("さいかいしたはなし"))).toBe(true), { timeout: 10_000 });

    await cli("stop");

    // drain された途中結果は、発言として差分更新とログに入っている
    expect(calls.flatMap((c) => c.fresh).some((u) => u.text === "とちゅうでとぎれたはなし")).toBe(true);
    const [dir] = await sessionDirs();
    const events = await logEvents(dir!);
    expect(events.some((e) => e.type === "remark" && e.remark.text === "とちゅうでとぎれたはなし")).toBe(true);
    await server.close();
  });

  it("起動し直したヘルパーの argv には、最初のヘルパーから届いた原点（--origin）が、文字列のまま変わらず渡る", { timeout: 20_000 }, async () => {
    const { server, cli, records } = await setup({
      events: [],
      attempts: [
        { originHostTime: "9007199254740993", events: [remark("相手", 1, 5, "いちかいめ")], unexpectedExit: { afterMs: 500, code: 1 } },
        { events: [remark("相手", 6, 9, "にかいめ")] },
      ],
    });
    await cli("start", "--app", "us.zoom.xos", "--title", "週次");

    await vi.waitFor(() => expect(runs(records())).toHaveLength(2), { timeout: 10_000 });
    const [first, second] = runs(records());
    if (first?.type !== "run" || second?.type !== "run") throw new Error("起動していない");
    expect(first.argv).not.toContain("--origin"); // 1 回目は、まだ原点を受け取る前に起動している
    const originIndex = second.argv.indexOf("--origin");
    expect(originIndex).toBeGreaterThan(-1);
    expect(second.argv[originIndex + 1]).toBe("9007199254740993"); // 2^53 を超えても桁が落ちない

    await cli("stop");
    await server.close();
  });

  it("ヘルパーが壊れた原点のイベントを送っても、セッションは壊れず、原点として保持されない（起動し直しの argv にも現れない）", { timeout: 20_000 }, async () => {
    const stderr = vi.spyOn(process.stderr, "write");
    cleanups.push(async () => stderr.mockRestore());
    const { server, cli, records, calls } = await setup({
      events: [{ type: "origin", hostTime: 123 }, remark("相手", 1, 5, "いちかいめ")], // hostTime が number（壊れた形）
      attempts: [{ unexpectedExit: { afterMs: 500, code: 1 } }, { events: [remark("相手", 6, 9, "にかいめ")] }],
    });
    await cli("start", "--app", "us.zoom.xos", "--title", "週次");

    // 壊れたイベントは読み飛ばされ（例外は catch されて標準エラーに残るだけ）、他の発言は普通に届く
    await vi.waitFor(() => expect(calls.flatMap((c) => c.fresh).some((u) => u.text === "いちかいめ")).toBe(true), { timeout: 10_000 });
    await vi.waitFor(() => expect(runs(records())).toHaveLength(2), { timeout: 10_000 });
    const [, second] = runs(records());
    if (second?.type !== "run") throw new Error("2 回目のヘルパーが起動していない");
    expect(second.argv).not.toContain("--origin"); // 壊れたイベントからは原点を採用しない

    await cli("stop");
    await server.close();
  });

  describe("録音ファイルの番号（起動し直しのたびに増える）", () => {
    it("1 回目の名前（相手.m4a・自分.m4a）は変えず、2 回目以降は -2・-3 の番号が付き、前の回のファイルは残る", { timeout: 20_000 }, async () => {
      const { cli, records, sessionDirs } = await setup({
        events: [],
        attempts: [{ unexpectedExit: { afterMs: 500, code: 1 } }, { unexpectedExit: { afterMs: 500, code: 1 } }, { events: [] }],
      });
      await cli("start", "--app", "us.zoom.xos", "--title", "週次");
      const [dir] = await sessionDirs();

      // 1・2 回目は自分で終わって録音を書き終える。3 回目は stop で終わるまで録音を書き終えない
      await vi.waitFor(() => expect(runs(records())).toHaveLength(3), { timeout: 10_000 });
      await vi.waitFor(() => {
        for (const name of ["相手.m4a", "自分.m4a", "相手-2.m4a", "自分-2.m4a"]) expect(readFileSync(join(dir!, name), "utf8")).toBe("complete");
      });

      await cli("stop");

      for (const name of ["相手-3.m4a", "自分-3.m4a"]) expect(existsSync(join(dir!, name))).toBe(true);
      // 1・2 回目のファイルは、後の起動で上書きされていない（最後まで書き終えた内容のまま）
      for (const name of ["相手.m4a", "自分.m4a", "相手-2.m4a", "自分-2.m4a"]) expect(readFileSync(join(dir!, name), "utf8")).toBe("complete");
    });
  });

  // 実時間で HELPER_STOP_TIMEOUT_MS 待つ（既存の SIGKILL テストと同じ timeout 指定に揃える）
  it(
    "起動し直した後に SIGTERM で終わらないヘルパーを SIGKILL で止めると、警告はその起動回（attempt 2）の録音ファイル名を示す（SCN-U-C-P1）",
    { timeout: 2 * HELPER_STOP_TIMEOUT_MS + 10_000 },
    async () => {
      const stderr = vi.spyOn(process.stderr, "write");
      cleanups.push(async () => stderr.mockRestore());
      const { cli, records } = await setup({
        events: [],
        attempts: [{ unexpectedExit: { afterMs: 500, code: 1 } }, { ignoreSigterm: true }],
      });
      await cli("start", "--app", "us.zoom.xos", "--title", "週次");
      await vi.waitFor(() => expect(runs(records())).toHaveLength(2), { timeout: 10_000 });
      await vi.waitFor(async () => expect(await cli("status")).toContain("動いている"), { timeout: 10_000 });

      await cli("stop");

      const warning = stderr.mock.calls.map(([chunk]) => String(chunk)).find((s) => s.includes("録音の書き終わりを確認できない"));
      expect(warning).toBeDefined();
      expect(warning).toContain("相手-2.m4a");
      expect(warning).toContain("自分-2.m4a");
      expect(warning).not.toContain("相手.m4a"); // 1 回目（番号なし）の名前ではない
    },
  );

  it(
    "intake-stopped のログは、コード終了・シグナル終了のどちらでも code・signal・stderrTail の値を直接反映する（TEST-161-003）",
    { timeout: 20_000 },
    async () => {
      const codeLines = ["l1", "l2", "l3", "l4", "l5", "l6"]; // STDERR_TAIL_LINES（5）を超える行数で、末尾だけが残ることも確かめる
      const signalLines = ["s1", "s2", "s3"];
      const { cli, records, sessionDirs } = await setup({
        events: [],
        attempts: [
          { unexpectedExit: { afterMs: 300, code: 1 }, stderrLines: codeLines },
          { unexpectedExit: { afterMs: 300, signal: "SIGKILL" as const }, stderrLines: signalLines },
          { events: [] },
        ],
      });
      await cli("start", "--app", "us.zoom.xos", "--title", "週次");
      await vi.waitFor(() => expect(runs(records())).toHaveLength(3), { timeout: 10_000 });
      await vi.waitFor(async () => expect(await cli("status")).toContain("動いている"), { timeout: 10_000 });

      await cli("stop");

      const [dir] = await sessionDirs();
      const stopped = (await logEvents(dir!)).filter((e) => e.type === "intake-stopped");
      expect(stopped).toHaveLength(2);
      // コード終了: code の値そのものと、6 行の標準エラーの末尾 5 行（STDERR_TAIL_LINES）だけが残る
      expect(stopped[0]).toMatchObject({ code: 1, signal: null, stderrTail: codeLines.slice(-5) });
      // シグナル終了: signal の値そのもの（文字列）と、5 行未満の標準エラーはそのまま全部残る
      expect(stopped[1]).toMatchObject({ code: null, signal: "SIGKILL", stderrTail: signalLines });
    },
  );

  it(
    "60 秒以内の終了が 3 回続くと、起動し直しをやめて止まった状態になる（止まり方がコード・接続失敗でも同じ判断）。4 回目は起動しない",
    { timeout: 20_000 },
    async () => {
      const stderr = vi.spyOn(process.stderr, "write");
      cleanups.push(async () => stderr.mockRestore());
      const { server, cli, records, sessionDirs } = await setup({
        events: [remark("相手", 1, 5, "いちかいめ")],
        attempts: [
          { unexpectedExit: { afterMs: 500, code: 1 } }, // 1 回目: 接続した後すぐに終わる
          { failRun: { stderr: "起動に失敗", code: 1 } }, // 2 回目: 接続もできずに終わる（要件 #61: 起動し直し自体の失敗も数える）
          { failRun: { stderr: "起動に失敗", code: 1 } }, // 3 回目: 同上。これで 3 回続く
        ],
      });
      await cli("start", "--app", "us.zoom.xos", "--title", "週次");

      await vi.waitFor(() => expect(runs(records())).toHaveLength(3), { timeout: 10_000 });
      await new Promise((resolve) => setTimeout(resolve, 500)); // 4 回目が起きないことを確かめるための待ち
      expect(runs(records())).toHaveLength(3);

      expect(stderr.mock.calls.some(([chunk]) => /諦め|止まっ/.test(String(chunk)))).toBe(true);
      const [dir] = await sessionDirs();
      const events = await logEvents(dir!);
      expect(events.some((e) => e.type === "intake-gave-up")).toBe(true);
      expect(events.some((e) => e.type === "intake-stopped")).toBe(true);

      // 止まった状態でもセッションは終わっておらず、stop で書き出せる（ヘルパーの終了を待たない）
      const startedAt = Date.now();
      const stdout = await cli("stop");
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(stdout.split("\n").filter((l) => l !== "")).toHaveLength(4);

      await server.close();
    },
  );

  it("止まった状態から resume すると、失敗の数を 0 から数え直してヘルパーを起動し直し、同じセッションへ発言が続く。動いているときの resume は拒否され、二重に起動しない", { timeout: 20_000 }, async () => {
    const { server, cli, calls, records, sessionDirs } = await setup({
      events: [remark("相手", 1, 5, "いちかいめ")],
      attempts: [
        { unexpectedExit: { afterMs: 500, code: 1 } },
        { failRun: { stderr: "起動に失敗", code: 1 } },
        { failRun: { stderr: "起動に失敗", code: 1 } },
        // 4 回目（resume による 1 回目）: 一度は接続するがすぐ終わる。失敗の数が 0 から数え直されていれば
        // （1 回の失敗では諦めず）起動し直しが続くはず。3 のまま引き継いでいたら、これだけで諦めてしまう
        { unexpectedExit: { afterMs: 200, code: 1 } },
        // 5 回目（自動の起動し直し）は上書きなし。ベースの台本どおり普通に起動して、そのまま動き続ける
      ],
    });
    await cli("start", "--app", "us.zoom.xos", "--title", "週次");
    await vi.waitFor(() => expect(runs(records())).toHaveLength(3), { timeout: 10_000 });
    // run の記録はヘルパーの子プロセス側が書くため、記録が 3 件になった直後はサーバーが止まった状態へ
    // 遷移しきっているとは限らない（記録の可視化とサーバー内の状態更新は別経路）。cli status で実際に
    // 止まった状態になったことを確認してから resume する（run 件数だけで判断すると、resume が競合して拒否され得る）
    await vi.waitFor(async () => expect(await cli("status")).toContain("止まっ"), { timeout: 10_000 });

    await cli("resume");
    // U-B: resume の応答は起動し直しの連鎖の到達状態（動いている）を反映する。応答が返った時点（待ち合わせなし）
    // で、もう「動いている」に到達している（応答を返してから起動が追いつく、の順序ではない）
    expect(await cli("status")).toContain("動いている");

    // 4 回目（resume 由来）が接続して動き出した後、すぐ終了して 5 回目（自動）へ続くまで待つ。
    // 失敗の数が 0 から数え直されていなければ、4 回目の失敗だけで再び諦め、5 回目は起動しない
    await vi.waitFor(() => expect(runs(records())).toHaveLength(5), { timeout: 10_000 });
    await vi.waitFor(async () => expect(await cli("status")).toContain("動いている"), { timeout: 10_000 }); // 諦めずに戻ってきた
    await vi.waitFor(() => expect(calls.flatMap((c) => c.fresh).some((u) => u.text === "いちかいめ")).toBe(true), { timeout: 10_000 });
    const [dir] = await sessionDirs();
    const events = await logEvents(dir!);
    expect(events.filter((e) => e.type === "intake-restarted" && e.trigger === "resume")).toHaveLength(1); // resume による起動し直しは 1 回だけ（4 回目）
    expect(events.filter((e) => e.type === "intake-restarted" && e.trigger === "auto")).toHaveLength(1); // 4 回目の失敗後の自動の起動し直し（5 回目）

    await expect(cli("resume")).rejects.toThrow(); // 動いている状態からの resume は拒否される
    expect(runs(records())).toHaveLength(5); // 二重に起動しない

    await cli("stop");
    await server.close();
  });

  it("resume した後に 3 回続けて失敗すると、諦めて止まった状態になり、resume は stderr 末尾付きで失敗する。セッションは残り、また resume できる", { timeout: 20_000 }, async () => {
    const { server, cli, records, sessionDirs } = await setup({
      events: [],
      attempts: [
        { unexpectedExit: { afterMs: 500, code: 1 } }, // 1 回目: 動いた後に終わる（失敗 1）
        { failRun: { stderr: "起動に失敗", code: 1 } }, // 2 回目: 自動の起動し直し（失敗 2）
        { failRun: { stderr: "起動に失敗", code: 1 } }, // 3 回目: 自動の起動し直し（失敗 3）。これで諦める
        // 4〜6 回目（resume による起動し直し）: 失敗の数は 0 から数え直されるので、また 3 回続けて失敗して諦める
        { failRun: { stderr: "起動に失敗", code: 1 } },
        { failRun: { stderr: "起動に失敗", code: 1 } },
        { failRun: { stderr: "起動に失敗", code: 1 } },
      ],
    });
    await cli("start", "--app", "us.zoom.xos", "--title", "週次");
    await vi.waitFor(() => expect(runs(records())).toHaveLength(3), { timeout: 10_000 });
    await vi.waitFor(async () => expect(await cli("status")).toContain("止まっ"), { timeout: 10_000 });

    await expect(cli("resume")).rejects.toThrow("起動に失敗");
    // 応答が返った時点（待ち合わせなし）で、もう止まった状態に到達している（起動が追いつくのを待たなくてよい）
    expect(await cli("status")).toContain("止まっ");
    expect(runs(records())).toHaveLength(6); // 4〜6 回目（resume 由来）の起動し直しで諦めた。7 回目は起動しない
    const [dir] = await sessionDirs();
    const events = await logEvents(dir!);
    expect(events.filter((e) => e.type === "intake-gave-up")).toHaveLength(2); // 自動（3 回目後）と resume（6 回目後）の 2 回

    // 止まった状態のままセッションは残り、また resume できる（セッションが壊れていない）
    await expect(cli("stop")).resolves.toBeTruthy();
    await server.close();
  });

  describe("起動し直しの最中に stop・close が来る場合", () => {
    const abortScript = () => ({
      events: [remark("相手", 1, 5, "いちかいめ")],
      attempts: [{ unexpectedExit: { afterMs: 500, signal: "SIGKILL" as const } }, { listenDelayMs: 3_000 }],
    });

    it("起動し直しの最中に stop すると、起動中のヘルパーも止め、子プロセスを残さない", { timeout: 20_000 }, async () => {
      const { server, cli, calls, records } = await setup(abortScript());
      await cli("start", "--app", "us.zoom.xos", "--title", "週次");
      await vi.waitFor(() => expect(calls.flatMap((c) => c.fresh)).toHaveLength(1), { timeout: 10_000 });
      await vi.waitFor(() => expect(runs(records())).toHaveLength(2), { timeout: 10_000 });
      const second = runs(records())[1];
      if (second?.type !== "run") throw new Error("2 回目のヘルパーが起動していない");
      expect(() => process.kill(second.pid, 0)).not.toThrow(); // 接続前（起動中）で、まだ生きている

      const stdout = await cli("stop");

      expect(stdout.split("\n").filter((l) => l !== "")).toHaveLength(4);
      await vi.waitFor(() => expect(() => process.kill(second.pid, 0)).toThrow());
      await server.close();
    });

    it("起動し直しの最中にサーバーが終わると、起動中のヘルパーも止め、子プロセスを残さない", { timeout: 20_000 }, async () => {
      const { server, cli, calls, records } = await setup(abortScript());
      await cli("start", "--app", "us.zoom.xos", "--title", "週次");
      await vi.waitFor(() => expect(calls.flatMap((c) => c.fresh)).toHaveLength(1), { timeout: 10_000 });
      await vi.waitFor(() => expect(runs(records())).toHaveLength(2), { timeout: 10_000 });
      const second = runs(records())[1];
      if (second?.type !== "run") throw new Error("2 回目のヘルパーが起動していない");

      await server.close();

      expect(() => process.kill(second.pid, 0)).toThrow();
    });
  });

  it("stop・サーバーの終了で止めたヘルパーは、起動し直さない", { timeout: 20_000 }, async () => {
    const { server, cli, records } = await setup();
    await cli("start", "--app", "us.zoom.xos", "--title", "週次");
    await vi.waitFor(() => expect(runs(records())).toHaveLength(1), { timeout: 10_000 });

    await cli("stop");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(runs(records())).toHaveLength(1); // stop の SIGTERM による終了を、予期せぬ終了と誤認しない

    await cli("start", "--app", "us.zoom.xos", "--title", "次");
    await vi.waitFor(() => expect(runs(records())).toHaveLength(2), { timeout: 10_000 });
    await server.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(runs(records())).toHaveLength(2); // close() による終了も、起動し直しを起こさない
  });

  it("接続を保ったままのブラウザには途切れている間・止まった状態の間、状態のフレームが届き続ける。途中から接続したブラウザにも今の状態が届き、セッションが終わった後に新しく接続したブラウザには status: \"none\" だけが届く（SCN-U-G-P1）", { timeout: 20_000 }, async () => {
    const { server, cli, records, sessionDirs } = await setup({
      events: [remark("相手", 1, 5, "いちかいめ")],
      attempts: [
        { unexpectedExit: { afterMs: 500, signal: "SIGKILL" as const } },
        { listenDelayMs: 500 }, // この間、接続を保ったクライアントと新規クライアントの両方が「途切れている」状態を観測できる
      ],
    });
    const before = await connectClassified(server.port);
    await cli("start", "--app", "us.zoom.xos", "--title", "週次");
    await vi.waitFor(() => expect(before.snapshots.length).toBeGreaterThan(0));
    expect(before.other).toEqual([]); // 動いている間は状態のフレームを送らない

    await vi.waitFor(() => expect(runs(records())).toHaveLength(2), { timeout: 10_000 });
    // 途切れている間、接続を保ったクライアントに「途切れている」という status を持つ状態のフレームが届く
    // （フレームが届いたことだけでなく、status の値そのものを確認する。誤った status でも素通りしない）
    await vi.waitFor(() => expect(before.other.at(-1)).toEqual({ type: "intake", status: "interrupted" }));
    // 途中から接続したクライアントにも、今の状態（途切れている）が同じ status 付きで届く
    const duringInterrupt = await connectClassified(server.port);
    await vi.waitFor(() => expect(duringInterrupt.other.at(-1)).toEqual({ type: "intake", status: "interrupted" }));

    // cli status も、この間「途切れている」と最後の途切れの時刻を値として出す（listenDelayMs の 500ms の窓の中で、race なく観測できる）
    const [dir] = await sessionDirs();
    const interruptedStatus = await cli("status");
    expect(interruptedStatus).toContain("途切れている");
    expect(interruptedStatus).toContain(dir!);
    expect(interruptedStatus).toMatch(/最後の途切れの時刻: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);

    await cli("stop"); // 起動し直しの途中なので、起動中のヘルパーを止めて書き出す
    expect(dir).toBeDefined();

    // 接続を保ったままのクライアントには、セッションが終わったことを示す status: "none" が届く。
    // "running" ではないことを確認する（"running" だと、直前が interrupted だったことから
    // ブラウザ側が「再開しました」と誤って解釈してしまう。companion 指摘で発見した回帰）
    await vi.waitFor(() => expect(before.other.at(-1)).toEqual({ type: "intake", status: "none" }));
    await vi.waitFor(() => expect(duringInterrupt.other.at(-1)).toEqual({ type: "intake", status: "none" }));

    // セッションが終わった後に新しく接続したクライアントには、保持されている最後の状態（none）だけが届く。
    // none は途切れ・止まったの文を出さない値なので、一言は表示されない（CT-NOTICE-CLEAR。Issue #161 U-G）
    const after = await connectClassified(server.port);
    await vi.waitFor(() => expect(after.snapshots.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(after.other).toEqual([{ type: "intake", status: "none" }]));

    await server.close();
  });

  it("cli status が、セッションなし・動いている・止まった状態それぞれで、状態・セッションのフォルダ・起動し直した回数・最後の途切れの時刻を値として出す（CT-STATUS）", { timeout: 20_000 }, async () => {
    const { server, cli, records, sessionDirs } = await setup({
      events: [remark("相手", 1, 5, "いちかいめ")],
      attempts: [
        { unexpectedExit: { afterMs: 500, code: 1 } },
        { failRun: { stderr: "起動に失敗", code: 1 } },
        { failRun: { stderr: "起動に失敗", code: 1 } },
      ],
    });

    // セッションが無いとき
    expect(await cli("status")).toContain("セッションなし");

    await cli("start", "--app", "us.zoom.xos", "--title", "週次");
    const [dir] = await sessionDirs();

    // 動いているとき: 状態とセッションのフォルダが出る。起動し直した回数はまだ 0、途切れてもいない
    const runningStatus = await cli("status");
    expect(runningStatus).toContain("動いている");
    expect(runningStatus).toContain(dir!);
    expect(runningStatus).toContain("起動し直した回数: 0");
    expect(runningStatus).not.toContain("最後の途切れの時刻");

    // 3 回続けて失敗し、諦めて止まった状態になるまで待つ。2・3 回目は failRun（接続前に失敗）なので、
    // 一度も起動し直しに成功していない（起動し直した回数は 0 のまま）。
    // run の記録はヘルパーの子プロセス側が書くため、記録が 3 件になった直後にサーバー内の状態更新が
    // 終わっているとは限らない。cli status で実際に止まった状態になるまで待つ
    await vi.waitFor(() => expect(runs(records())).toHaveLength(3), { timeout: 10_000 });
    await vi.waitFor(async () => expect(await cli("status")).toContain("止まっ"), { timeout: 10_000 });

    const stoppedStatus = await cli("status");
    expect(stoppedStatus).toContain("止まっ");
    expect(stoppedStatus).toContain(dir!); // セッションのフォルダは引き続き出る
    expect(stoppedStatus).toContain("起動し直した回数: 0"); // 起動し直しに成功した回がない
    expect(stoppedStatus).toMatch(/最後の途切れの時刻: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/); // 値として時刻が出る

    await cli("stop");
    await server.close();
  });
});
