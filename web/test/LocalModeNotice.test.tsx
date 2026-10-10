import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocalModeNotice } from "../src/LocalModeNotice.tsx";

// order.md の表示契約。新しい部品の条件分岐を unit で確認し、実寸と absolute 配置は heavy IT で観測する。
describe("ローカルモードの表示", () => {
  it("local のときだけ線と指定の文字を描き、通常へ戻すと両方消える", () => {
    const shown = renderToStaticMarkup(<LocalModeNotice local={true} />);
    expect(shown).toContain("local-mode-line");
    expect(shown).toContain("ローカルモード・Apple Intelligence");
    expect(renderToStaticMarkup(<LocalModeNotice local={false} />)).toBe("");
  });
});
