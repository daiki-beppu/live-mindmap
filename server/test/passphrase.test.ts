import { describe, expect, it, vi } from "vitest";
import { generatePassphrase, openSealed, sealWithPassphrase } from "../src/core/index.ts";

// 合言葉の生成と、暗号化・復号（Issue #1251）。往復、認証つき暗号であること、時間のかかる鍵の導出であること。鍵の導出は 1 回に数百 ms かかるので、暗号化・復号の回数は絞る

const SECRET = "ここは外に出してはいけない発言 <title>罠</title>";
const decode = (value: string) => Buffer.from(value, "base64");

describe("generatePassphrase", () => {
  it("5 文字ずつ - でつないだ 4 組（20 文字）の小文字と数字で、Discord の markdown に解釈される記号と空白を含まない", () => {
    for (let i = 0; i < 200; i++) {
      const passphrase = generatePassphrase();
      expect(passphrase).toMatch(/^[a-z0-9]{5}(-[a-z0-9]{5}){3}$/);
      expect(passphrase).not.toMatch(/[\s*_~|`>]/);
    }
  });

  it("使う文字は 32 種類ちょうど（剰余の偏りが出ず、短い文字集合でもない）で、何度呼んでも重ならない", () => {
    const seen = new Set<string>();
    const all = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const passphrase = generatePassphrase();
      all.add(passphrase);
      for (const char of passphrase.replaceAll("-", "")) seen.add(char);
    }
    expect(seen.size).toBe(32);
    expect(all.size).toBe(2000);
  });
});

describe("sealWithPassphrase / openSealed", () => {
  it("同じ合言葉で元に戻り、違う合言葉（1 文字違い・大文字小文字違い・空）では失敗する", async () => {
    const passphrase = generatePassphrase();
    const sealed = await sealWithPassphrase(SECRET, passphrase);

    expect(await openSealed(sealed, passphrase)).toBe(SECRET);
    const oneOff = `${passphrase.slice(0, -1)}${passphrase.endsWith("a") ? "b" : "a"}`;
    await expect(openSealed(sealed, oneOff)).rejects.toThrow();
    await expect(openSealed(sealed, passphrase.toUpperCase())).rejects.toThrow();
    await expect(openSealed(sealed, "")).rejects.toThrow();
  });

  it("暗号文を 1 バイト変えると失敗し（認証つき）、salt や iv を変えても失敗する", async () => {
    const passphrase = generatePassphrase();
    const sealed = await sealWithPassphrase(SECRET, passphrase);
    const flip = (value: string, at: number) => {
      const bytes = decode(value);
      bytes[at] = bytes[at]! ^ 0x01;
      return bytes.toString("base64");
    };

    await expect(openSealed({ ...sealed, data: flip(sealed.data, 0) }, passphrase)).rejects.toThrow();
    await expect(openSealed({ ...sealed, data: flip(sealed.data, decode(sealed.data).length - 1) }, passphrase)).rejects.toThrow();
    await expect(openSealed({ ...sealed, iv: flip(sealed.iv, 0) }, passphrase)).rejects.toThrow();
    await expect(openSealed({ ...sealed, salt: flip(sealed.salt, 0) }, passphrase)).rejects.toThrow();
  });

  it("salt は 16 バイト・iv は 12 バイトで、2 回暗号化すると salt も iv も暗号文も異なる", async () => {
    const passphrase = generatePassphrase();
    const a = await sealWithPassphrase(SECRET, passphrase);
    const b = await sealWithPassphrase(SECRET, passphrase);

    expect(decode(a.salt)).toHaveLength(16);
    expect(decode(a.iv)).toHaveLength(12);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it("暗号文の大きさは平文のバイト数 + 16（GCM の認証タグ）で、平文の文字列は暗号文に現れない（CBC・CTR などの別の方式でない）", async () => {
    const plain = "a".repeat(20);
    const sealed = await sealWithPassphrase(plain, generatePassphrase());

    expect(decode(sealed.data)).toHaveLength(20 + 16);
    expect(JSON.stringify(sealed)).not.toContain(plain);
  });

  it("日本語・改行・</script> を含む大きな入力（約 3 MB）でも往復できる", async () => {
    const big = `<!doctype html>\n${"あ".repeat(1_000_000)}</script>\n`;
    const passphrase = generatePassphrase();

    const restored = await openSealed(await sealWithPassphrase(big, passphrase), passphrase);

    expect(restored === big).toBe(true);
  }, 60_000);

  it("鍵の導出は PBKDF2-SHA256 を 60 万回以上、暗号は AES-256-GCM（時間のかかる導出と認証つき暗号）", async () => {
    const derive = vi.spyOn(crypto.subtle, "deriveKey");
    const bits = vi.spyOn(crypto.subtle, "deriveBits");
    const encrypt = vi.spyOn(crypto.subtle, "encrypt");
    try {
      await sealWithPassphrase(SECRET, generatePassphrase());

      const params = [...derive.mock.calls.map((c) => ({ algorithm: c[0] as Pbkdf2Params, target: c[2] as AesKeyGenParams })), ...bits.mock.calls.map((c) => ({ algorithm: c[0] as Pbkdf2Params, target: undefined }))];
      expect(params).toHaveLength(1);
      expect(params[0]!.algorithm.name).toBe("PBKDF2");
      expect(params[0]!.algorithm.hash).toBe("SHA-256");
      expect(params[0]!.algorithm.iterations).toBeGreaterThanOrEqual(600_000);
      if (params[0]!.target !== undefined) {
        expect(params[0]!.target.name).toBe("AES-GCM");
        expect(params[0]!.target.length).toBe(256);
      }
      expect(encrypt).toHaveBeenCalledTimes(1);
      expect((encrypt.mock.calls[0]![0] as { name: string }).name).toBe("AES-GCM");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
