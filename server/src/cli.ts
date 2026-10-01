#!/usr/bin/env node
// live-mindmap の CLI。AI エージェントが Bash から呼ぶ（ADR 0003）。
//   play <文字起こしファイル> [--realtime]
//                                 録音サンプルの文字起こしを再生し、マップを組み立てる（既定は待ち時間なし、--realtime で等速）。
//                                 再生中は WebSocket で、反映のたびにマップ全体をブラウザへ送る
//   export --format json          最新のセッションのマップを標準出力に出す
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { createSession, fromTranscript, playback, type DiffUpdater } from "./core/index.ts";
import { startSnapshotServer } from "./ws.ts";

export type CliDeps = {
  updater?: DiffUpdater;
  sessionsDir?: string;
  stdout?: (s: string) => void;
  port?: number; // スナップショットを配信する WebSocket のポート。0 なら空きポート
  sleep?: (ms: number) => Promise<void>; // --realtime のときの待ち方
  onListening?: (port: number) => void;
};

// セッションのフォルダに置く、その時点のエクスポート。別のプロセスの export がこれを読む。
// サーバーが状態を持つようになったら（#35）、export はサーバーに聞く形に差し替える。
const EXPORT_FILE = "export.json";

const DEFAULT_PORT = 4319;
const defaultPort = () => Number(process.env.LIVE_MINDMAP_PORT ?? DEFAULT_PORT);
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const defaultSessionsDir = () => process.env.LIVE_MINDMAP_SESSIONS ?? join(homedir(), ".live-mindmap", "sessions");

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<void> {
  const sessionsDir = deps.sessionsDir ?? defaultSessionsDir();
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { format: { type: "string", default: "md" }, realtime: { type: "boolean" } },
  });
  const [command, ...rest] = positionals;

  switch (command) {
    case "play": {
      const file = rest[0];
      if (!file) throw new Error("usage: play <文字起こしファイル> [--realtime]");
      const updater = deps.updater ?? (await import("./claude.ts")).claudeUpdater;
      const dir = join(sessionsDir, new Date().toISOString().replaceAll(":", "-"));
      mkdirSync(dir, { recursive: true });
      const server = await startSnapshotServer({ port: deps.port ?? defaultPort() });
      try {
        deps.onListening?.(server.port);
        const session = createSession({
          title: basename(file).replace(/\.transcript\.json$/, ""),
          updater,
          log: (event) => {
            appendFileSync(join(dir, "log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
            writeFileSync(join(dir, EXPORT_FILE), JSON.stringify(session.exportJson()));
            if (event.type === "diff" && !event.error) server.publish(session.snapshot());
          },
        });
        server.publish(session.snapshot()); // 最初のルート
        await playback(
          session,
          fromTranscript(JSON.parse(readFileSync(file, "utf8"))),
          values.realtime ? { sleep: deps.sleep ?? realSleep } : {},
        );
      } finally {
        await server.close();
      }
      stdout(`${dir}\n`);
      return;
    }
    case "export": {
      if (values.format !== "json") throw new Error(`未対応の形式: ${values.format}（いまは --format json だけ）`);
      // セッションのフォルダ（名前は開始時刻）のうち、エクスポートを持つ最新のもの
      const latest = existsSync(sessionsDir)
        ? readdirSync(sessionsDir).filter((d) => existsSync(join(sessionsDir, d, EXPORT_FILE))).sort().at(-1)
        : undefined;
      if (!latest) throw new Error(`セッションがありません: ${sessionsDir}`);
      const exported = JSON.parse(readFileSync(join(sessionsDir, latest, EXPORT_FILE), "utf8"));
      stdout(JSON.stringify(exported, null, 2) + "\n");
      return;
    }
    default:
      throw new Error("usage: live-mindmap <play|export> ...");
  }
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
