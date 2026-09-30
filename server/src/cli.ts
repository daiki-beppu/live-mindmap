#!/usr/bin/env node
// live-mindmap の CLI。AI エージェントが Bash から呼ぶ（ADR 0003）。
//   play <文字起こしファイル>     録音サンプルの文字起こしを待ち時間なしで再生し、マップを組み立てる
//   export --format json          最新のセッションのマップを標準出力に出す
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { createSession, fromTranscript, playback, type DiffUpdater } from "./core/index.ts";

export type CliDeps = {
  updater?: DiffUpdater;
  sessionsDir?: string;
  stdout?: (s: string) => void;
};

// セッションのフォルダに置く、その時点のエクスポート。別のプロセスの export がこれを読む。
// サーバーが状態を持つようになったら（#35）、export はサーバーに聞く形に差し替える。
const EXPORT_FILE = "export.json";

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
      const session = createSession({
        title: basename(file).replace(/\.transcript\.json$/, ""),
        updater,
        log: (event) => {
          appendFileSync(join(dir, "log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
          writeFileSync(join(dir, EXPORT_FILE), JSON.stringify(session.exportJson()));
        },
      });
      await playback(session, fromTranscript(JSON.parse(readFileSync(file, "utf8"))));
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
