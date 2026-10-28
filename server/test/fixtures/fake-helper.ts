import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";

const [scriptPath, recordPath, command, ...rest] = process.argv.slice(2);
if (!scriptPath || !recordPath) throw new Error("usage: fake-helper.ts <台本JSON> <記録ファイル> <list|run ...>");

type Script = {
  apps: unknown;
  events: unknown[];
  failRun?: { stderr: string; code: number };
  ignoreSigterm?: boolean;
  unexpectedExit?: { afterMs: number; code?: number; signal?: NodeJS.Signals };
  stderrLines?: string[];
  schedule?: { afterMs: number; events: unknown[] }[];
};

const script = JSON.parse(readFileSync(scriptPath, "utf8")) as Script;
const AUDIO_COMPLETE = "complete";
const AUDIO_FLUSH_MS = 50;
const MIX_OUTPUT = "fake-mix-output";
const record = (entry: object) => appendFileSync(recordPath, JSON.stringify(entry) + "\n");

function audioFileNames(index: number | undefined): [string, string] {
  const suffix = index !== undefined && index > 1 ? `-${index}` : "";
  return [`相手${suffix}.m4a`, `自分${suffix}.m4a`];
}

function closeAudioThen(audioDir: string | undefined, index: number | undefined, finish: () => void): void {
  if (!audioDir) return finish();
  const files = audioFileNames(index).map((name) => join(audioDir, name));
  for (const file of files) writeFileSync(file, "");
  setTimeout(() => {
    for (const file of files) writeFileSync(file, AUDIO_COMPLETE);
    finish();
  }, AUDIO_FLUSH_MS);
}

if (command === "check") {
  console.log(JSON.stringify({ microphone: "authorized", ...(rest.includes("--no-screen") ? {} : { screenCapture: true }), speechJa: { status: "installed", installedLocales: ["ja-JP"] } }));
} else if (command === "list") {
  console.log(JSON.stringify(script.apps));
} else if (command === "mix") {
  record({ type: "mix", argv: [command, ...rest] });
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
  process.on("SIGTERM", () => {
    record({ type: "signal", signal: "SIGTERM" });
    if (script.ignoreSigterm) return;
    for (const client of wss.clients) client.close();
    closeAudioThen(audioDir, audioIndex, () => wss.close(() => process.exit(0)));
  });
  wss.on("connection", (client) => {
    record({ type: "connection" });
    for (const event of script.events) client.send(JSON.stringify(event));
    const timers = (script.schedule ?? []).map(({ afterMs, events }) => setTimeout(() => {
      for (const event of events) client.send(JSON.stringify(event));
    }, afterMs));
    client.on("close", () => { for (const timer of timers) clearTimeout(timer); });
  });
  if (script.unexpectedExit) {
    const { afterMs, code, signal } = script.unexpectedExit;
    setTimeout(() => {
      record({ type: "unexpectedExit", code, signal });
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      closeAudioThen(audioDir, audioIndex, () => process.exit(code ?? 1));
    }, afterMs);
  }
} else {
  throw new Error(`未対応のコマンド: ${command}`);
}
