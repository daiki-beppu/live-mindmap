import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import type { CaptionsFrame, SnapshotFrame } from "../../server/src/core/index.ts";
import { spokenBubble } from "./fixtures/captions.ts";
import { buildReviewTimeline, CAPTION_SECONDS, snapshotAt } from "../src/reviewTimeline.ts";
import { LOG_PATH, readFoldkitViewport } from "./reviewPage.ts";
import type { BrowserContext, Page } from "./browser.ts";

export const MEETING_TIMEOUT = 180_000;

export type MeetingServer = { url: string; close: () => Promise<void> };

export async function startMeetingServer(): Promise<MeetingServer> {
  const root = join(import.meta.dirname, "..");
  const vite: ViteDevServer = await createServer({ root, configFile: join(root, "vite.config.ts"), logLevel: "silent", server: { host: "127.0.0.1", port: 0, hmr: false, ws: false } });
  await vite.listen();
  const url = vite.resolvedUrls?.local[0];
  if (url === undefined) throw new Error("Vite の開発サーバーの URL を取れません");
  return { url, close: () => vite.close() };
}

export type MeetingFrames = {
  first: unknown[];
  reflected: unknown[];
};

export async function meetingFrames(): Promise<MeetingFrames> {
  const events = (await readFile(LOG_PATH, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
  const timeline = buildReviewTimeline(events);
  const times = timeline.reflectionTimes;
  const firstAt = times[times.length - 2];
  const lastAt = times[times.length - 1];
  if (firstAt === undefined || lastAt === undefined) throw new Error("題材のログに反映が 2 回以上ありません");
  const framesAt = (t: number): unknown[] => {
    const speakingOf = (track: "相手" | "自分"): string => {
      const latest = timeline.remarks.map((r) => r.remark).filter((r) => r.track === track && r.end <= t).reduce<(typeof timeline.remarks)[number]["remark"] | undefined>((best, r) => (!best || r.end >= best.end ? r : best), undefined);
      return latest && t - latest.end < CAPTION_SECONDS ? latest.text : "";
    };
    const speaking = { 相手: speakingOf("相手"), 自分: speakingOf("自分") };
    return [
      { type: "captions", bubbles: [...(speaking.相手 === "" ? [] : [spokenBubble(speaking.相手, "相手")]), ...(speaking.自分 === "" ? [] : [spokenBubble(speaking.自分, "自分")])] } satisfies CaptionsFrame,
      { type: "snapshot", snapshot: snapshotAt(timeline, t) } satisfies SnapshotFrame,
    ];
  };
  return { first: framesAt(firstAt), reflected: framesAt(lastAt) };
}

type WebSocketRoute = Parameters<Parameters<Page["routeWebSocket"]>[1]>[0];
type SocketHolder = { current: WebSocketRoute | undefined; connections: number };
const sockets = new WeakMap<Page, SocketHolder>();

export const connectionCount = (page: Page): number => sockets.get(page)?.connections ?? 0;
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
  frames: readonly unknown[];
};

export async function openMeetingPage(context: BrowserContext, server: MeetingServer, { frames }: OpenMeetingOptions): Promise<Page> {
  const page = await context.newPage();
  await connectFrames(page, frames);
  await page.goto(server.url);
  await page.locator(".map-node").first().waitFor({ timeout: 30_000 });
  return page;
}

export const readMeetingViewport = readFoldkitViewport;

export const waitForMeasuredNodes = (page: Page, count: number): Promise<unknown> =>
  page.waitForFunction(
    (expected) => {
      const nodes = [...document.querySelectorAll<HTMLElement>("[data-node-id]")];
      return nodes.length === expected && nodes.every((el) => el.style.visibility === "visible");
    },
    count,
    { timeout: 30_000 },
  );

export const NOTICE_FRAMES = {
  screen: { type: "screen-notice", text: "共有画面は使っていません（画面収録の許可がありません）" },
  tap: { type: "tap-notice", text: "相手の音声が届いていません（出力の機器を切り替えた後に起きることがあります）" },
} as const;
