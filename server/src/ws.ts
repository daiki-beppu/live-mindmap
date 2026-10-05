import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { IntakeFrame, Snapshot, SpeakingFrame, Track } from "./core/index.ts";

// マップ全体のスナップショットをブラウザへ送る。差分は送らない（ブラウザは受け取ったものを描くだけ）。
// つないだクライアントには、その時点の最新をすぐ送る。つなぎ直しても最新に追いつく。
export type SnapshotServer = {
  port: number;
  publish: (snapshot: Snapshot) => void;
  // いま話している文字を、つないでいるクライアントへ送る。トラックごとに最後に送った値だけをメモリに持ち、
  // 空でなければ、つないだ直後に送り直す（スナップショットには入れない）
  speak: (frame: SpeakingFrame) => void;
  // 取り込みの状態（途切れている／止まった／動いている／セッションが終わった）を、つないでいるクライアントへ送る。
  // 最後に送った状態は status に関わらず保持し、後から接続した（再接続を含む）クライアントにも今の状態が
  // 届く（CT-LATE-JOIN）。「今の取り込み状態」の正本はサーバーにあり、途中から・再接続で繋いだブラウザが
  // 実フレームを受け取るまで状態を知らない空白を作らない（ブラウザ側が frame の無さを「running」として代用する
  // 二重所有をやめる。Issue #161 U-A）。none も保持対象に含める理由: 切断中にセッションが終わった場合、
  // 再接続したブラウザへ none を届けないと、途切れ・止まったの一言が無期限に残ってしまう（Issue #161 U-G）。
  // none は途切れ・止まったの文を出さない値なので、新規接続へ送っても CT-NOTICE-CLEAR は破れない
  // （web/src/intake.ts の遷移規則で確認済み）。
  // つないでいるクライアントには、none なら途切れ・止まったの一言がそのまま消える
  // （running だと「再開した」とブラウザ側が解釈するため、セッションが終わっただけのときは none を使う）
  intake: (frame: IntakeFrame) => void;
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
    const speaking = new Map<Track, string>(); // トラックごとに最後に送った speaking frame
    let retainedIntake: string | undefined; // 保持している取り込みの状態（最後に送った 1 件。status に関わらず持つ）
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
      for (const data of speaking.values()) client.send(data);
      if (retainedIntake !== undefined) client.send(retainedIntake);
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
        speak(frame) {
          const data = JSON.stringify(frame);
          if (frame.text === "") speaking.delete(frame.track);
          else speaking.set(frame.track, data);
          for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(data);
        },
        intake(frame) {
          const data = JSON.stringify(frame);
          retainedIntake = data;
          for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(data);
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
