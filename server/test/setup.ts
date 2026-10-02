import { vi } from "vitest";

// vi.waitFor の既定の待ち（1 秒）は、CI のランナーでは偽のヘルパーの起動と反映に足りない。
// 待つ時間を指定していない呼び出しだけ、5 秒まで待つ（間に合えばすぐ抜けるので、手元の速さは変わらない）
const waitFor = vi.waitFor;
vi.waitFor = ((callback, options) =>
  waitFor(callback, typeof options === "number" ? options : { timeout: 5_000, ...options })) as typeof vi.waitFor;
