#!/usr/bin/env node
// live-mindmap の CLI。AI エージェントが Bash から呼ぶ（ADR 0003）。
//   play <文字起こしファイル>     録音サンプルの文字起こしを待ち時間なしで再生し、マップを組み立てる
//   export --format json          最新のセッションのマップを標準出力に出す
//   restore                       最新のセッションのログから、差分更新を呼ばずにマップを戻す
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { createSession, fromTranscript, playback, restoreSession, type DiffUpdater, type Session } from "./core/index.ts";

export type CliDeps = {
  updater?: DiffUpdater;
  sessionsDir?: string;
  stdout?: (s: string) => void;
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

const defaultSessionsDir = () => process.env.LIVE_MINDMAP_SESSIONS ?? join(homedir(), ".live-mindmap", "sessions");

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<void> {
  const sessionsDir = deps.sessionsDir ?? defaultSessionsDir();
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { format: { type: "string", default: "md" } },
  });
  const [command, ...rest] = positionals;

  switch (command) {
    case "play": {
      const file = rest[0];
      if (!file) throw new Error("usage: play <文字起こしファイル>");
      const updater = deps.updater ?? (await import("./claude.ts")).claudeUpdater;
      const dir = join(sessionsDir, new Date().toISOString().replaceAll(":", "-"));
      mkdirSync(dir, { recursive: true });
      // 開始のイベントは createSession の中で log されるので、session の代入前は export.json を書けない
      let session: Session | undefined;
      session = createSession({
        title: basename(file).replace(/\.transcript\.json$/, ""),
        updater,
        log: (event) => {
          appendFileSync(join(dir, LOG_FILE), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
          if (session) writeFileSync(join(dir, EXPORT_FILE), JSON.stringify(session.exportJson()));
        },
      });
      await playback(session, fromTranscript(JSON.parse(readFileSync(file, "utf8"))));
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
    default:
      throw new Error("usage: live-mindmap <play|export|restore> ...");
  }
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
