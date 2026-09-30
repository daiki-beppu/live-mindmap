#!/usr/bin/env node
// live-mindmap の CLI。AI エージェントが Bash から呼ぶ（ADR 0003）。
//   replay <文字起こしファイル>   録音サンプルの文字起こしを待ち時間なしで流し、マップを組み立てる
//   export --format json          最新のセッションのマップを標準出力に出す
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import {
  createSession,
  fromTranscript,
  replay,
  toJsonExport,
  type DiffUpdater,
  type Snapshot,
  type Utterance,
} from "./core/index.ts";

export type CliDeps = {
  updater?: DiffUpdater;
  sessionsDir?: string;
  stdout?: (s: string) => void;
};

// セッションのフォルダに置く、その時点のマップ。別のプロセスの export がこれを読む。
// サーバーが状態を持つようになったら（#35）、export はサーバーに聞く形に差し替える。
type State = { snapshot: Snapshot; utterances: Utterance[] };

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
    case "replay": {
      const file = rest[0];
      if (!file) throw new Error("usage: replay <文字起こしファイル>");
      const updater = deps.updater ?? (await import("./claude.ts")).claudeUpdater;
      const dir = join(sessionsDir, new Date().toISOString().replaceAll(":", "-"));
      mkdirSync(dir, { recursive: true });
      const utterances: Utterance[] = [];
      const session = createSession({
        title: basename(file).replace(/\.transcript\.json$/, ""),
        updater,
        log: (event) => {
          appendFileSync(join(dir, "log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
          if (event.type === "utterance") utterances.push(event.utterance);
          const state: State = { snapshot: session.snapshot(), utterances };
          writeFileSync(join(dir, "state.json"), JSON.stringify(state));
        },
      });
      await replay(session, fromTranscript(JSON.parse(readFileSync(file, "utf8"))));
      stdout(`${dir}\n`);
      return;
    }
    case "export": {
      if (values.format !== "json") throw new Error(`未対応の形式: ${values.format}（いまは --format json だけ）`);
      const latest = readdirSync(sessionsDir).sort().at(-1);
      if (!latest) throw new Error(`セッションがありません: ${sessionsDir}`);
      const state: State = JSON.parse(readFileSync(join(sessionsDir, latest, "state.json"), "utf8"));
      stdout(JSON.stringify(toJsonExport(state.snapshot, state.utterances), null, 2) + "\n");
      return;
    }
    default:
      throw new Error("usage: live-mindmap <replay|export> ...");
  }
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
