import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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

export function isLocalOrigin(origin: string): boolean {
  return URL.canParse(origin) && LOCAL_HOSTNAMES.has(new URL(origin).hostname);
}

export type SnapshotServerOptions = {
  port: number;
  // WebSocket のアップグレード以外の HTTP リクエストの処理。渡さなければ 404
  onRequest?: (req: IncomingMessage, res: ServerResponse) => void;
};

export function startSnapshotServer({ port, onRequest }: SnapshotServerOptions): Promise<SnapshotServer> {
  return new Promise((resolve, reject) => {
    let latest: string | undefined;
    const http = createServer(
      onRequest ??
        ((_req, res) => {
          res.writeHead(404).end();
        }),
    );
    const wss = new WebSocketServer({
      server: http,
      // 127.0.0.1 で待ち受けても、ブラウザ上の任意の Web ページからは接続できてしまう。Origin がローカルのものだけ受理する。
      verifyClient: ({ origin }: { origin?: string }) => origin === undefined || isLocalOrigin(origin),
    });
    http.once("error", reject);
    wss.on("connection", (client) => {
      if (latest !== undefined) client.send(latest);
    });
    http.listen(port, "127.0.0.1", () => {
      const address = http.address();
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
            wss.close((e) => {
              if (e) return fail(e);
              http.close((e2) => (e2 ? fail(e2) : done()));
              http.closeAllConnections();
            });
          }),
      });
    });
  });
}
