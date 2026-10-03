import { createHash } from "node:crypto";
import { createServer, type AddressInfo, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { openHelperSocket } from "../src/helperSocket.ts";

// ハンドシェイクの応答と、続くテキストフレームを 1 回の write で返すサーバー。
// 遅い環境で、ヘルパーが接続直後に送ったイベントが応答と同じ塊で届く状況を、毎回起こす
function coalescingServer(messages: string[]): Promise<Server> {
  const frame = (text: string) => {
    const payload = Buffer.from(text);
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  };
  const server = createServer((socket) =>
    socket.once("data", (request) => {
      const key = /Sec-WebSocket-Key: (.*)\r\n/i.exec(String(request))![1]!.trim();
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      const head = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
      socket.write(Buffer.concat([Buffer.from(head), ...messages.map(frame)]));
    }),
  );
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

let server: Server | undefined;
afterEach(() => server?.close());

describe("openHelperSocket", () => {
  it("ハンドシェイクと同じ塊で届いたメッセージも、listen した時点で届いた順に渡す", async () => {
    server = await coalescingServer(['{"n":1}', '{"n":2}']);
    const socket = await openHelperSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
    // open の後に別の処理を挟んでから購読する（サーバーの開始処理と同じ順）
    await new Promise((resolve) => setTimeout(resolve, 50));

    const received: string[] = [];
    socket!.listen((data) => received.push(String(data)));

    expect(received).toEqual(['{"n":1}', '{"n":2}']);
    socket!.ws.terminate();
  });

  it("つなげなければ undefined を返す", async () => {
    server = await new Promise<Server>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;
    server.close();

    expect(await openHelperSocket(`ws://127.0.0.1:${port}`)).toBeUndefined();
  });
});
