import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ViewingNotice } from "../src/ViewingNotice.tsx";

describe("ViewingNotice: 動かしている間だけ左下に出る文字", () => {
  it("止まっている（manual）ときは、文字と viewing-notice の class が出る", () => {
    const html = renderToStaticMarkup(<ViewingNotice manual={true} />);
    expect(html).toContain("viewing-notice");
    expect(html).toMatch(/<p class="viewing-notice">[^<]*\S[^<]*<\/p>/);
  });

  it("自動のときは何も出ない", () => {
    expect(renderToStaticMarkup(<ViewingNotice manual={false} />)).toBe("");
  });

  it("全体を見ている（overview）ときも、F か Esc で戻れることを示す文字が出る", () => {
    const html = renderToStaticMarkup(<ViewingNotice manual={false} overview={true} />);
    expect(html).toMatch(/<p class="viewing-notice">[^<]*\S[^<]*<\/p>/);
    expect(html).toContain("全体");
    expect(html).toContain("F");
    expect(html).toContain("Esc");
  });

  it("manual でも overview でもなければ何も出ない", () => {
    expect(renderToStaticMarkup(<ViewingNotice manual={false} overview={false} />)).toBe("");
  });

  it("残り秒数やバッジは出さない", () => {
    const html = renderToStaticMarkup(<ViewingNotice manual={true} />);
    expect(html).not.toMatch(/\d+\s*秒/);
    expect(html).not.toContain("badge");
  });
});
