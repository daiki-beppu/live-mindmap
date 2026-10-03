#!/usr/bin/env node
// 常駐サーバー（pnpm dev）。ADR 0003: ヘルパーはこのサーバーの子プロセスで、セッションの開始・終了は CLI から頼まれる。
//   GET  /apps            ヘルパーの `list` の結果（会議アプリの一覧）を返す
//   POST /session/start   { app, title?, audio? } ヘルパーを `run --app <app> --port <空きポート> [--audio-dir <セッションのフォルダ>]` で起動し、発言を中核へ流す。
//                         audio は既定で true（トラックごとの録音をセッションのフォルダに残す）。false なら録音しない
//   POST /session/stop    ヘルパーを止め、map.md・map.json・map.drawnix・map.png を書き出す（撮影に失敗したら map.png だけ除く）
// スナップショットの WebSocket（ブラウザ向け）と同じポートで待ち受ける。同時に扱うセッションは 1 つ。
// 状態は idle → starting → running → stopping → idle。開始・終了を受け付けるかは、この状態だけで決める。
import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { MapCapture } from "./capture.ts";
import type { SessionUpdater } from "./claude.ts";
import { createSessionDir, defaultPort, defaultSessionsDir, startRecordedSession, writeSessionExports } from "./cli.ts";
import { partialFromHelper, remarkFromHelper, type Session } from "./core/index.ts";
import { createRemarkSettling } from "./remarkSettling.ts";
import { createSpeakingRelay } from "./speakingRelay.ts";
import { isLocalOrigin, startSnapshotServer } from "./ws.ts";

export type ServerOptions = {
  port: number; // 0 なら空きポート
  sessionsDir: string;
  openUpdater: () => SessionUpdater; // セッションの開始ごとに 1 つ開く。stop・開始の失敗・サーバーの終了で閉じる
  capture: MapCapture; // 終了時の map.png の撮影
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
  | { kind: "running"; helper: Helper; ws: WebSocket; wsClosed: Promise<void>; session: Session; dir: string; audio: boolean; speaking: SpeakingRelay; settling: RemarkSettling; updater: SessionUpdater }
  | { kind: "stopping" };

type SpeakingRelay = ReturnType<typeof createSpeakingRelay>;
type RemarkSettling = ReturnType<typeof createRemarkSettling>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ヘルパーを止める。SIGTERM で終わらないヘルパー（#70）で、stop・close・start の後片付けが固まらないよう、時間切れなら SIGKILL に切り替える
// SIGKILL に切り替えたときだけ true を返す
async function stopHelper(helper: Helper): Promise<boolean> {
  if (helper.hasExited()) return false;
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
  return result;
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
  const { sessionsDir, openUpdater, capture, helper: helperCommand } = options;
  let state: State = { kind: "idle" };
  let current: Helper | undefined; // 子プロセスの所有者はこのサーバー。終了時に止める
  let closing: Promise<void> | undefined;

  async function start(app: string, title: string | undefined, audio: boolean): Promise<{ dir: string }> {
    if (state.kind !== "idle") {
      throw new RequestError(409, state.kind === "running" ? "セッションが進行中です（先に stop）" : "セッションの開始・終了の処理中です");
    }
    const starting: State & { kind: "starting" } = { kind: "starting" };
    state = starting;
    let updater: SessionUpdater | undefined;
    try {
      const helperPort = await freePort();
      // close() は current だけを止める。freePort の待機中に close() が始まっていたら、ヘルパーを起動しない（子プロセスが残る）
      if (closing) throw new RequestError(503, "サーバーを終了しています");
      // セッションのフォルダは、ヘルパーが録音を書き出す先として、起動の前に確定させる
      const dir = createSessionDir(sessionsDir);
      const helperArgs = ["run", "--app", app, "--port", String(helperPort), ...(audio ? ["--audio-dir", dir] : [])];
      starting.helper = current = launchHelper(helperCommand.command, [...helperCommand.args, ...helperArgs]);
      const ws = await connectToHelper(starting.helper, helperPort);
      // 初期ルートの公開は、ヘルパーへの接続が成功した後にする。公開したフレームは取り消せないので、
      // 開始に失敗するときに、接続中のクライアントへ空のマップを送らない。接続の解決からここまで await を入れない
      // 反映が終わるたびに、未反映の発言が変わるので、いま話している文字を送り直す
      let speaking: SpeakingRelay | undefined;
      updater = openUpdater();
      const { session } = startRecordedSession({
        dir,
        title,
        updater: updater.update,
        publish: (snapshot) => snapshotServer.publish(snapshot),
        sleep,
        onDiff: () => speaking?.flushAll(),
      });
      const relay = (speaking = createSpeakingRelay({ unreflected: () => session.unreflectedRemarks(), send: (frame) => snapshotServer.speak(frame) }));
      let count = 0;
      // 発言は、確定結果と、1 秒更新されなかった途中結果のどちらからも、ここを通って差分更新・ログ・speaking へ届く（ID は push の直前に振る）
      const settling = createRemarkSettling({
        emit: (settled) => {
          count++;
          session.push({ ...settled, id: `r${count}` });
          relay.remark(settled.track);
        },
      });
      ws.on("message", (data) => {
        try {
          const event: unknown = JSON.parse(String(data));
          const remark = remarkFromHelper(event, "");
          if (remark) {
            const { id: _id, ...settled } = remark;
            settling.final(settled);
            return;
          }
          const partial = partialFromHelper(event);
          if (partial) {
            relay.partial(partial.track, partial.text, partial.duplicate);
            settling.partial(partial);
          }
        } catch (e) {
          process.stderr.write(`ヘルパーのイベントを読み飛ばしました: ${e instanceof Error ? e.message : e}\n`);
        }
      });
      const wsClosed = new Promise<void>((resolve) => (ws.readyState === WebSocket.CLOSED ? resolve() : ws.once("close", () => resolve())));
      state = { kind: "running", helper: starting.helper, ws, wsClosed, session, dir, audio, speaking: relay, settling, updater };
      starting.helper.exited.then(() => {
        if (!closing && state.kind === "running" && state.helper === starting.helper) {
          process.stderr.write(`ヘルパーが終了しました: ${starting.helper!.stderr().trim()}\n`);
        }
      });
      return { dir };
    } catch (e) {
      updater?.close();
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
    const { helper, ws, wsClosed, session, dir, audio, speaking, settling, updater } = state;
    state = { kind: "stopping" };
    try {
      // 子の終了と WebSocket の close を待つ。close の前に届いた発言は、すべて push 済みになる
      const [killed] = await Promise.all([stopHelper(helper), wsClosed]);
      if (killed && audio) {
        process.stderr.write(`録音の書き終わりを確認できないまま、セッションを閉じます。${dir} の 相手.m4a・自分.m4a が不完全なことがあります\n`);
      }
      ws.terminate();
      settling.drain(); // 確定結果に覆われなかった最後の発話を落とさない
      await session.flush();
      return { paths: await writeSessionExports(dir, session.snapshot(), capture) };
    } finally {
      state = { kind: "idle" };
      updater.close(); // session.flush() で最後の差分更新が終わっているので、ここで閉じる
      // 停止の成否に関係なく、予約を取り消して両トラックの仮の文字を空にする（失敗しても、古い文字が新規接続へ再送されない）
      speaking.stop();
      settling.stop();
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
        if (body.audio !== undefined && body.audio !== null && typeof body.audio !== "boolean") throw new RequestError(400, "audio は真偽値にします");
        return start(body.app, body.title ?? undefined, body.audio ?? true);
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
          state.settling.stop();
          state.updater.close();
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
  const { openClaudeUpdater } = await import("./claude.ts");
  const { captureMap } = await import("./capture.ts");
  const server = await startServer({
    port: defaultPort(),
    sessionsDir: defaultSessionsDir(),
    openUpdater: () => openClaudeUpdater(),
    capture: captureMap,
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
