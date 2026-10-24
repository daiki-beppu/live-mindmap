import { vi } from "vitest";

const waitFor = vi.waitFor;
vi.waitFor = ((callback, options) =>
  waitFor(callback, typeof options === "number" ? options : { timeout: 5_000, ...options })) as typeof vi.waitFor;
