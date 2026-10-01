import { WebSocket, WebSocketServer } from "ws";
import type { Snapshot } from "./core/index.ts";

// マップ全体のスナップショットをブラウザへ送る。差分は送らない（ブラウザは受け取ったものを描くだけ）。
// つないだクライアントには、その時点の最新をすぐ送る。つなぎ直しても最新に追いつく。
export type SnapshotServer = {
  port: number;
  publish: (snapshot: Snapshot) => void;
  close: () => Promise<void>;
};

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalOrigin(origin: string): boolean {
  return URL.canParse(origin) && LOCAL_HOSTNAMES.has(new URL(origin).hostname);
}

export function startSnapshotServer({ port }: { port: number }): Promise<SnapshotServer> {
  return new Promise((resolve, reject) => {
    let latest: string | undefined;
    const wss = new WebSocketServer({
      port,
      host: "127.0.0.1",
      // 127.0.0.1 で待ち受けても、ブラウザ上の任意の Web ページからは接続できてしまう。Origin がローカルのものだけ受理する。
      verifyClient: ({ origin }: { origin?: string }) => origin === undefined || isLocalOrigin(origin),
    });
    wss.once("error", reject);
    wss.on("connection", (client) => {
      if (latest !== undefined) client.send(latest);
    });
    wss.once("listening", () => {
      const address = wss.address();
      if (!address || typeof address === "string") return reject(new Error("TCP のポートで待ち受けていない"));
      resolve({
        port: address.port,
        publish(snapshot) {
          latest = JSON.stringify(snapshot);
          for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(latest);
        },
        close: () =>
          new Promise<void>((done, fail) => {
            for (const client of wss.clients) client.terminate();
            wss.close((e) => (e ? fail(e) : done()));
          }),
      });
    });
  });
}
