import { Effect } from "effect";
import { Playwright } from "../../server/src/playwright.ts";
import { managedPlaywright } from "../../server/test/fixtures/managedPlaywright.ts";

// 画面の照合（heavy IT の部品）。比べる 2 つのページそれぞれについて「開き方」と「ビューポートの値の読み方」を受け取り、
// 同じ操作を交互に流して、ステップごとにビューポート（x・y・zoom）・<audio> の実際の値・スクリーンショットを比べる。
// 画面ごとの DOM（React の .react-flow__viewport など）はここでは知らない。

export type Browser = Effect.Success<ReturnType<(typeof Playwright)["Service"]["launch"]>>;
export type Page = Awaited<ReturnType<Browser["newPage"]>>;

export type Viewport = { x: number; y: number; zoom: number };

export type Side = {
  name: string;
  // ページを開き、画面が使える状態（ノードが出て、<audio> が読み込めた状態）になるまで待って返す
  open: (browser: Browser) => Promise<Page>;
  // ビューポートの値を、transform の文字列ではなく数で読む
  viewport: (page: Page) => Promise<Viewport>;
};

export type Step = {
  name: string;
  // side は 0（左の Side）か 1（右の Side）。片方にだけ違う操作を流すテストで使う
  run: (page: Page, side: 0 | 1) => Promise<void>;
  // 再生中など、時刻が動き続ける間は true。<audio> は currentTime だけを比べず、ビューポートとスクリーンショットは比べない
  playing?: boolean;
};

export type AudioState = { paused: boolean; currentTime: number; playbackRate: number; muted: boolean; volume: number; duration: number };

export type StepResult = {
  name: string;
  viewports: [Viewport, Viewport];
  audio: [AudioState | null, AudioState | null];
  // 違うピクセルの割合（%）。撮らないステップは null
  differingPixelPercent: number | null;
};

export type CompareResult = { initial: StepResult; steps: StepResult[] };

// 違うピクセルの許容割合（%）
export const PIXEL_TOLERANCE_PERCENT = 0.05;

const SETTLE_POLL_MS = 50;
const SETTLE_STABLE_POLLS = 4;
const SETTLE_TIMEOUT_MS = 8_000;
const PLAYING_WAIT_MS = 400;

// 利用者と同じ管理ルートの Chromium で起動し、use の後に必ず閉じる
export async function withBrowser<T>(use: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Playwright).launch();
    }).pipe(Effect.provide(managedPlaywright), Effect.scoped),
  );
  try {
    return await use(browser);
  } finally {
    await browser.close();
  }
}

const readAudio = (page: Page): Promise<AudioState | null> =>
  page.evaluate(() => {
    const audio = document.querySelector("audio");
    if (audio === null) return null;
    const { paused, currentTime, playbackRate, muted, volume, duration } = audio;
    return { paused, currentTime, playbackRate, muted, volume, duration };
  });

// ビューポートと、ノードの位置が、続けて変わらなくなるまで待つ（補間の最中を撮らない）
async function settle(page: Page, side: Side, label: string): Promise<void> {
  const signature = async () =>
    JSON.stringify([
      await side.viewport(page),
      await page.evaluate(() => [...document.querySelectorAll(".map-node")].map((el) => {
        const r = el.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height];
      })),
    ]);
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let last = await signature();
  let stable = 0;
  while (stable < SETTLE_STABLE_POLLS) {
    if (Date.now() > deadline) throw new Error(`${label}: ${SETTLE_TIMEOUT_MS}ms 待っても画面が落ち着きません`);
    await page.waitForTimeout(SETTLE_POLL_MS);
    const now = await signature();
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
}

// 2 枚の PNG の、RGBA のどれかが違うピクセルの割合（%）。大きさが違えば 100
async function differingPercent(checker: Page, a: Buffer, b: Buffer): Promise<number> {
  return checker.evaluate(async ([left, right]) => {
    const decode = async (base64: string) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height);
    };
    const [x, y] = await Promise.all([decode(left!), decode(right!)]);
    if (x.width !== y.width || x.height !== y.height) return 100;
    let differing = 0;
    for (let i = 0; i < x.data.length; i += 4) {
      if (x.data[i] !== y.data[i] || x.data[i + 1] !== y.data[i + 1] || x.data[i + 2] !== y.data[i + 2] || x.data[i + 3] !== y.data[i + 3]) differing++;
    }
    return (differing / (x.width * x.height)) * 100;
  }, [a.toString("base64"), b.toString("base64")] as const);
}

// 左右のページを開き、最初の状態と各ステップの後を比べる。違いがあれば、全ステップを流した後に、ステップ名と種別を並べた Error を投げる
export async function compareScreens(browser: Browser, sides: readonly [Side, Side], steps: readonly Step[]): Promise<CompareResult> {
  const pages = [await sides[0].open(browser), await sides[1].open(browser)] as const;
  const checker = await browser.newPage();
  const mismatches: string[] = [];
  try {
    const observe = async (name: string, playing: boolean): Promise<StepResult> => {
      const read = async (i: 0 | 1) => {
        const page = pages[i];
        if (playing) await page.waitForTimeout(PLAYING_WAIT_MS);
        else await settle(page, sides[i], `${sides[i].name} / ${name}`);
        return { viewport: await sides[i].viewport(page), audio: await readAudio(page) };
      };
      const left = await read(0);
      const right = await read(1);
      const result: StepResult = {
        name,
        viewports: [left.viewport, right.viewport],
        audio: [left.audio, right.audio],
        differingPixelPercent: null,
      };
      const key = (v: Viewport) => `x=${v.x}, y=${v.y}, zoom=${v.zoom}`;
      // 再生中は、カメラが時刻に追従して動き続けるので、ビューポートも比べない
      if (!playing && key(left.viewport) !== key(right.viewport)) {
        mismatches.push(`[${name}] ビューポートが違います: ${sides[0].name} ${key(left.viewport)} / ${sides[1].name} ${key(right.viewport)}`);
      }
      const fields = playing ? (["paused", "playbackRate", "muted", "volume"] as const) : (["paused", "currentTime", "playbackRate", "muted", "volume"] as const);
      for (const field of fields) {
        if (left.audio?.[field] !== right.audio?.[field]) {
          mismatches.push(`[${name}] <audio> の ${field} が違います: ${sides[0].name} ${left.audio?.[field]} / ${sides[1].name} ${right.audio?.[field]}`);
        }
      }
      if (!playing) {
        const shot = (page: Page) => page.screenshot({ animations: "disabled", caret: "hide" });
        const percent = await differingPercent(checker, await shot(pages[0]), await shot(pages[1]));
        result.differingPixelPercent = percent;
        if (percent > PIXEL_TOLERANCE_PERCENT) {
          mismatches.push(`[${name}] スクリーンショットが違います: 違うピクセル ${percent.toFixed(3)}%（許容 ${PIXEL_TOLERANCE_PERCENT}%）`);
        }
      }
      return result;
    };

    const initial = await observe("開いた直後", false);
    const results: StepResult[] = [];
    for (const step of steps) {
      await step.run(pages[0], 0);
      await step.run(pages[1], 1);
      results.push(await observe(step.name, step.playing === true));
    }
    if (mismatches.length > 0) throw new Error(`画面が一致しません（${mismatches.length} 件）:\n${mismatches.join("\n")}`);
    return { initial, steps: results };
  } finally {
    await checker.close();
    await Promise.all(pages.map((page) => page.context().close()));
  }
}
