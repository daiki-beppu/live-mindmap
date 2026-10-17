import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import type { CaptionsFrame, Snapshot } from "../../server/src/core/index.ts";
import { spokenBubble } from "./fixtures/captions.ts";
import { buildReviewTimeline, CAPTION_SECONDS, snapshotAt } from "../src/reviewTimeline.ts";
import { LOG_PATH, PAGE_VIEWPORT, readFoldkitViewport } from "./reviewPage.ts";
import type { Browser, Page } from "./screenCompare.ts";

// 会議中の画面の heavy IT（Issue #829。meeting.mount.heavy.test.ts と、React を消す前の照合 meetingCompare.heavy.test.ts）が共有する道具。
// テストではなく、web の Vite の開発サーバーの起動・`/ws` の frame を送るページの開き方・ビューポートの読み方・題材の frame だけを置く。
// 会議中の画面は `/ws` の WebSocket から frame を受けるので、page.routeWebSocket("**/ws") で本物の server の代わりに frame を送る（server/test/diffUpdateNotice.heavy.test.ts と同じ手法）。

export const MEETING_TIMEOUT = 180_000;

export type MeetingServer = { url: string; close: () => Promise<void> };

// web の Vite の開発サーバー。HMR の WebSocket は張らない（`/ws` の route と混ざらないように）
export async function startMeetingServer(): Promise<MeetingServer> {
  const root = join(import.meta.dirname, "..");
  const vite: ViteDevServer = await createServer({ root, configFile: join(root, "vite.config.ts"), logLevel: "silent", server: { host: "127.0.0.1", port: 0, hmr: false, ws: false } });
  await vite.listen();
  const url = vite.resolvedUrls?.local[0];
  if (url === undefined) throw new Error("Vite の開発サーバーの URL を取れません");
  return { url, close: () => vite.close() };
}

// ---- 題材: 照合の例のログ（screenCompare.log.jsonl）から作る frame ----
export type MeetingFrames = {
  // 最初に送る frame（字幕・スナップショット）。「開く」の丸（畳まれた議題）が出る時点のスナップショット
  first: unknown[];
  // 後から送る反映（新しいスナップショットと、そのときの字幕）。ログの最後の反映
  reflected: unknown[];
};

export async function meetingFrames(): Promise<MeetingFrames> {
  const events = (await readFile(LOG_PATH, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
  const timeline = buildReviewTimeline(events);
  const times = timeline.reflectionTimes;
  // 最後から 2 番目の反映（議題が済みになって畳まれた後）→ 最後の反映
  const firstAt = times[times.length - 2];
  const lastAt = times[times.length - 1];
  if (firstAt === undefined || lastAt === undefined) throw new Error("照合の例のログに反映が 2 回以上ありません");
  const framesAt = (t: number): unknown[] => {
    // トラックごとに、end ≤ t で最も遅い発言の本文を、end から CAPTION_SECONDS 未満の間だけ出す（会議中の画面の照合の題材。frame は変えない）
    const speakingOf = (track: "相手" | "自分"): string => {
      const latest = timeline.remarks.map((r) => r.remark).filter((r) => r.track === track && r.end <= t).reduce<(typeof timeline.remarks)[number]["remark"] | undefined>((best, r) => (!best || r.end >= best.end ? r : best), undefined);
      return latest && t - latest.end < CAPTION_SECONDS ? latest.text : "";
    };
    const speaking = { 相手: speakingOf("相手"), 自分: speakingOf("自分") };
    return [
      // 見返しの時刻の字幕の文字を、確定したラベルつきの吹き出しにして流す（空のトラックは吹き出しにしない）
      { type: "captions", bubbles: [...(speaking.相手 === "" ? [] : [spokenBubble(speaking.相手, "相手")]), ...(speaking.自分 === "" ? [] : [spokenBubble(speaking.自分, "自分")])] } satisfies CaptionsFrame,
      snapshotAt(timeline, t) satisfies Snapshot,
    ];
  };
  return { first: framesAt(firstAt), reflected: framesAt(lastAt) };
}

// ---- ページ ----
// playwright-core は web の依存ではないので、route のハンドラの引数の型から取る
type WebSocketRoute = Parameters<Parameters<Page["routeWebSocket"]>[1]>[0];
// 開いたページへ frame を送る口。ページごとに、最後につながった WebSocket を覚える（React の StrictMode は接続を張り直すので、最後の 1 本が生きている）
type SocketHolder = { current: WebSocketRoute | undefined; connections: number };
const sockets = new WeakMap<Page, SocketHolder>();

// ページが `/ws` につないだ回数（切れたあとの再接続を数える）
export const connectionCount = (page: Page): number => sockets.get(page)?.connections ?? 0;
// つながっている `/ws` を server の側から閉じる（ブラウザには「切れた」として届く）
export const closeSocket = async (page: Page): Promise<void> => {
  const holder = sockets.get(page);
  if (holder?.current === undefined) throw new Error("WebSocket がつながっていません");
  await holder.current.close();
};

export const sendFrame = async (page: Page, frame: unknown): Promise<void> => {
  const holder = sockets.get(page);
  if (holder?.current === undefined) throw new Error("WebSocket がつながっていません（openMeetingPage で開いたページではない）");
  holder.current.send(JSON.stringify(frame));
};
export const sendFrames = async (page: Page, frames: readonly unknown[]): Promise<void> => {
  for (const frame of frames) await sendFrame(page, frame);
};

// ページの `/ws` を本物の server の代わりにする: つながったら frames を先に送り、あとから sendFrame で送れるようにする
export async function connectFrames(page: Page, frames: readonly unknown[]): Promise<void> {
  const holder: SocketHolder = { current: undefined, connections: 0 };
  sockets.set(page, holder);
  await page.routeWebSocket("**/ws", (ws) => {
    holder.current = ws;
    holder.connections += 1;
    for (const frame of frames) ws.send(JSON.stringify(frame));
  });
}

export type OpenMeetingOptions = {
  // 接続した時点で server が先に送る frame
  frames: readonly unknown[];
  // ページの大きさ。省略すると PAGE_VIEWPORT（1280×801、Mac の幅）
  viewport?: { width: number; height: number };
};

// 会議中の画面を開き、ノードが出て画面が使える状態になるまで待って返す
export async function openMeetingPage(browser: Browser, server: MeetingServer, { frames, viewport = PAGE_VIEWPORT }: OpenMeetingOptions): Promise<Page> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await connectFrames(page, frames);
  await page.goto(server.url);
  await page.locator(".map-node").first().waitFor({ timeout: 30_000 });
  return page;
}

export const readMeetingViewport = readFoldkitViewport;

// ノードが全部測られて見える状態（ResizeObserver が届いた後）になるまで待つ
export const waitForMeasuredNodes = (page: Page, count: number): Promise<unknown> =>
  page.waitForFunction(
    (expected) => {
      const nodes = [...document.querySelectorAll<HTMLElement>("[data-node-id]")];
      return nodes.length === expected && nodes.every((el) => el.style.visibility === "visible");
    },
    count,
    { timeout: 30_000 },
  );

// ---- 知らせの frame ----
export const NOTICE_FRAMES = {
  screen: { type: "screen-notice", text: "共有画面は使っていません（画面収録の許可がありません）" },
  tap: { type: "tap-notice", text: "相手の音声が届いていません（出力の機器を切り替えた後に起きることがあります）" },
} as const;
