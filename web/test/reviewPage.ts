import { expect } from "vitest";
export { TIMEOUT, PAGE_VIEWPORT, prepareReviewPages, openReviewPage, readFoldkitViewport, settled, mapPoint, styleOf, rectOf, type ReviewPages } from "./reviewBrowser.ts";
export const near = (actual: number, expected: number, label: string) => expect(Math.abs(actual - expected), `${label}: ${actual} / ${expected}`).toBeLessThanOrEqual(1);
