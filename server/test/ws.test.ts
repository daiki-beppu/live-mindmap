import { afterEach, describe, expect, it } from "vitest";
import { WebSocket as WsClient } from "ws";
import type { Snapshot } from "../src/core/index.ts";
import { startSnapshotServer } from "../src/ws.ts";

const snap = (...texts: string[]): Snapshot => ({
  nodes: [
    { id: "root", parent: null, kind: "会議", text: "定例", evidence: [] },
    ...texts.map((text, i) => ({ id: `n${i + 1}`, parent: "root", kind: "議題" as const, text, evidence: ["r1"] })),
  ],
  round: 0,
  changes: [],
  remarks: [],
});

// つないだクライアント。届いたスナップショットを順に貯める。
async function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const received: Snapshot[] = [];
  const waiting: { n: number; resolve: () => void }[] = [];
  ws.addEventListener("message", (e) => {
    received.push(JSON.parse(String(e.data)));
    for (const w of waiting.filter((w) => received.length >= w.n)) w.resolve();
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("接続できない")));
  });
  return {
    received,
    // n 個届くまで待つ
    until: (n: number) =>
      received.length >= n
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiting.push({ n, resolve })),
    close: () => new Promise<void>((resolve) => {
      ws.addEventListener("close", () => resolve());
      ws.close();
    }),
  };
}

// 届かないことを確かめるための短い待ち
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("スナップショットサーバー（WebSocket）", () => {
  let server: Awaited<ReturnType<typeof startSnapshotServer>> | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("つないだクライアントが最新のスナップショットを受け取り、反映のたびに全体が届く。つなぎ直すと最新のものが届く", async () => {
    server = await startSnapshotServer({ port: 0 });
    const s1 = snap("採用");
    const s2 = snap("採用", "予算");
    const s3 = snap("採用", "予算", "日程");

    server.publish(s1);
    const first = await connect(server.port);
    await first.until(1);
    expect(first.received).toEqual([s1]); // つないだ時点の最新が、publish より後でも届く

    server.publish(s2);
    await first.until(2);
    expect(first.received).toEqual([s1, s2]); // つないでいる間の反映は、差分でなく全体で届く

    await first.close();
    server.publish(s3); // 切れている間の反映

    const second = await connect(server.port);
    await second.until(1);
    expect(second.received).toEqual([s3]); // つなぎ直すと、切れている間のものを含む最新だけが届く
    await settle();
    expect(second.received).toEqual([s3]);
    await second.close();
  });

  it("接続中のクライアントすべてに同じスナップショットが届く", async () => {
    server = await startSnapshotServer({ port: 0 });
    const a = await connect(server.port);
    const b = await connect(server.port);
    server.publish(snap("採用"));
    await a.until(1);
    await b.until(1);
    expect(a.received).toEqual([snap("採用")]);
    expect(b.received).toEqual([snap("採用")]);
    await a.close();
    await b.close();
  });

  it("スナップショットを一度も publish していなければ、つないでも何も届かない", async () => {
    server = await startSnapshotServer({ port: 0 });
    const c = await connect(server.port);
    await settle();
    expect(c.received).toEqual([]);
    await c.close();
  });

  // origin を指定してつなぐ。受理されれば最初に届いた 1 件、拒否されれば null を返す。
  const tryOrigin = (port: number, origin: string | undefined) =>
    new Promise<Snapshot | null>((resolve) => {
      const ws = new WsClient(`ws://127.0.0.1:${port}`, origin === undefined ? {} : { origin });
      ws.on("message", (data) => {
        resolve(JSON.parse(String(data)));
        ws.close();
      });
      ws.on("error", () => resolve(null));
      ws.on("unexpected-response", () => resolve(null));
    });

  it.each(["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"])(
    "ローカルの Origin（%s）からの接続には最新が届く",
    async (origin) => {
      server = await startSnapshotServer({ port: 0 });
      server.publish(snap("採用"));
      expect(await tryOrigin(server.port, origin)).toEqual(snap("採用"));
    },
  );

  it("Origin ヘッダーのない接続には最新が届く", async () => {
    server = await startSnapshotServer({ port: 0 });
    server.publish(snap("採用"));
    expect(await tryOrigin(server.port, undefined)).toEqual(snap("採用"));
  });

  it.each(["https://evil.example", "null", "http://localhost.evil.example"])(
    "許可していない Origin（%s）の接続は拒否し、何も送らない",
    async (origin) => {
      server = await startSnapshotServer({ port: 0 });
      server.publish(snap("採用"));
      expect(await tryOrigin(server.port, origin)).toBeNull();
    },
  );

  describe("つないだ直後の speaking", () => {
    const frame = (track: "相手" | "自分", text: string) => ({ type: "speaking" as const, track, text });
    // 接続して、スナップショットと speaking frame が出そろうまで受け取る
    async function connectAndCollect(port: number, n: number) {
      const c = await connect(port);
      await c.until(n);
      await settle();
      const received = c.received as unknown[];
      await c.close();
      return received;
    }

    it("反映待ちの文字があるときにつないだクライアントへ、スナップショットの後に送り直す", async () => {
      server = await startSnapshotServer({ port: 0 });
      server.publish(snap("採用"));
      server.speak(frame("相手", "あ い"));
      expect(await connectAndCollect(server.port, 2)).toEqual([snap("採用"), frame("相手", "あ い")]);
    });

    it("トラックごとに 1 件まで送り、空のトラックは送らない", async () => {
      server = await startSnapshotServer({ port: 0 });
      server.speak(frame("相手", "あ"));
      server.speak(frame("自分", ""));
      expect(await connectAndCollect(server.port, 1)).toEqual([frame("相手", "あ")]);
    });

    it("同じトラックへ続けて送った場合は、最後の値だけを送り直す", async () => {
      server = await startSnapshotServer({ port: 0 });
      server.speak(frame("相手", "あ"));
      server.speak(frame("相手", "あ い"));
      expect(await connectAndCollect(server.port, 1)).toEqual([frame("相手", "あ い")]);
    });

    it("最後に空を送ったトラックは、つないでも何も届かない", async () => {
      server = await startSnapshotServer({ port: 0 });
      server.speak(frame("相手", "あ"));
      server.speak(frame("相手", ""));
      const c = await connect(server.port);
      await settle();
      expect(c.received).toEqual([]);
      await c.close();
    });
  });

  it("close の後は、つないだままのクライアントがいても終了でき、新しい接続を受け付けない", async () => {
    server = await startSnapshotServer({ port: 0 });
    const { port } = server;
    const c = await connect(port);
    await server.close();
    server = undefined;
    await expect(connect(port)).rejects.toThrow();
    expect(c.received).toEqual([]);
  });
});
