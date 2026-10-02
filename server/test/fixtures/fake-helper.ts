// 偽のヘルパー。実物（helper/）の `list` と `run --app <id> --port <n>` の外から見える振る舞いだけを真似る。
//   node fake-helper.ts <台本JSON> <記録ファイル> list
//   node fake-helper.ts <台本JSON> <記録ファイル> run --app <id> --port <n>
// 台本: { apps: unknown, events: unknown[], failRun?: { stderr: string; code: number }, ignoreSigterm?: boolean }
//   ignoreSigterm: SIGTERM を受けても終わらない（SIGKILL でだけ終わる）。音が出ないまま止まらない実物のヘルパーを真似る
//   --audio-dir <dir> があると、SIGTERM の後に少し遅れて <dir>/相手.m4a と <dir>/自分.m4a を書き終えてから終了する（書き終わる前にサーバーがセッションを閉じないことを確かめる）
// 記録ファイルには 1 行 1 件の JSON を追記する: { type: "run", argv, pid }、{ type: "connection" }、{ type: "signal", signal: "SIGTERM" }
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";

const [scriptPath, recordPath, command, ...rest] = process.argv.slice(2);
if (!scriptPath || !recordPath) throw new Error("usage: fake-helper.ts <台本JSON> <記録ファイル> <list|run ...>");

const script = JSON.parse(readFileSync(scriptPath, "utf8")) as {
  apps: unknown;
  events: unknown[];
  failRun?: { stderr: string; code: number };
  ignoreSigterm?: boolean;
};
// 書き終わった録音の内容。テストは、これが全部入っていることで「最後まで書かれた」と判断する
const AUDIO_COMPLETE = "complete";
const AUDIO_FLUSH_MS = 300;
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
  // 実物と同じく、SIGTERM で WebSocket を片付けて正常終了する（ignoreSigterm のときを除く）
  process.on("SIGTERM", () => {
    record({ type: "signal", signal: "SIGTERM" });
    // リスナーがあるので Node の既定の終了は起きず、WebSocketServer がイベントループを保つ
    if (script.ignoreSigterm) return;
    for (const client of wss.clients) client.close();
    const audioIndex = rest.indexOf("--audio-dir");
    const finish = () => wss.close(() => process.exit(0));
    if (audioIndex < 0) return finish();
    const audioDir = rest[audioIndex + 1]!;
    // 実物のヘルパーが録音を閉じるまでにかかる時間を真似る。先に空のファイルを作り、遅れて内容を書き終える
    const files = ["相手.m4a", "自分.m4a"].map((name) => join(audioDir, name));
    for (const file of files) writeFileSync(file, "");
    setTimeout(() => {
      for (const file of files) writeFileSync(file, AUDIO_COMPLETE);
      finish();
    }, AUDIO_FLUSH_MS);
  });
} else {
  throw new Error(`未対応のコマンド: ${command}`);
}
