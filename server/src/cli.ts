#!/usr/bin/env node
// live-mindmap の CLI。AI エージェントが Bash から呼ぶ（ADR 0003）。
//   play <文字起こしファイル> [--realtime]
//                                 録音サンプルの文字起こしを再生し、マップを組み立てる（既定は待ち時間なし、--realtime で等速）。
//                                 再生中は WebSocket で、反映のたびにマップ全体をブラウザへ送る。
//                                 終わると、セッションのフォルダに map.md・map.json・map.drawnix を書き出し、そのパスを出す
//   apps                          会議アプリの一覧（JSON）を出す。常駐サーバー（pnpm dev）に頼む
//   start --app <bundle id> [--title <名前>]
//                                 ライブのセッションを開始する。サーバーがヘルパーを起動し、セッションのフォルダを出す。同時に 1 つだけ
//   stop                          ライブのセッションを終了し、map.md・map.json・map.drawnix を書き出して、そのパスを出す
//   export [--format md|json]     最新のセッションのマップを標準出力に出す（既定は md。ファイルは作らない）
//   restore                       最新のセッションのログから、差分更新を呼ばずにマップを戻す
//   eval [--truth <正解ファイル>] <セッションのフォルダ>...
//                                 play で作ったランの指標を 1 ラン 1 行の表で出す。正解（{ "決定": [{ text, from, to }], "TODO": [...] }、
//                                 from / to は会議の中の秒）を渡すと決定・TODO の再現率も出す
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { createSession, exportFiles, formatTable, fromTranscript, parseTruth, playback, restoreSession, toMarkdown, type DiffUpdater, type JsonExport, type Run, type Session, type Snapshot, type Truth } from "./core/index.ts";
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
// play もライブのセッションも、作成直後と log のたびに書く。サーバーが動いていなくても export できる。
const EXPORT_FILE = "export.json";

// セッション終了時の書き出し。スナップショットは 1 回だけ取り、3 形式に同じものを渡す。
// ライブのセッションの終了処理からも、この関数を呼ぶ。書いたファイルのパスを順に返す。
export function writeSessionExports(dir: string, exp: JsonExport): string[] {
  return Object.entries(exportFiles(exp)).map(([name, content]) => {
    const path = join(dir, name);
    writeFileSync(path, content.endsWith("\n") ? content : content + "\n");
    return path;
  });
}

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
export const defaultPort = () => Number(process.env.LIVE_MINDMAP_PORT ?? DEFAULT_PORT);
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const defaultSessionsDir = () => process.env.LIVE_MINDMAP_SESSIONS ?? join(homedir(), ".live-mindmap", "sessions");

export type RecordedSessionOptions = {
  sessionsDir: string;
  title?: string; // 省略したときは、セッションのフォルダ名（開始時刻）
  updater: DiffUpdater;
  publish: (snapshot: Snapshot) => void;
};

// セッションのフォルダ（名前は開始時刻）を作り、ログと export.json を書きながら、マップが変わるたびに publish する。
// play もライブのセッションも、この 1 つの配線で動かす（出どころだけが違う）。
export function startRecordedSession({ sessionsDir, title, updater, publish }: RecordedSessionOptions): { dir: string; session: Session } {
  const dir = join(sessionsDir, new Date().toISOString().replaceAll(":", "-"));
  mkdirSync(dir, { recursive: true });
  // 開始のイベントは createSession の中で log されるので、session の代入前は export.json を書けない
  let session: Session | undefined;
  session = createSession({
    title: title ?? basename(dir),
    updater,
    log: (event) => {
      appendFileSync(join(dir, LOG_FILE), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
      if (!session) return;
      writeFileSync(join(dir, EXPORT_FILE), JSON.stringify(session.exportJson()));
      if (event.type === "diff" && !event.error) publish(session.snapshot());
    },
  });
  // 発言が 1 件も来なくても、export が前のセッションではなくこのセッションのマップを返すように、作成直後にも書く
  writeFileSync(join(dir, EXPORT_FILE), JSON.stringify(session.exportJson()));
  publish(session.snapshot()); // 最初のルート
  return { dir, session };
}

// 常駐サーバーへ依頼を送る。2xx 以外は、応答の { error } をメッセージにして例外にする
async function requestServer(port: number, method: "GET" | "POST", path: string, body?: object): Promise<any> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error("サーバーにつながりません（pnpm dev で起動）");
  }
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `サーバーがエラーを返しました: ${response.status}`);
  return data;
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<void> {
  const sessionsDir = deps.sessionsDir ?? defaultSessionsDir();
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { format: { type: "string", default: "md" }, realtime: { type: "boolean" }, truth: { type: "string" }, app: { type: "string" }, title: { type: "string" } },
  });
  const [command, ...rest] = positionals;

  switch (command) {
    case "play": {
      const file = rest[0];
      if (!file) throw new Error("usage: play <文字起こしファイル> [--realtime]");
      const updater = deps.updater ?? (await import("./claude.ts")).claudeUpdater;
      const server = await startSnapshotServer({ port: deps.port ?? defaultPort() });
      let paths: string[];
      try {
        deps.onListening?.(server.port);
        const { dir, session } = startRecordedSession({
          sessionsDir,
          title: basename(file).replace(/\.transcript\.json$/, ""),
          updater,
          publish: server.publish,
        });
        await playback(
          session,
          fromTranscript(JSON.parse(readFileSync(file, "utf8"))),
          values.realtime ? { sleep: deps.sleep ?? realSleep } : {},
        );
        paths = writeSessionExports(dir, session.exportJson());
      } finally {
        await server.close();
      }
      stdout(paths.map((p) => `${p}\n`).join(""));
      return;
    }
    case "apps": {
      const apps = await requestServer(deps.port ?? defaultPort(), "GET", "/apps");
      stdout(JSON.stringify(apps, null, 2) + "\n");
      return;
    }
    case "start": {
      if (!values.app) throw new Error("usage: start --app <bundle id> [--title <名前>]");
      const { dir } = await requestServer(deps.port ?? defaultPort(), "POST", "/session/start", { app: values.app, title: values.title });
      stdout(`${dir}\n`);
      return;
    }
    case "stop": {
      const { paths } = await requestServer(deps.port ?? defaultPort(), "POST", "/session/stop");
      stdout((paths as string[]).map((p) => `${p}\n`).join(""));
      return;
    }
    case "export": {
      if (values.format !== "md" && values.format !== "json") {
        throw new Error(`未対応の形式: ${values.format}（md か json）`);
      }
      const latest = latestSession(sessionsDir, EXPORT_FILE);
      const exported: JsonExport = JSON.parse(readFileSync(join(sessionsDir, latest, EXPORT_FILE), "utf8"));
      stdout(values.format === "md" ? toMarkdown(exported) : JSON.stringify(exported, null, 2) + "\n");
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
      throw new Error("usage: live-mindmap <play|apps|start|stop|export|restore|eval> ...");
  }
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
