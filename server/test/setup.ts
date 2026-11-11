import { vi } from "vitest";

const SLOW_CI_WAIT_FOR_TIMEOUT_MS = 5_000;

const WRAPPED = Symbol.for("live-mindmap/waitForWrapped");

if (!(WRAPPED in vi.waitFor)) {
  const waitFor = vi.waitFor;
  vi.waitFor = Object.assign(
    ((callback, options) =>
      waitFor(callback, typeof options === "number" ? options : { timeout: SLOW_CI_WAIT_FOR_TIMEOUT_MS, ...options })) as typeof vi.waitFor,
    { [WRAPPED]: true },
  );
}
