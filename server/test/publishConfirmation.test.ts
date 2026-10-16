import { describe, expect, it } from "vitest";
import { PUBLISH_CONTENTS, publishConfirmationMessage } from "../src/core/index.ts";

// 発言の文字・録音を含む公開で止まったときの、エージェント向けの文（Issue #1252）
const BASE = ["閉じた会議", "相手の了解", "イベント", "規約", "登壇者の許可", "--confirmed", "実行し直"];
const VOICE = "声は話し手を特定できれば個人情報にもなる";
const PUBLIC = "URL を知る誰でも見られる";
const PUBLIC_SEND = "公衆への送信";

describe("PUBLISH_CONTENTS", () => {
  it("段は map・remarks・audio の 3 つ（積み上げの順）", () => {
    expect([...PUBLISH_CONTENTS]).toEqual(["map", "remarks", "audio"]);
  });
});

describe("publishConfirmationMessage", () => {
  it("remarks（--anyone なし）は基本の文だけ。声の文も公衆への送信の文も無い", () => {
    const message = publishConfirmationMessage({ content: "remarks", anyone: false });
    for (const part of BASE) expect(message).toContain(part);
    expect(message).not.toContain(VOICE);
    expect(message).not.toContain(PUBLIC);
    expect(message).not.toContain(PUBLIC_SEND);
  });

  it("audio（--anyone なし）は基本の文に声の文が加わる。公衆への送信の文は無い", () => {
    const message = publishConfirmationMessage({ content: "audio", anyone: false });
    for (const part of BASE) expect(message).toContain(part);
    expect(message).toContain(VOICE);
    expect(message).not.toContain(PUBLIC);
    expect(message).not.toContain(PUBLIC_SEND);
  });

  it("remarks と --anyone は基本の文に公衆への送信の文が加わる。声の文は無い", () => {
    const message = publishConfirmationMessage({ content: "remarks", anyone: true });
    for (const part of BASE) expect(message).toContain(part);
    expect(message).toContain(PUBLIC);
    expect(message).toContain(PUBLIC_SEND);
    expect(message).not.toContain(VOICE);
  });

  it("audio と --anyone は両方の文が加わる", () => {
    const message = publishConfirmationMessage({ content: "audio", anyone: true });
    for (const part of BASE) expect(message).toContain(part);
    expect(message).toContain(VOICE);
    expect(message).toContain(PUBLIC);
    expect(message).toContain(PUBLIC_SEND);
  });

  it("複数行で、足す文は基本の文とは別の行になる（1 行に潰さない）", () => {
    const lines = publishConfirmationMessage({ content: "audio", anyone: true }).split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.filter((l) => l.includes(VOICE))).toHaveLength(1);
    expect(lines.filter((l) => l.includes(PUBLIC))).toHaveLength(1);
    expect(lines.find((l) => l.includes(VOICE))).not.toContain(PUBLIC);
  });
});
