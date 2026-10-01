// 偽のヘルパー。実物（helper/）の `list` と `run --app <id> --port <n>` の外から見える振る舞いだけを真似る。
//   node fake-helper.ts <台本JSON> <記録ファイル> list
//   node fake-helper.ts <台本JSON> <記録ファイル> run --app <id> --port <n>
// 台本: { apps: unknown, events: unknown[], failRun?: { stderr: string; code: number } }
// 記録ファイルには 1 行 1 件の JSON を追記する: { type: "run", argv, pid } と { type: "connection" }
import { appendFileSync, readFileSync } from "node:fs";
import { WebSocketServer } from "ws";

const [scriptPath, recordPath, command, ...rest] = process.argv.slice(2);
if (!scriptPath || !recordPath) throw new Error("usage: fake-helper.ts <台本JSON> <記録ファイル> <list|run ...>");

const script = JSON.parse(readFileSync(scriptPath, "utf8")) as {
  apps: unknown;
  events: unknown[];
  failRun?: { stderr: string; code: number };
};
const record = (entry: object) => appendFileSync(recordPath, JSON.stringify(entry) + "\n");

if (command === "list") {
  console.log(JSON.stringify(script.apps));
} else if (command === "run") {
  record({ type: "run", argv: [command, ...rest], pid: process.pid });
  if (script.failRun) {
    process.stderr.write(script.failRun.stderr);
    process.exit(script.failRun.code);
  }
  const port = Number(rest[rest.indexOf("--port") + 1]);
  const wss = new WebSocketServer({ port, host: "127.0.0.1" });
  wss.on("connection", (client) => {
    record({ type: "connection" });
    // 台本のイベントは接続を受けた直後に全部送る。送信は終了より前に済む
    for (const event of script.events) client.send(JSON.stringify(event));
  });
  // 実物と同じく、SIGTERM で WebSocket を片付けて正常終了する
  process.on("SIGTERM", () => {
    for (const client of wss.clients) client.close();
    wss.close(() => process.exit(0));
  });
} else {
  throw new Error(`未対応のコマンド: ${command}`);
}
