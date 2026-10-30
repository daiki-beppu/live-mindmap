import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { embedReviewLog, type Snapshot, type SnapshotNode } from "../../server/src/core/index.ts";
import { buildReviewTemplateHtml } from "../../server/test/fixtures/reviewTemplate.ts";
import { launchBrowser, withContext, type Browser, type Page } from "./browser.ts";
import { closeSocket, connectionCount, openMeetingPage, sendFrame, startMeetingServer, waitForMeasuredNodes, type MeetingServer } from "./meetingPage.ts";
import { near, openReviewPage, PAGE_VIEWPORT, readFoldkitViewport, settled, styleOf, TIMEOUT } from "./reviewPage.ts";

let browser: Browser;
let server: MeetingServer;
let directory: string;
let reviewPath: string;

beforeAll(async () => {
  server = await startMeetingServer();
  directory = await mkdtemp(join(tmpdir(), "live-mindmap-digression-"));
  reviewPath = join(directory, "map.html");
  const events: unknown[] = [{ type: "start", title: "採用を決める" }];
  for (const round of [1, 2, 3]) {
    events.push(
      { type: "remark", remark: { id: `r${round}`, track: "相手", start: round - 1, end: round, text: "会議の発言" } },
      { type: "diff", input: { recent: [], fresh: [`r${round}`], nodeCount: round === 1 ? 0 : 1 }, ops: round === 1
        ? [{ op: "add", ref: "旅行", parent: "root", kind: "議題", text: "旅行", evidence: ["r1"] }]
        : [{ op: "update", node: "n1", evidence: [`r${round}`], digression: round === 2 }], dropped: [] },
    );
  }
  await writeFile(reviewPath, embedReviewLog(await buildReviewTemplateHtml(), events));
  browser = await launchBrowser();
}, TIMEOUT);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
});

type Display = "通常" | "畳んだ議題" | "複数議題のまとめ";
const snapshot = (display: Display, marked: boolean, round: number): Snapshot => {
  const topic: SnapshotNode = {
    id: "n1", parent: "root", kind: "議題", text: "旅行", evidence: Array.from({ length: round }, (_, i) => `r${i + 1}`), evidenceRound: round, touchedAt: 1,
    ...(display === "通常" ? {} : { talkStatus: "済み" as const }),
    ...(marked ? { digression: true } : {}),
  };
  return {
    nodes: [
      { id: "root", parent: null, kind: "会議", text: "採用を決める", evidence: [] },
      topic,
      { id: "n2", parent: "n1", kind: "要点", text: "行き先", evidence: ["r1"] },
      ...(display === "複数議題のまとめ" ? [{ id: "n3", parent: "root", kind: "議題" as const, text: "趣味", evidence: ["r1"], talkStatus: "済み" as const }] : []),
      { id: "n5", parent: "root", kind: "議題", text: "採用人数", evidence: ["r1"] },
    ], round, currentTopic: "n5", now: 10, remarks: [],
    changes: [
      { change: "更新", node: "n5", kind: "議題", text: "採用人数", round: 1, at: 1 },
      ...Array.from({ length: round - 1 }, (_, i) => ({ change: "更新" as const, node: "n1", kind: "議題" as const, text: "旅行", round: i + 2, at: i + 2 })),
    ],
  };
};

const selectorOf = (id: string) => `[data-node-id="${id}"] .map-node`;
const waitForBorder = (page: Page, id: string, border: string) => expect.poll(
  () => page.locator(selectorOf(id)).evaluate((element) => getComputedStyle(element).borderTopStyle),
  { timeout: 5_000, message: `議題 ${id} の枠が ${border} になる` },
).toBe(border);
const geometry = (page: Page) => page.locator("[data-node-id]").evaluateAll((elements) => elements.map((element) => {
  const r = element.getBoundingClientRect();
  return { id: element.getAttribute("data-node-id"), x: r.x, y: r.y, width: r.width, height: r.height };
}));

function expectDescription(description: string | null, marked: boolean, bundled: boolean): void {
  if (!marked) { expect(description).toBeNull(); return; }
  expect(description).toContain("脱線");
  if (bundled) expect(description).toContain("含む");
}

const receipt = { type: "screen-notice", text: "再送した Snapshot の後続フレーム" };
async function waitForReceipt(page: Page): Promise<void> {
  await page.getByText(receipt.text, { exact: true }).waitFor();
  await sendFrame(page, { type: "screen-notice", text: null });
  await page.getByText(receipt.text, { exact: true }).waitFor({ state: "detached" });
  await settled(page);
}

async function resend(page: Page, value: Snapshot): Promise<void> {
  await sendFrame(page, { type: "snapshot", snapshot: value });
  await sendFrame(page, receipt);
  await waitForReceipt(page);
}

async function expectGeometry(page: Page, before: Awaited<ReturnType<typeof geometry>>): Promise<void> {
  const after = await geometry(page);
  expect(after.map((n) => n.id)).toEqual(before.map((n) => n.id));
  for (const previous of before) {
    const current = after.find((n) => n.id === previous.id)!;
    for (const key of ["x", "y", "width", "height"] as const) near(current[key], previous[key], `${previous.id} ${key}`);
  }
}

describe("脱線の描画と連続更新", () => {
  it.each<Display>(["通常", "畳んだ議題", "複数議題のまとめ"])("会議中の同じ画面で付与・解除しても色・本文・位置・寸法を保つ（%s）", (display) =>
    withContext(browser, { viewport: PAGE_VIEWPORT }, async (context) => {
      const frames: unknown[] = [{ type: "snapshot", snapshot: snapshot(display, false, 1) }];
      const page = await openMeetingPage(context, server, { frames });
      const id = display === "複数議題のまとめ" ? "run:n1" : "n1";
      const selector = selectorOf(id);
      await waitForMeasuredNodes(page, display === "通常" ? 4 : 3);
      await page.keyboard.press("f");
      await page.keyboard.press("f");
      await page.getByText("変わったところを見ています", { exact: false }).waitFor();
      await settled(page);
      const before = await geometry(page);
      const viewport = await readFoldkitViewport(page);
      const text = await page.locator(selector).textContent();
      const original = await styleOf(page, selector, ["border-top-color", "border-top-width", "opacity", "--kind-color"]);
      const button = page.locator(`${selector} .map-node__button`);
      expect(await button.getAttribute("aria-description")).toBeNull();
      const pressed = await button.getAttribute("aria-pressed");
      for (const [marked, round] of [[true, 2], [false, 3]] as const) {
        const next = snapshot(display, marked, round);
        frames[0] = { type: "snapshot", snapshot: next };
        frames[1] = receipt;
        await sendFrame(page, frames[0]);
        await waitForBorder(page, id, marked ? "dashed" : "solid");
        await settled(page);
        expect(await readFoldkitViewport(page)).toEqual(viewport);
        expectDescription(await button.getAttribute("aria-description"), marked, display === "複数議題のまとめ");
        expect(await button.getAttribute("aria-pressed")).toBe(pressed);
        expect(await page.locator(".changes__item").count()).toBe(round);
        expect(await page.locator(selector).evaluate((el) => el.classList.contains("map-node--blink"))).toBe(true);
        const actual = await styleOf(page, selector, ["border-top-color", "border-top-width", "opacity", "--kind-color", "animation-name", "animation-iteration-count"]);
        expect(actual["--kind-color"]).toBe(original["--kind-color"]);
        expect(actual["border-top-color"]).toBe(original["border-top-color"]);
        expect(actual["border-top-width"]).toBe(original["border-top-width"]);
        if (marked) {
          expect(Number(actual.opacity)).toBeGreaterThan(0);
          expect(Number(actual.opacity)).toBeLessThan(Number(original.opacity));
        } else expect(actual.opacity).toBe(original.opacity);
        expect(actual["animation-name"].split(", ").every((name) => name === "none" || name === "map-node-blink")).toBe(true);
        expect(actual["animation-iteration-count"]).not.toContain("infinite");
        expect(await page.locator(selector).textContent()).toBe(text);
        await expectGeometry(page, before);
        await resend(page, next);
        expect(await readFoldkitViewport(page)).toEqual(viewport);
        await expectGeometry(page, before);
        const connections = connectionCount(page);
        await closeSocket(page);
        await expect.poll(() => connectionCount(page), { timeout: 15_000 }).toBe(connections + 1);
        await waitForReceipt(page);
        expect(await readFoldkitViewport(page)).toEqual(viewport);
        await expectGeometry(page, before);
        await waitForBorder(page, id, marked ? "dashed" : "solid");
        expectDescription(await button.getAttribute("aria-description"), marked, display === "複数議題のまとめ");
        expect(await button.getAttribute("aria-pressed")).toBe(pressed);
        expect(await page.locator(".changes__item").count()).toBe(round);
      }
    }), TIMEOUT);

  it.each([false, true])("本文も変わる反映では差分の寄せ先を更新する（再接続後: %s）", (afterReconnect) =>
    withContext(browser, { viewport: PAGE_VIEWPORT }, async (context) => {
      const frames: unknown[] = [{ type: "snapshot", snapshot: snapshot("通常", false, 1) }];
      const page = await openMeetingPage(context, server, { frames });
      await waitForMeasuredNodes(page, 4);
      await page.keyboard.press("f");
      await page.keyboard.press("f");
      await page.getByText("変わったところを見ています", { exact: false }).waitFor();
      await settled(page);
      const before = await readFoldkitViewport(page);
      const next = snapshot("通常", true, 2);
      if (afterReconnect) {
        await resend(page, next);
        await resend(page, next);
        frames[0] = { type: "snapshot", snapshot: next };
        frames[1] = receipt;
        const connections = connectionCount(page);
        await closeSocket(page);
        await expect.poll(() => connectionCount(page), { timeout: 15_000 }).toBe(connections + 1);
        await waitForReceipt(page);
        expect(await readFoldkitViewport(page)).toEqual(before);
      }
      next.nodes = next.nodes.map((n) => n.id === "n1" ? { ...n, text: "研修先の検討" } : n);
      await sendFrame(page, { type: "snapshot", snapshot: next });
      await page.getByRole("button", { name: "研修先の検討", exact: true }).waitFor();
      await waitForBorder(page, "n1", "dashed");
      await settled(page);
      expect(await readFoldkitViewport(page)).not.toEqual(before);
    }), TIMEOUT);

  it("同じ map.html で反映を前後すると、その時点の脱線表示へ戻る", () =>
    withContext(browser, { viewport: PAGE_VIEWPORT }, async (context) => {
      const page = await openReviewPage(context, reviewPath, { audio: false });
      const selector = selectorOf("n1");
      await waitForBorder(page, "n1", "solid");
      const button = page.locator(`${selector} .map-node__button`);
      expect(await button.getAttribute("aria-description")).toBeNull();
      const original = await styleOf(page, selector, ["--kind-color", "opacity"]);
      for (const [key, border] of [[",", "dashed"], [",", "solid"], [".", "dashed"], [".", "solid"]] as const) {
        await page.keyboard.press(key);
        await waitForBorder(page, "n1", border);
        expectDescription(await button.getAttribute("aria-description"), border === "dashed", false);
        const actual = await styleOf(page, selector, ["--kind-color", "opacity"]);
        expect(actual["--kind-color"]).toBe(original["--kind-color"]);
        if (border === "dashed") expect(Number(actual.opacity)).toBeLessThan(Number(original.opacity));
        else expect(actual.opacity).toBe(original.opacity);
      }
    }), TIMEOUT);
});
