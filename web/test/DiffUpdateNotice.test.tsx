import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiffUpdateNotice } from "../src/DiffUpdateNotice.tsx";

describe("差分更新の一時停止通知", () => {
  it("一時停止の理由を指定文で表示する", () => {
    expect(renderToStaticMarkup(<DiffUpdateNotice state={{ status: "paused", reason: "ChatGPT の利用上限" }} />)).toContain("マップの更新が止まっています（ChatGPT の利用上限）");
  });
  it.each([null, { status: "running" }, { status: "restarting" }, { status: "stopped" }] as const)("一時停止以外では表示しない: %j", (state) => {
    expect(renderToStaticMarkup(<DiffUpdateNotice state={state} />)).toBe("");
  });
});
