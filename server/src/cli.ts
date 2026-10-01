#!/usr/bin/env node
// live-mindmap の CLI。AI エージェントが Bash から呼ぶ（ADR 0003）。
//   play <文字起こしファイル> [--realtime]
//                                 録音サンプルの文字起こしを再生し、マップを組み立てる（既定は待ち時間なし、--realtime で等速）。
//                                 再生中は WebSocket で、反映のたびにマップ全体をブラウザへ送る
//   export --format json          最新のセッションのマップを標準出力に出す
//   restore                       最新のセッションのログから、差分更新を呼ばずにマップを戻す
//   eval [--truth <正解ファイル>] <セッションのフォルダ>...
//                                 play で作ったランの指標を 1 ラン 1 行の表で出す。正解（{ "決定": [{ text, from, to }], "TODO": [...] }、
//                                 from / to は会議の中の秒）を渡すと決定・TODO の再現率も出す
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { createSession, formatTable, fromTranscript, parseTruth, playback, restoreSession, type DiffUpdater, type Run, type Session, type Truth } from "./core/index.ts";
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

const LOG_FILE = "log.jsonl";

// セッションのフォルダ（名前は開始時刻）のうち、file を持つ最新のもの
function latestSession(sessionsDir: string, file: string): string {
  const latest = existsSync(sessionsDir)
    ? readdirSync(sessionsDir).filter((d) => existsSync(join(sessionsDir, d, file))).sort().at(-1)
    : undefined;
  if (!latest) throw new Error(`セッションがありません: ${sessionsDir}`);
  return latest;
}

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
    options: { format: { type: "string", default: "md" }, realtime: { type: "boolean" }, truth: { type: "string" } },
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
        // 開始のイベントは createSession の中で log されるので、session の代入前は export.json を書けない
        let session: Session | undefined;
        session = createSession({
          title: basename(file).replace(/\.transcript\.json$/, ""),
          updater,
          log: (event) => {
            appendFileSync(join(dir, LOG_FILE), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
            if (!session) return;
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
      const latest = latestSession(sessionsDir, EXPORT_FILE);
      const exported = JSON.parse(readFileSync(join(sessionsDir, latest, EXPORT_FILE), "utf8"));
      stdout(JSON.stringify(exported, null, 2) + "\n");
      return;
    }
    case "restore": {
      const dir = join(sessionsDir, latestSession(sessionsDir, LOG_FILE));
      const lines = readFileSync(join(dir, LOG_FILE), "utf8").split("\n").map((text, i) => ({ text, no: i + 1 })).filter((l) => l.text.trim() !== "");
      const events = lines.map(({ text, no }) => {
        try {
          return JSON.parse(text) as unknown;
        } catch (e) {
          throw new Error(`${LOG_FILE} の ${no} 行目が JSON として読めません: ${String(e)}`);
        }
      });
      // 復元では差分更新を呼ばない。呼ばれたら失敗する
      const updater = deps.updater ?? (async () => { throw new Error("restore では差分更新を呼べません"); });
      const session = restoreSession(events, { updater, log: () => {} });
      writeFileSync(join(dir, EXPORT_FILE), JSON.stringify(session.exportJson()));
      stdout(`${dir}\n`);
      return;
    }
    case "eval": {
      if (rest.length === 0) throw new Error("usage: eval [--truth <正解ファイル>] <セッションのフォルダ>...");
      let truth: Truth | undefined;
      if (values.truth) {
        try {
          truth = parseTruth(JSON.parse(readFileSync(values.truth, "utf8")));
        } catch (e) {
          throw new Error(`正解ファイルが不正です: ${values.truth}（${e instanceof Error ? e.message : e}）`);
        }
      }
      const runs: Run[] = rest.map((dir) => {
        const file = join(dir, EXPORT_FILE);
        if (!existsSync(file)) throw new Error(`セッションのマップがありません: ${file}`);
        const exp = JSON.parse(readFileSync(file, "utf8"));
        return { name: basename(dir), title: exp.root.text, exp };
      });
      stdout(formatTable(runs, truth));
      return;
    }
    default:
      throw new Error("usage: live-mindmap <play|export|restore|eval> ...");
  }
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
