import { vi } from "vitest";

const SLOW_CI_WAIT_FOR_TIMEOUT_MS = 5_000;

// unit はファイルごとにこのファイルを評価し直し、共有の vi を包み重ねる。評価ごとに別物にならない印が要るので Symbol.for を使う
const WRAPPED = Symbol.for("live-mindmap/waitForWrapped");

if (!(WRAPPED in vi.waitFor)) {
  const waitFor = vi.waitFor;
  vi.waitFor = Object.assign(
    ((callback, options) =>
      waitFor(callback, typeof options === "number" ? options : { timeout: SLOW_CI_WAIT_FOR_TIMEOUT_MS, ...options })) as typeof vi.waitFor,
    { [WRAPPED]: true },
  );
}
