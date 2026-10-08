// 偽のヘルパー。実物（helper/）の `list` と `run --app <id> --port <n> [--audio-dir <dir>] [--audio-index <n>] [--origin <host time>]` の
// 外から見える振る舞いだけを真似る。
//   node fake-helper.ts <台本JSON> <記録ファイル> list
//   node fake-helper.ts <台本JSON> <記録ファイル> run --app <id> --port <n> ...
//   node fake-helper.ts <台本JSON> <記録ファイル> mix --session <dir> --out <path> [--track 自分]
// 台本: {
//   apps, events, failRun?, failMix?, ignoreSigterm?,
//   failMix: 実物の `mix` の失敗（標準エラーに理由を出して 0 以外で終わる）を真似る。出力は書かない
//   unexpectedExit?: { afterMs, code?, signal? }
//     code 指定: 実物の「エラーで終わる」（order.md の 2 つ目の止まり方）を真似る。録音は閉じてから、その code で終了する
//     signal 指定: 実物の「落ちる」（SIGSEGV 等）を真似る。後片付けなしに自分へ signal を送って即座に終わる（録音は閉じない）
//   stderrLines?: 起動直後（record({type:"run"}) の直後）に標準エラーへ 1 行ずつ書く所定の行。
//     intake-stopped の stderrTail が実際の標準エラーの値を反映することを、テストが直接アサートできるように
//     するための台本項目（TEST-161-003）。終了直前ではなく起動直後に書くのは、
//     child.once("exit") が最後の stderr の data イベントより先に解決し得るため（取りこぼしを避ける）
// }
//   --audio-dir <dir> があると、終了時に <dir>/相手[-n].m4a・<dir>/自分[-n].m4a を書く（n は --audio-index。1 か省略なら付けない）
// 記録ファイルには 1 行 1 件の JSON を追記する:
//   { type: "run", argv, pid }、{ type: "mix", argv }、{ type: "connection" }、{ type: "signal", signal: "SIGTERM" }、
//   { type: "unexpectedExit", code?, signal? }
//
// Issue #240 段 3（ADR 0008、CT-FAKE-TRIM）: 起動し直し・stop/close の重なりの台本（attempts・
// listenDelayMs・delayedEvents・originHostTime）は、偽の Helpers の Layer（server/test/sessions.test.ts・
// http.heavy.test.ts）に移した。本物の子プロセスで残す契約 6 本が使う項目だけに絞る。
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";

const [scriptPath, recordPath, command, ...rest] = process.argv.slice(2);
if (!scriptPath || !recordPath) throw new Error("usage: fake-helper.ts <台本JSON> <記録ファイル> <list|run ...>");

type Script = {
  apps: unknown;
  events: unknown[];
  failRun?: { stderr: string; code: number };
  failMix?: { stderr: string; code: number };
  ignoreSigterm?: boolean;
  unexpectedExit?: { afterMs: number; code?: number; signal?: NodeJS.Signals };
  stderrLines?: string[];
};

const script = JSON.parse(readFileSync(scriptPath, "utf8")) as Script;
// 書き終わった録音の内容。テストは、これが全部入っていることで「最後まで書かれた」と判断する
const AUDIO_COMPLETE = "complete";
const AUDIO_FLUSH_MS = 300;
// `mix` が --out に書く小さなバイト列（m4a ではないが、呼び出し側は中身を見ない）
const MIX_OUTPUT = "fake-mix-output";
const record = (entry: object) => appendFileSync(recordPath, JSON.stringify(entry) + "\n");

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
} else if (command === "mix") {
  record({ type: "mix", argv: [command, ...rest] });
  if (script.failMix) {
    process.stderr.write(script.failMix.stderr);
    process.exit(script.failMix.code);
  }
  writeFileSync(rest[rest.indexOf("--out") + 1]!, MIX_OUTPUT);
} else if (command === "run") {
  record({ type: "run", argv: [command, ...rest], pid: process.pid });
  // 起動直後に書く（終了直前だと child.once("exit") が最後の data イベントより先に解決し得るため）
  for (const line of script.stderrLines ?? []) process.stderr.write(line + "\n");
  if (script.failRun) {
    process.stderr.write(script.failRun.stderr);
    process.exit(script.failRun.code);
  }
  const port = Number(rest[rest.indexOf("--port") + 1]);
  const audioDirIndex = rest.indexOf("--audio-dir");
  const audioDir = audioDirIndex >= 0 ? rest[audioDirIndex + 1] : undefined;
  const audioIndexArgIndex = rest.indexOf("--audio-index");
  const audioIndex = audioIndexArgIndex >= 0 ? Number(rest[audioIndexArgIndex + 1]) : undefined;
  const wss = new WebSocketServer({ port, host: "127.0.0.1" });
  // 実物と同じく、SIGTERM で片付けて正常終了する（ignoreSigterm のときを除く）
  process.on("SIGTERM", () => {
    record({ type: "signal", signal: "SIGTERM" });
    if (script.ignoreSigterm) return;
    for (const client of wss.clients) client.close();
    const finish = () => wss.close(() => process.exit(0));
    if (!audioDir) return finish();
    // 実物のヘルパーが録音を閉じるまでにかかる時間を真似る。先に空のファイルを作り、遅れて内容を書き終える
    writeAudioPlaceholders(audioDir, audioIndex);
    setTimeout(() => {
      for (const name of audioFileNames(audioIndex)) writeFileSync(join(audioDir, name), AUDIO_COMPLETE);
      finish();
    }, AUDIO_FLUSH_MS);
  });
  wss.on("connection", (client) => {
    record({ type: "connection" });
    // 台本のイベントは接続を受けた直後に全部送る。送信は終了より前に済む
    for (const event of script.events) client.send(JSON.stringify(event));
  });
  if (script.unexpectedExit) {
    const { afterMs, code, signal } = script.unexpectedExit;
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
