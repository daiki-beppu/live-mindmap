#!/usr/bin/env node
// 常駐サーバー（pnpm dev）。ADR 0003: ヘルパーはこのサーバーの子プロセスで、セッションの開始・終了は CLI から頼まれる。
//   GET  /apps            ヘルパーの `list` の結果（会議アプリの一覧）を返す
//   POST /session/start   { app, title?, audio? } ヘルパーを `run --app <app> --port <空きポート> [--audio-dir <セッションのフォルダ>]` で起動し、発言を中核へ流す。
//                         audio は既定で true（トラックごとの録音をセッションのフォルダに残す）。false なら録音しない
//   POST /session/stop    ヘルパーを止め、map.md・map.json・map.drawnix・map.png を書き出す（撮影に失敗したら map.png だけ除く）
//   GET  /session/status   取り込みの状態（動いている／途切れている／止まった／セッションなし）・フォルダ・起動し直した回数・最後の途切れの時刻
//   POST /session/resume   止まった状態からヘルパーを起動し直し、同じセッションを続ける（失敗の数は 0 から）
// スナップショットの WebSocket（ブラウザ向け）と同じポートで待ち受ける。同時に扱うセッションは 1 つ。
// 状態は idle → starting → live（取り込みは running ⇄ interrupted → stopped のいずれか）→ stopping → idle。
//
// Issue #161: ヘルパーが予期せず終わっても（stop・サーバーの終了によるものを除く）、同じセッション（同じマップ・ログ・
// 差分更新）へヘルパーを起動し直す。差し替えるのはヘルパーごとのもの（子プロセス・WebSocket・listen・ポート・終了の監視）
// だけで、ヘルパーに依らないもの（session・updater・speaking・settling・ID の採番）は引き継ぐ（live オブジェクトが保持する）。
import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { MapCapture } from "./capture.ts";
import type { SessionUpdater } from "./claude.ts";
import { createSessionDir, defaultPort, defaultSessionsDir, startRecordedSession, writeSessionExports } from "./cli.ts";
import {
  decideIntakeRestart,
  originFromHelper,
  partialFromHelper,
  remarkFromHelper,
  STDERR_TAIL_LINES,
  tailLines,
  type IntakeLogEvent,
  type IntakeStatusReport,
  type Session,
  type Track,
} from "./core/index.ts";
import { openHelperSocket, type HelperSocket } from "./helperSocket.ts";
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

type ExitInfo = { code: number | null; signal: NodeJS.Signals | null };
type Helper = { child: ChildProcess; stderr: () => string; exited: Promise<ExitInfo>; hasExited: () => boolean };

// ヘルパーに依らない、セッションの寿命ぶんだけ存在するもの（起動し直しをまたいで引き継ぐ。order.md 要件 #9）
type Live = {
  app: string;
  dir: string;
  audio: boolean;
  session: Session;
  updater: SessionUpdater;
  speaking: SpeakingRelay;
  settling: RemarkSettling;
  appendLog: (event: IntakeLogEvent) => void;
  origin: string | undefined; // 最初のヘルパーから受け取った原点。一度決まったら上書きしない（要件 #26）
  attempt: number; // 直近に起動した回数（1 始まり。--audio-index にそのまま使う）
  attemptStartedAt: number; // 直近の起動を始めた時刻（Date.now()）。60 秒の判断の基準
  failures: number; // 続けて失敗した回数（decideIntakeRestart が進める）
  restarts: number; // 成功した起動し直しの回数（cli status の「起動し直した回数」）
  lastInterruptedAt: string | undefined; // 最後に途切れた時刻（ISO）
};

// runRestartLoop が 1 回の起動し直しの試行の後片付けを終えた時点で解決する結果（複数失敗を集約する境界。
// この結果を基準に resume() の応答・ログ・フレームを作る。running: 動いている状態へ戻った。
// stopped: 続けて失敗して諦め、止まった状態になった（stderrTail は最後の失敗の標準エラー末尾）。
// aborted: stop/close に中断された（起動し直し自体は成立していない）
type RestartOutcome = { kind: "running" } | { kind: "stopped"; stderrTail: string[] } | { kind: "aborted" };

// ヘルパーごとのもの（起動し直しで差し替える。order.md 要件 #8）
// interrupted の settled は、この起動し直しの試行の後片付けが終わった時点（running へ移った、諦めた、または
// 中断されて止めた）で解決する。stop/close が abort するときは、これを待ってから session.flush() する。
// connectToHelper がちょうど接続に成功した直後に abort されても（competing で起動し直しが先に繋がることがある）、
// 届いていた発言を取りこぼさないため（runRestartLoop が wireListen してから後片付けする）
type Intake =
  | { kind: "running"; helper: Helper; ws: WebSocket; wsClosed: Promise<void> }
  | { kind: "interrupted"; controller: { aborted: boolean }; settled: Promise<RestartOutcome> }
  | { kind: "stopped" }; // 続けて 3 回失敗して諦めた。cli stop で書き出せる、cli resume で続けられる

type State =
  | { kind: "idle" }
  | { kind: "starting"; helper?: Helper }
  | { kind: "live"; live: Live; intake: Intake }
  | { kind: "stopping" };

type SpeakingRelay = ReturnType<typeof createSpeakingRelay>;
type RemarkSettling = ReturnType<typeof createRemarkSettling>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// 起動（起動し直しを含む）の失敗。connectToHelper が投げた理由と、その原因になった Helper（終了コード・シグナル・stderr を持つ）を運ぶ
class LaunchFailure extends Error {
  readonly helper: Helper;
  constructor(helper: Helper, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.helper = helper;
  }
}

// ヘルパーを止める。SIGTERM で終わらないヘルパー（#70）で、stop・close・start の後片付けが固まらないよう、時間切れなら SIGKILL に切り替える
// SIGKILL に切り替えたときだけ true を返す
async function stopHelper(helper: Helper): Promise<boolean> {
  if (helper.hasExited()) return false;
  helper.child.kill("SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), HELPER_STOP_TIMEOUT_MS);
  });
  const result = await Promise.race([helper.exited.then(() => false as const), timedOut]);
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
  let result: ExitInfo | undefined;
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    stderr += chunk.toString();
  });
  const exited = new Promise<ExitInfo>((resolve) => {
    // "exit" ではなく "close" を使う。"exit" は子プロセスの終了だけを知らせ、stderr パイプの最後の "data"
    // （終了直前に書かれた分）がまだ届いていない可能性がある。"close" は stdio の全ストリームが閉じた後に
    // 発火するため、ここで helper.stderr() を読む呼び出し元（finishAttempt の stderrTail）が、実際の
    // 標準エラーの末尾を取りこぼさない（code・signal の値は "exit" と同じ引数で渡る）
    child.once("close", (code, signal) => {
      result = { code, signal };
      resolve(result);
    });
    child.once("error", (e) => {
      stderr += String(e);
      result = { code: null, signal: null };
      resolve(result);
    });
  });
  return { child, stderr: () => stderr, exited, hasExited: () => result !== undefined };
}

// ヘルパーの WebSocket へつなぐ。ヘルパーの準備（モデルやマイクの許可）には時間がかかることがあるので、
// 子プロセスが生きている間は時間切れなしで再試行する。子が終わったら、その終了コード・シグナル・stderr を付けて失敗にする。
async function connectToHelper(helper: Helper, port: number): Promise<HelperSocket> {
  for (;;) {
    const socket = await openHelperSocket(`ws://127.0.0.1:${port}`);
    if (socket) return socket;
    await Promise.race([sleep(RETRY_MS), helper.exited]);
    if (helper.hasExited()) {
      const { code, signal } = await helper.exited;
      throw new Error(`ヘルパーが終了しました（${code ?? signal}）: ${helper.stderr().trim()}`);
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

// run の argv（ヘルパーに依らない部分は同じ形。audio・origin は未定義なら渡さない）
function helperRunArgs(port: number, app: string, audio: { dir: string; index: number } | undefined, origin: string | undefined): string[] {
  return [
    "run",
    "--app",
    app,
    "--port",
    String(port),
    ...(audio ? ["--audio-dir", audio.dir, "--audio-index", String(audio.index)] : []),
    ...(origin !== undefined ? ["--origin", origin] : []),
  ];
}

const TRACKS: Track[] = ["相手", "自分"]; // speakingRelay.ts の TRACKS と同じ書き方（Track 型で綴りを型検査する）

// ヘルパー（helperRunArgs が --audio-index として渡す attempt）が書く録音ファイルの名前。
// helper/Sources/HelperCore/Recording.swift の recordingFileName と同じ規則（1 回目は番号を付けない）。
// 採番規則の所有者をここに 1 つ置き、警告文もここから組み立てる（固定文字列をファイル名として埋め込まない）
function audioFileNames(attempt: number): string[] {
  return TRACKS.map((track) => (attempt > 1 ? `${track}-${attempt}.m4a` : `${track}.m4a`));
}

export async function startServer(options: ServerOptions): Promise<Server> {
  const { sessionsDir, openUpdater, capture, helper: helperCommand } = options;
  let state: State = { kind: "idle" };
  let current: Helper | undefined; // 直近に起動したヘルパーの子プロセス。終了時・中断時に止める対象
  let closing: Promise<void> | undefined;

  // 1 回分の起動（freePort → 中断判定 → spawn → 接続）。start() の初回起動と、起動し直しのどちらもここを通る。
  // isAborted は、起動し直しの最中に stop/close が来たことを知らせる（start() の初回は渡さない＝常に false）。
  // 接続に失敗したら LaunchFailure（終了コード・シグナル・stderr を運ぶ）で失敗にする。
  async function launchAttempt(
    buildArgs: (port: number) => string[],
    isAborted: () => boolean = () => false,
  ): Promise<{ helper: Helper; ws: WebSocket; listen: HelperSocket["listen"]; wsClosed: Promise<void> }> {
    const port = await freePort();
    // freePort の待機中に close() や abort が始まっていたら、ヘルパーを起動しない（子プロセスを残さない）
    if (closing || isAborted()) throw new RequestError(503, "中断されました");
    const helper = launchHelper(helperCommand.command, [...helperCommand.args, ...buildArgs(port)]);
    current = helper;
    let socket: HelperSocket;
    try {
      socket = await connectToHelper(helper, port);
    } catch (e) {
      throw new LaunchFailure(helper, e);
    }
    const wsClosed = new Promise<void>((resolve) => (socket.ws.readyState === WebSocket.CLOSED ? resolve() : socket.ws.once("close", () => resolve())));
    return { helper, ws: socket.ws, listen: socket.listen, wsClosed };
  }

  // ヘルパーからのイベントを live（ヘルパーに依らないもの）へつなぐ。原点は最初のヘルパーからの値だけ採用する（要件 #26）
  function wireListen(live: Live, listen: HelperSocket["listen"]) {
    listen((data) => {
      try {
        const event: unknown = JSON.parse(String(data));
        const origin = originFromHelper(event);
        if (origin !== null) {
          if (live.origin === undefined) live.origin = origin;
          return;
        }
        const remark = remarkFromHelper(event, "");
        if (remark) {
          const { id: _id, ...settled } = remark;
          live.settling.final(settled);
          return;
        }
        const partial = partialFromHelper(event);
        if (partial) {
          live.speaking.partial(partial.track, partial.text, partial.duplicate);
          live.settling.partial(partial);
        }
      } catch (e) {
        process.stderr.write(`ヘルパーのイベントを読み飛ばしました: ${e instanceof Error ? e.message : e}\n`);
      }
    });
  }

  // 1 回の起動（起動し直しを含む）の終わりを、分類 → 判断 → 投影の順で扱う（複数失敗を集約する境界）。
  // ログ・標準エラーは必ず書く。続けるか諦めるか（action）と、諦めたときに resume() の応答へ使う stderrTail を返し、
  // 状態の更新は呼び出し側が行う。
  async function finishAttempt(live: Live, info: ExitInfo, stderrText: string): Promise<{ action: "restart" | "giveup"; stderrTail: string[] }> {
    const stderrTail = tailLines(stderrText, STDERR_TAIL_LINES);
    live.appendLog({ type: "intake-stopped", code: info.code, signal: info.signal, stderrTail });
    process.stderr.write(`取り込みが止まった（${info.code ?? info.signal ?? "不明"}）\n`);
    const ranMs = Date.now() - live.attemptStartedAt;
    const decision = decideIntakeRestart({ failures: live.failures, ranMs });
    live.failures = decision.failures;
    if (decision.action === "giveup") {
      live.appendLog({ type: "intake-gave-up" });
      process.stderr.write("起動し直しを諦めました。取り込みは止まった状態です\n");
    }
    return { action: decision.action, stderrTail };
  }

  // 起動し直しのループ。成功するまで（または諦めるまで）、decideIntakeRestart の判断に従って繰り返す。
  // trigger は、成功したときのログ（intake-restarted）に残す「自動か resume か」の区別。
  // 終了の監視（watchForUnexpectedEnd）は戻り値を使わず await しない（成功・失敗は状態とログ・フレームに反映される）。
  // resume() は、この戻り値（RestartOutcome）を基準に応答を作る（複数失敗を集約する境界）。
  async function runRestartLoop(live: Live, controller: { aborted: boolean }, trigger: "auto" | "resume"): Promise<RestartOutcome> {
    for (;;) {
      if (controller.aborted || closing) return { kind: "aborted" };
      live.attempt += 1;
      live.attemptStartedAt = Date.now();
      let launched: Awaited<ReturnType<typeof launchAttempt>>;
      try {
        launched = await launchAttempt(
          (port) => helperRunArgs(port, live.app, live.audio ? { dir: live.dir, index: live.attempt } : undefined, live.origin),
          () => controller.aborted,
        );
      } catch (e) {
        if (controller.aborted || closing) return { kind: "aborted" }; // 中断。stop/close が後片付けを引き継ぐ
        const failure = e instanceof LaunchFailure ? e : undefined;
        const info: ExitInfo = failure ? await failure.helper.exited : { code: null, signal: null };
        const { action, stderrTail } = await finishAttempt(live, info, failure?.helper.stderr() ?? String(e));
        if (action === "giveup") {
          if (state.kind === "live" && state.live === live) {
            state = { kind: "live", live, intake: { kind: "stopped" } };
            snapshotServer.intake({ type: "intake", status: "stopped" });
          }
          return { kind: "stopped", stderrTail };
        }
        continue; // 続けて起動し直す
      }
      if (controller.aborted || closing) {
        // 中断された後に接続が追いついた（接続成功と abort が競合した）。繋がった事実は消さず、
        // 届いていたイベントを取り込んでから（wireListen は early バッファを同期的に流す）、
        // 通常の running→stop と同じ手順で後片付けする。何も受け取っていなければ、ただ止まるだけになる
        wireListen(live, launched.listen);
        await Promise.all([stopHelper(launched.helper), launched.wsClosed]);
        launched.ws.terminate();
        live.settling.drain();
        return { kind: "aborted" };
      }
      live.restarts += 1;
      live.appendLog({ type: "intake-restarted", trigger });
      process.stderr.write("ヘルパーを起動し直しました\n");
      if (state.kind === "live" && state.live === live) {
        state = { kind: "live", live, intake: { kind: "running", helper: launched.helper, ws: launched.ws, wsClosed: launched.wsClosed } };
        snapshotServer.intake({ type: "intake", status: "running" });
        wireListen(live, launched.listen);
        watchForUnexpectedEnd(live, launched.helper);
        return { kind: "running" };
      }
      // ここに来るのは本来ないはずだが、念のため子プロセスを残さない
      await stopHelper(launched.helper);
      return { kind: "aborted" };
    }
  }

  // 動いているヘルパーの終了を監視する。stop・close による意図した終了（closing、state が live でない、
  // intake が running でない、別のヘルパーに差し替わっている）は無視する。
  function watchForUnexpectedEnd(live: Live, helper: Helper): void {
    // wsClosed・finishAttempt の await の間に stop/close が割り込んでいないか（この running をまだ所有しているか）
    const stillOwns = (running: Intake & { kind: "running" }) => !closing && state.kind === "live" && state.live === live && state.intake === running;
    void helper.exited.then(async ({ code, signal }) => {
      if (closing) return;
      if (state.kind !== "live" || state.live !== live) return;
      if (state.intake.kind !== "running" || state.intake.helper !== helper) return;
      const running = state.intake;
      await running.wsClosed; // close より前に届いた発言を、すべて push 済みにする
      // wsClosed を待つ間に stop/close が先に終わらせていたら、後片付けは stop/close 側がすでに行っている。
      // ここで state を書き換えると、終わったセッションを「止まった」「途切れている」に戻してしまう
      if (!stillOwns(running)) return;
      running.ws.terminate();
      live.settling.drain(); // 確定結果に覆われなかった最後の発話を発言にする（要件 #5）
      live.speaking.clear(); // いま話している文字を空にする（永久停止はしない。要件 #6）
      live.lastInterruptedAt = new Date().toISOString();
      const { action } = await finishAttempt(live, { code, signal }, helper.stderr());
      // finishAttempt の間にも stop/close が割り込みうるので、state を書き換える直前に再確認する
      if (!stillOwns(running)) return;
      if (action === "giveup") {
        state = { kind: "live", live, intake: { kind: "stopped" } };
        snapshotServer.intake({ type: "intake", status: "stopped" });
        return;
      }
      const controller = { aborted: false };
      const settled = runRestartLoop(live, controller, "auto");
      state = { kind: "live", live, intake: { kind: "interrupted", controller, settled } };
      snapshotServer.intake({ type: "intake", status: "interrupted" });
    });
  }

  async function start(app: string, title: string | undefined, audio: boolean): Promise<{ dir: string }> {
    if (state.kind !== "idle") {
      throw new RequestError(409, state.kind === "live" ? "セッションが進行中です（先に stop）" : "セッションの開始・終了の処理中です");
    }
    const starting: State & { kind: "starting" } = { kind: "starting" };
    state = starting;
    let updater: SessionUpdater | undefined;
    try {
      // セッションのフォルダは、ヘルパーが録音を書き出す先として、起動の前に確定させる。
      // freePort の待機中に close() が始まっていたら、launchAttempt がヘルパーを起動せずに失敗する（子プロセスを残さない）
      const dir = createSessionDir(sessionsDir);
      // 60 秒の判断の基準は、接続が成功した時刻ではなく、起動（接続待ちを含む）を始めた時刻にする。
      // connectToHelper はマイクの許可待ち等で時間がかかることがあり、ここを接続成功後にすると、
      // 長く待ってから短時間で終わった回を「続けて失敗した」と誤って数えてしまう（起動し直しと同じ基準にそろえる）
      const attemptStartedAt = Date.now();
      const launched = await launchAttempt((port) => helperRunArgs(port, app, audio ? { dir, index: 1 } : undefined, undefined));
      starting.helper = launched.helper;
      // 初期ルートの公開は、ヘルパーへの接続が成功した後にする。公開したフレームは取り消せないので、
      // 開始に失敗するときに、接続中のクライアントへ空のマップを送らない。接続の解決からここまで await を入れない
      // 反映が終わるたびに、未反映の発言が変わるので、いま話している文字を送り直す
      let speaking: SpeakingRelay | undefined;
      updater = openUpdater();
      const { session, appendLog } = startRecordedSession({
        dir,
        title,
        updater: updater.update,
        publish: (snapshot) => snapshotServer.publish(snapshot),
        sleep,
        onDiff: () => speaking?.flushAll(),
      });
      const relay = (speaking = createSpeakingRelay({ unreflected: () => session.unreflectedRemarks(), send: (frame) => snapshotServer.speak(frame) }));
      let count = 0;
      // 発言は、確定結果と、1 秒更新されなかった途中結果のどちらからも、ここを通って差分更新・ログ・speaking へ届く（ID は push の直前に振る）。
      // このクロージャ（ID の採番）はセッションにつき 1 回だけ作り、起動し直しでは作り直さない（要件 #7・#9）
      const settling = createRemarkSettling({
        emit: (settled) => {
          count++;
          session.push({ ...settled, id: `r${count}` });
          relay.remark(settled.track);
        },
      });
      const live: Live = {
        app,
        dir,
        audio,
        session,
        updater,
        speaking: relay,
        settling,
        appendLog,
        origin: undefined,
        attempt: 1,
        attemptStartedAt,
        failures: 0,
        restarts: 0,
        lastInterruptedAt: undefined,
      };
      wireListen(live, launched.listen);
      state = { kind: "live", live, intake: { kind: "running", helper: launched.helper, ws: launched.ws, wsClosed: launched.wsClosed } };
      watchForUnexpectedEnd(live, launched.helper);
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
    if (state.kind !== "live") {
      throw new RequestError(409, state.kind === "idle" ? "進行中のセッションがありません" : "セッションの開始・終了の処理中です");
    }
    const { live, intake } = state;
    state = { kind: "stopping" };
    try {
      if (intake.kind === "running") {
        // 子の終了と WebSocket の close を待つ。close の前に届いた発言は、すべて push 済みになる
        const [killed] = await Promise.all([stopHelper(intake.helper), intake.wsClosed]);
        if (killed && live.audio) {
          // その時点で動いていた起動回（live.attempt）の録音ファイル名を示す。起動し直していれば相手-2.m4a 等になる
          process.stderr.write(`録音の書き終わりを確認できないまま、セッションを閉じます。${live.dir} の ${audioFileNames(live.attempt).join("・")} が不完全なことがあります\n`);
        }
        intake.ws.terminate();
        live.settling.drain(); // 確定結果に覆われなかった最後の発話を落とさない
      } else if (intake.kind === "interrupted") {
        // 起動し直しの最中。接続前（まだ current のまま）なら、ここで止めてすぐ終わらせる。
        // すでに接続に成功していたら、settled の後片付け（wireListen → drain）が届いた発言を取り込むので、
        // それを待ってから session.flush() する（子プロセスを残さない。届いていた発言も取りこぼさない）
        intake.controller.aborted = true;
        if (current) await stopHelper(current);
        await intake.settled;
      }
      // intake.kind === "stopped" のときは、待つものが何もない（ヘルパーの終了を待たずに進む。要件 #15）
      await live.session.flush();
      return { paths: await writeSessionExports(live.dir, live.session.snapshot(), capture) };
    } finally {
      state = { kind: "idle" };
      live.updater.close(); // session.flush() で最後の差分更新が終わっているので、ここで閉じる
      // 停止の成否に関係なく、予約を取り消して両トラックの仮の文字を空にする（失敗しても、古い文字が新規接続へ再送されない）
      live.speaking.stop();
      live.settling.stop();
      // speaking.stop() が両トラックへ空の frame を送るのと同じ理由で、接続中のクライアントにも、
      // 途切れ・止まったの一言を消すフレームを送る（接続を保ったクライアントに古い状態が残り続けない）。
      // status は "running" ではなく "none"（セッションが無い）にする。"running" だと、直前が interrupted/stopped
      // だったクライアントの useIntakeNotice が「再開した」と解釈し、終わったセッションに「再開しました」が出てしまう。
      // 新しく接続したクライアントへは、ws.ts が保持したこの none が届く。none は途切れ・止まったの文を
      // 出さない値なので一言は出ない（CT-NOTICE-CLEAR）
      snapshotServer.intake({ type: "intake", status: "none" });
    }
  }

  // 応答は、起動し直しの連鎖が実際に到達した状態（RestartOutcome）から作る。runRestartLoop が
  // state・ログ・フレームへ反映した後の結果を、ここでも基準に使う（複数失敗を集約する境界。resume() 独自の
  // 優先順位で running／stopped／aborted を読み替えない）。
  async function resume(): Promise<void> {
    if (state.kind !== "live") throw new RequestError(409, "進行中のセッションがありません");
    if (state.intake.kind !== "stopped") throw new RequestError(409, "取り込みは止まっていません（動いているか、起動し直しの最中です）");
    const { live } = state;
    live.failures = 0; // 失敗の数を 0 から数え直す（要件 #17）
    const controller = { aborted: false };
    const settled = runRestartLoop(live, controller, "resume");
    state = { kind: "live", live, intake: { kind: "interrupted", controller, settled } };
    snapshotServer.intake({ type: "intake", status: "interrupted" });
    const outcome = await settled;
    if (outcome.kind === "stopped") throw new RequestError(503, `起動し直しに失敗しました: ${outcome.stderrTail.join("\n")}`);
    if (outcome.kind === "aborted") throw new RequestError(503, "中断されました");
  }

  function status(): IntakeStatusReport {
    if (state.kind !== "live") return { status: "none" };
    const { live, intake } = state;
    return { status: intake.kind, dir: live.dir, restarts: live.restarts, lastInterruptedAt: live.lastInterruptedAt };
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
      case "GET /session/status":
        return status();
      case "POST /session/resume":
        await resume();
        return {};
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
    // closing は同期的に代入するので、開始中の start()・起動し直し中の runRestartLoop が（freePort の後で）検知して spawn しない。
    close() {
      closing ??= (async () => {
        const intakeAtClose = state.kind === "live" ? state.intake : undefined;
        if (intakeAtClose?.kind === "interrupted") intakeAtClose.controller.aborted = true;
        if (current) await stopHelper(current);
        if (intakeAtClose?.kind === "interrupted") await intakeAtClose.settled;
        if (state.kind === "live") {
          if (state.intake.kind === "running") state.intake.ws.terminate();
          state.live.speaking.stop();
          state.live.settling.stop();
          state.live.updater.close();
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
