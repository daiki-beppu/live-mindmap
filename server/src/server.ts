#!/usr/bin/env node
// 常駐サーバー（pnpm dev）。ADR 0003: ヘルパーはこのサーバーの子プロセスで、セッションの開始・終了は CLI から頼まれる。
//   GET  /apps            ヘルパーの `list` の結果（会議アプリの一覧）を返す
//   POST /session/start   { app, title? } ヘルパーを `run --app <app> --port <空きポート>` で起動し、発言を中核へ流す
//   POST /session/stop    ヘルパーを止め、map.md・map.json・map.drawnix を書き出す
// スナップショットの WebSocket（ブラウザ向け）と同じポートで待ち受ける。同時に扱うセッションは 1 つ。
// 状態は idle → starting → running → stopping → idle。開始・終了を受け付けるかは、この状態だけで決める。
import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { WebSocket } from "ws";
import { defaultPort, defaultSessionsDir, startRecordedSession, writeSessionExports } from "./cli.ts";
import { partialFromHelper, remarkFromHelper, type DiffUpdater, type Session } from "./core/index.ts";
import { createSpeakingRelay } from "./speakingRelay.ts";
import { isLocalOrigin, startSnapshotServer } from "./ws.ts";

export type ServerOptions = {
  port: number; // 0 なら空きポート
  sessionsDir: string;
  updater: DiffUpdater;
  helper: { command: string; args: string[] }; // 実行ファイルと、サブコマンドの前に付ける引数
  onListening?: (port: number) => void;
};

export type Server = { port: number; close: () => Promise<void> };

const RETRY_MS = 200;
// SIGTERM を送ってから、SIGKILL に切り替えるまでの待ち時間
export const HELPER_STOP_TIMEOUT_MS = 5_000;

// 状態に合わない依頼や不正な依頼。HTTP のステータスつきで、wrapper が応答に変える
class RequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Helper = { child: ChildProcess; stderr: () => string; exited: Promise<void>; hasExited: () => boolean };

type State =
  | { kind: "idle" }
  | { kind: "starting"; helper?: Helper }
  | { kind: "running"; helper: Helper; ws: WebSocket; wsClosed: Promise<void>; session: Session; dir: string; speaking: SpeakingRelay }
  | { kind: "stopping" };

type SpeakingRelay = ReturnType<typeof createSpeakingRelay>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ヘルパーを止める。SIGTERM で終わらないヘルパー（#70）で、stop・close・start の後片付けが固まらないよう、時間切れなら SIGKILL に切り替える
async function stopHelper(helper: Helper): Promise<void> {
  if (helper.hasExited()) return;
  helper.child.kill("SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), HELPER_STOP_TIMEOUT_MS);
  });
  const result = await Promise.race([helper.exited.then(() => false), timedOut]);
  clearTimeout(timer);
  if (result) {
    process.stderr.write(`ヘルパーが SIGTERM から ${HELPER_STOP_TIMEOUT_MS}ms 経っても終了しないので、SIGKILL で止めます\n`);
    helper.child.kill("SIGKILL");
    await helper.exited;
  }
}

// 空きポートを選ぶ（listen(0) で割り当てを受けてから閉じる）
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") return reject(new Error("空きポートを取得できません"));
      probe.close(() => resolve(address.port));
    });
  });
}

function launchHelper(command: string, args: string[]): Helper {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  let done = false;
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    stderr += chunk.toString();
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => {
      done = true;
      resolve();
    });
    child.once("error", (e) => {
      stderr += String(e);
      done = true;
      resolve();
    });
  });
  return { child, stderr: () => stderr, exited, hasExited: () => done };
}

// ヘルパーの WebSocket へつなぐ。ヘルパーの準備（モデルやマイクの許可）には時間がかかることがあるので、
// 子プロセスが生きている間は時間切れなしで再試行する。子が終わったら、その stderr を付けて失敗にする。
async function connectToHelper(helper: Helper, port: number): Promise<WebSocket> {
  for (;;) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const opened = await new Promise<boolean>((resolve) => {
      ws.once("open", () => resolve(true));
      ws.once("error", () => resolve(false));
    });
    if (opened) return ws;
    ws.terminate();
    await Promise.race([sleep(RETRY_MS), helper.exited]);
    if (helper.hasExited()) {
      throw new Error(`ヘルパーが終了しました（${helper.child.exitCode ?? helper.child.signalCode}）: ${helper.stderr().trim()}`);
    }
  }
}

function runHelperList({ command, args }: ServerOptions["helper"]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args, "list"], (error, stdout, stderr) => {
      if (error) return reject(new Error(`ヘルパーの list が失敗しました: ${stderr.trim() || error.message}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`ヘルパーの list の出力が JSON ではありません: ${stdout.trim()}`));
      }
    });
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString();
  if (text === "") return {};
  try {
    const body = JSON.parse(text);
    if (typeof body === "object" && body !== null && !Array.isArray(body)) return body;
  } catch {
    // 下の例外にまとめる
  }
  throw new RequestError(400, "リクエストの本文が JSON のオブジェクトではありません");
}

export async function startServer(options: ServerOptions): Promise<Server> {
  const { sessionsDir, updater, helper: helperCommand } = options;
  let state: State = { kind: "idle" };
  let current: Helper | undefined; // 子プロセスの所有者はこのサーバー。終了時に止める
  let closing: Promise<void> | undefined;

  async function start(app: string, title: string | undefined): Promise<{ dir: string }> {
    if (state.kind !== "idle") {
      throw new RequestError(409, state.kind === "running" ? "セッションが進行中です（先に stop）" : "セッションの開始・終了の処理中です");
    }
    const starting: State & { kind: "starting" } = { kind: "starting" };
    state = starting;
    try {
      const helperPort = await freePort();
      // close() は current だけを止める。freePort の待機中に close() が始まっていたら、ヘルパーを起動しない（子プロセスが残る）
      if (closing) throw new RequestError(503, "サーバーを終了しています");
      starting.helper = current = launchHelper(helperCommand.command, [...helperCommand.args, "run", "--app", app, "--port", String(helperPort)]);
      const ws = await connectToHelper(starting.helper, helperPort);
      // 初期ルートの公開は、ヘルパーへの接続が成功した後にする。公開したフレームは取り消せないので、
      // 開始に失敗するときに、接続中のクライアントへ空のマップを送らない。接続の解決からここまで await を入れない
      // 反映が終わるたびに、未反映の発言が変わるので、いま話している文字を送り直す
      let speaking: SpeakingRelay | undefined;
      const { dir, session } = startRecordedSession({
        sessionsDir,
        title,
        updater,
        publish: (snapshot) => snapshotServer.publish(snapshot),
        sleep,
        onDiff: () => speaking?.flushAll(),
      });
      const relay = (speaking = createSpeakingRelay({ unreflected: () => session.unreflectedRemarks(), send: (frame) => snapshotServer.speak(frame) }));
      let count = 0;
      ws.on("message", (data) => {
        try {
          const event: unknown = JSON.parse(String(data));
          const remark = remarkFromHelper(event, `r${count + 1}`);
          if (remark) {
            count++;
            session.push(remark);
            relay.remark(remark.track);
            return;
          }
          const partial = partialFromHelper(event);
          if (partial) relay.partial(partial.track, partial.text, partial.duplicate);
        } catch (e) {
          process.stderr.write(`ヘルパーのイベントを読み飛ばしました: ${e instanceof Error ? e.message : e}\n`);
        }
      });
      const wsClosed = new Promise<void>((resolve) => (ws.readyState === WebSocket.CLOSED ? resolve() : ws.once("close", () => resolve())));
      state = { kind: "running", helper: starting.helper, ws, wsClosed, session, dir, speaking: relay };
      starting.helper.exited.then(() => {
        if (!closing && state.kind === "running" && state.helper === starting.helper) {
          process.stderr.write(`ヘルパーが終了しました: ${starting.helper!.stderr().trim()}\n`);
        }
      });
      return { dir };
    } catch (e) {
      if (starting.helper) {
        await stopHelper(starting.helper);
      }
      state = { kind: "idle" };
      throw e;
    }
  }

  async function stop(): Promise<{ paths: string[] }> {
    if (state.kind !== "running") {
      throw new RequestError(409, state.kind === "idle" ? "進行中のセッションがありません" : "セッションの開始・終了の処理中です");
    }
    const { helper, ws, wsClosed, session, dir, speaking } = state;
    state = { kind: "stopping" };
    try {
      // 子の終了と WebSocket の close を待つ。close の前に届いた発言は、すべて push 済みになる
      await Promise.all([stopHelper(helper), wsClosed]);
      ws.terminate();
      await session.flush();
      return { paths: writeSessionExports(dir, session.exportJson()) };
    } finally {
      state = { kind: "idle" };
      // 停止の成否に関係なく、予約を取り消して両トラックの仮の文字を空にする（失敗しても、古い文字が新規接続へ再送されない）
      speaking.stop();
    }
  }

  async function dispatch(req: IncomingMessage): Promise<unknown> {
    const route = `${req.method} ${new URL(req.url ?? "/", "http://127.0.0.1").pathname}`;
    switch (route) {
      case "GET /apps":
        return runHelperList(helperCommand);
      case "POST /session/start": {
        const body = await readJson(req);
        if (typeof body.app !== "string" || body.app === "") throw new RequestError(400, "app（会議アプリの bundle id）が必要です");
        if (body.title !== undefined && body.title !== null && typeof body.title !== "string") throw new RequestError(400, "title は文字列にします");
        return start(body.app, body.title ?? undefined);
      }
      case "POST /session/stop":
        return stop();
      default:
        throw new RequestError(404, `未対応のリクエスト: ${route}`);
    }
  }

  // HTTP の例外は、ここ 1 か所で応答に変える（競合は 409、Origin の拒否は 403、それ以外は 500）
  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      let status = 200;
      let payload: unknown;
      try {
        // ブラウザ上の任意の Web ページから、セッションを操作させない（ws.ts の Origin の制限と同じ）
        if (req.headers.origin !== undefined && !isLocalOrigin(req.headers.origin)) throw new RequestError(403, "許可されていない Origin です");
        payload = await dispatch(req);
      } catch (e) {
        status = e instanceof RequestError ? e.status : 500;
        payload = { error: e instanceof Error ? e.message : String(e) };
      }
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
    })();
  }

  const snapshotServer = await startSnapshotServer({ port: options.port, onRequest });
  options.onListening?.(snapshotServer.port);

  return {
    port: snapshotServer.port,
    // 起動したヘルパーの子プロセスを残さない。セッションの書き出しはしない（export.json は反映のたびに書いてある）
    // closing は同期的に代入するので、開始中の start() が（freePort の後で）検知して spawn しない。
    close() {
      closing ??= (async () => {
        if (current) await stopHelper(current);
        if (state.kind === "running") {
          state.speaking.stop();
          state.ws.terminate();
        }
        await snapshotServer.close();
      })();
      return closing;
    },
  };
}

if (import.meta.main) {
  const helperPath = process.env.LIVE_MINDMAP_HELPER ?? join(import.meta.dirname, "../../helper/.build/debug/live-mindmap-helper");
  const { claudeUpdater } = await import("./claude.ts");
  const server = await startServer({
    port: defaultPort(),
    sessionsDir: defaultSessionsDir(),
    updater: claudeUpdater,
    helper: { command: helperPath, args: [] },
    onListening: (port) => console.error(`live-mindmap サーバーを起動しました: http://127.0.0.1:${port}`),
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close().then(
        () => process.exit(0),
        (e: unknown) => {
          console.error(e instanceof Error ? e.message : e);
          process.exit(1);
        },
      );
    });
  }
}
