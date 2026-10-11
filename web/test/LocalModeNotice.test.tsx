import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocalModeNotice } from "../src/LocalModeNotice.tsx";
import type { DiffUpdateState } from "../../server/src/core/index.ts";

// order.md の表示契約。新しい部品の条件分岐を unit で確認し、実寸と absolute 配置は heavy IT で観測する。
describe("ローカルモードの表示", () => {
  it("local のときだけ線と指定の文字を描き、通常へ戻すと両方消える", () => {
    const shown = renderToStaticMarkup(<LocalModeNotice local={true} />);
    const notice = shown.match(/<div\b[^>]*\brole="status"[^>]*>([^<]*)<\/div>/);
    expect(notice?.[1]).toBe("ローカルモード・Apple Intelligence");
    expect(renderToStaticMarkup(<LocalModeNotice local={false} />)).toBe("");
  });

  it.each([
    [null, "ローカルモード・Apple Intelligence"],
    [{ status: "running" }, "ローカルモード・Apple Intelligence"],
    [{ status: "restarting" }, "ローカルモード・Apple Intelligence・マップの更新を再開しています"],
    [{ status: "stopped" }, "ローカルモード・Apple Intelligence・マップの更新が止まっています"],
  ] satisfies [DiffUpdateState | null, string][])("状態 %j の指定文言を通知領域に描き、local=falseでは表示しない", (diffUpdate, text) => {
    const props = { local: true, diffUpdate };
    const shown = renderToStaticMarkup(<LocalModeNotice {...props} />);
    const notice = shown.match(/<div\b[^>]*\brole="status"[^>]*>([^<]*)<\/div>/);
    expect(notice?.[1]).toBe(text);
    expect(renderToStaticMarkup(<LocalModeNotice {...props} local={false} />)).toBe("");
  });
});
