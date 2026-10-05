// 偽のヘルパー。実物（helper/）の `list` と `run --app <id> --port <n> [--audio-dir <dir>] [--audio-index <n>] [--origin <host time>]` の
// 外から見える振る舞いだけを真似る。
//   node fake-helper.ts <台本JSON> <記録ファイル> list
//   node fake-helper.ts <台本JSON> <記録ファイル> run --app <id> --port <n> ...
// 台本: {
//   apps, events, failRun?, ignoreSigterm?,
//   delayedEvents?: 接続の afterMs ミリ秒後に送るイベント（events の後に送る）。時間が経ってから届く確定結果を真似る
//   originHostTime?: 接続直後（events より前）に送る { type: "origin", hostTime } の値（文字列のまま送るので桁は落ちない）
//   unexpectedExit?: { afterMs, code?, signal? }
//     code 指定: 実物の「エラーで終わる」（order.md の 2 つ目の止まり方）を真似る。録音は閉じてから、その code で終了する
//     signal 指定: 実物の「落ちる」（SIGSEGV 等）を真似る。後片付けなしに自分へ signal を送って即座に終わる（録音は閉じない）
//   attempts?: 台本の上書き（0 始まり。[0] が 1 回目の起動の上書き）。記録ファイルの既存 run の件数 + 1 を「今回が何回目の起動か」として選ぶ。
//     writeScript の書き換えタイミングに依存せず、起動し直しと競合しない
//   listenDelayMs?: WebSocket の待ち受けを始めるまでの遅延。起動し直しの最中（まだ接続できていない間）に
//     stop・close が割り込む状況を作るために使う。遅延の間も SIGTERM は受け付け、子プロセスを残さない
//   stderrLines?: 起動直後（record({type:"run"}) の直後）に標準エラーへ 1 行ずつ書く所定の行。
//     intake-stopped（server.ts の finishAttempt）の stderrTail が実際の標準エラーの値を反映することを、
//     テストが直接アサートできるようにするための台本項目（TEST-161-003）。終了直前ではなく起動直後に書くのは、
//     child.once("exit") が最後の stderr の data イベントより先に解決し得るため（取りこぼしを避ける）
// }
//   --audio-dir <dir> があると、終了時に <dir>/相手[-n].m4a・<dir>/自分[-n].m4a を書く（n は --audio-index。1 か省略なら付けない）
// 記録ファイルには 1 行 1 件の JSON を追記する:
//   { type: "run", argv, pid, attempt }、{ type: "connection" }、{ type: "signal", signal: "SIGTERM" }、
//   { type: "unexpectedExit", code?, signal? }
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";

const [scriptPath, recordPath, command, ...rest] = process.argv.slice(2);
if (!scriptPath || !recordPath) throw new Error("usage: fake-helper.ts <台本JSON> <記録ファイル> <list|run ...>");

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

const script = JSON.parse(readFileSync(scriptPath, "utf8")) as Script;
// 書き終わった録音の内容。テストは、これが全部入っていることで「最後まで書かれた」と判断する
const AUDIO_COMPLETE = "complete";
const AUDIO_FLUSH_MS = 300;
const record = (entry: object) => appendFileSync(recordPath, JSON.stringify(entry) + "\n");

// 記録ファイルに残っている run の件数（これまでの起動の回数）から、今回が何回目かを決める。
// const のアロー関数にする（function 宣言は巻き上がり、ガード直後の型の絞り込みを引き継がない）
const currentAttempt = (): number => {
  if (!existsSync(recordPath)) return 1;
  const priorRuns = readFileSync(recordPath, "utf8")
    .split("\n")
    .filter((l: string) => l !== "")
    .map((l: string) => JSON.parse(l) as { type: string })
    .filter((r: { type: string }) => r.type === "run").length;
  return priorRuns + 1;
};

// 2 トラックのファイル名（番号は 2 回目以降だけ付ける。1 回目の名前は変えない）
function audioFileNames(index: number | undefined): [string, string] {
  const suffix = index !== undefined && index > 1 ? `-${index}` : "";
  return [`相手${suffix}.m4a`, `自分${suffix}.m4a`];
}

function writeAudioPlaceholders(audioDir: string, index: number | undefined): string[] {
  const files = audioFileNames(index).map((name) => join(audioDir, name));
  for (const file of files) writeFileSync(file, "");
  return files;
}

if (command === "list") {
  console.log(JSON.stringify(script.apps));
} else if (command === "run") {
  const attempt = currentAttempt();
  const effective: Script = { ...script, ...(script.attempts?.[attempt - 1] ?? {}) };
  record({ type: "run", argv: [command, ...rest], pid: process.pid, attempt });
  // 起動直後に書く（終了直前だと child.once("exit") が最後の data イベントより先に解決し得るため）
  for (const line of effective.stderrLines ?? []) process.stderr.write(line + "\n");
  if (effective.failRun) {
    process.stderr.write(effective.failRun.stderr);
    process.exit(effective.failRun.code);
  }
  const port = Number(rest[rest.indexOf("--port") + 1]);
  const audioDirIndex = rest.indexOf("--audio-dir");
  const audioDir = audioDirIndex >= 0 ? rest[audioDirIndex + 1] : undefined;
  const audioIndexArgIndex = rest.indexOf("--audio-index");
  const audioIndex = audioIndexArgIndex >= 0 ? Number(rest[audioIndexArgIndex + 1]) : undefined;
  let wss: WebSocketServer | undefined;
  // 実物と同じく、SIGTERM で片付けて正常終了する（ignoreSigterm のときを除く）。
  // listenDelayMs の遅延中（wss がまだない）に届いても、子プロセスを残さず終わる
  process.on("SIGTERM", () => {
    record({ type: "signal", signal: "SIGTERM" });
    if (effective.ignoreSigterm) return;
    if (!wss) return process.exit(0);
    for (const client of wss.clients) client.close();
    const finish = () => wss!.close(() => process.exit(0));
    if (!audioDir) return finish();
    // 実物のヘルパーが録音を閉じるまでにかかる時間を真似る。先に空のファイルを作り、遅れて内容を書き終える
    writeAudioPlaceholders(audioDir, audioIndex);
    setTimeout(() => {
      for (const name of audioFileNames(audioIndex)) writeFileSync(join(audioDir, name), AUDIO_COMPLETE);
      finish();
    }, AUDIO_FLUSH_MS);
  });
  if (effective.listenDelayMs) await new Promise((resolve) => setTimeout(resolve, effective.listenDelayMs));
  wss = new WebSocketServer({ port, host: "127.0.0.1" });
  wss.on("connection", (client) => {
    record({ type: "connection" });
    // origin は events より前に送る（実物もヘルパーの起動直後、接続より前に原点を決めるため、接続後は最初に流れる）
    if (effective.originHostTime !== undefined) client.send(JSON.stringify({ type: "origin", hostTime: effective.originHostTime }));
    // 台本のイベントは接続を受けた直後に全部送る。送信は終了より前に済む
    for (const event of effective.events) client.send(JSON.stringify(event));
    for (const { afterMs, event } of effective.delayedEvents ?? []) {
      setTimeout(() => client.readyState === client.OPEN && client.send(JSON.stringify(event)), afterMs);
    }
  });
  if (effective.unexpectedExit) {
    const { afterMs, code, signal } = effective.unexpectedExit;
    setTimeout(() => {
      record({ type: "unexpectedExit", code, signal });
      if (signal) {
        // 落ちる: 後片付けなしに即座に終わる（録音は閉じられない）
        process.kill(process.pid, signal);
        return;
      }
      // エラーで終わる: 実物と同じく、録音を閉じてから終了コードで終わる
      const finish = () => process.exit(code ?? 1);
      if (!audioDir) return finish();
      writeAudioPlaceholders(audioDir, audioIndex);
      setTimeout(() => {
        for (const name of audioFileNames(audioIndex)) writeFileSync(join(audioDir, name), AUDIO_COMPLETE);
        finish();
      }, AUDIO_FLUSH_MS);
    }, afterMs);
  }
} else {
  throw new Error(`未対応のコマンド: ${command}`);
}
