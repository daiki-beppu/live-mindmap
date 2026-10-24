import { describe, expect, it } from "vitest";
import { lockedPublishPage, sealWithPassphrase } from "../src/core/index.ts";
import type { Sealed } from "../src/core/passphrase.ts";

// 合言葉つきの外側のページに埋める暗号文（Issue #1477）。base64 の暗号文はそのまま埋め、中身が何でも <script> を閉じない

const embedded = (page: string): string => {
  const match = /<script type="application\/json" id="[^"]+">([\s\S]*?)<\/script>/.exec(page);
  if (match === null) throw new Error("暗号文を埋めた <script> がありません");
  return match[1]!;
};

describe("lockedPublishPage", () => {
  it("実際の暗号文は JSON.stringify のまま 1 バイトも変えずに埋める", async () => {
    const sealed = await sealWithPassphrase("<title>罠</title></script>", "abcde-fghij-kmnpq-rstuv");
    expect(embedded(lockedPublishPage(sealed))).toBe(JSON.stringify(sealed));
  });

  it("< や </script> を含む値でも、埋めた JSON に生の < が出ず、JSON.parse で元の値に戻る", () => {
    const sealed: Sealed = { salt: "</script><script>alert(1)</script>", iv: "<!--", data: "a<b" };
    const json = embedded(lockedPublishPage(sealed));
    expect(json).not.toContain("<");
    expect(JSON.parse(json)).toEqual(sealed);
  });
});
