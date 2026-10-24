import { vi } from "vitest";

const SLOW_CI_WAIT_FOR_TIMEOUT_MS = 5_000;

const waitFor = vi.waitFor;
vi.waitFor = ((callback, options) =>
  waitFor(callback, typeof options === "number" ? options : { timeout: SLOW_CI_WAIT_FOR_TIMEOUT_MS, ...options })) as typeof vi.waitFor;
