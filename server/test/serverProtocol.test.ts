// Issue #1308: CLI と server の受け渡しを 1 つの共有モジュール（serverProtocol）にする。
//
// ここでは共有モジュールだけを直接見る（Schema の decode と経路の記述の値）。HTTP の往復は http.it / http.heavy が持つ。
//   - 本文の既定値の補完は本文の Schema の decode で 1 回だけ行う（audio・screen は true、vocab は空、realtime は false、title は無し）。
//     補うのは欄を省略したときだけで、null は受けない（手で組んだ本文は支えない。Issue #1471）。
//   - 経路は 17 本が { method, path, body?, response } の値として並ぶ。
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { ServerRoutes, SessionRecordedBody, SessionStartBody } from "../src/serverProtocol.ts";

const decodeStart = Schema.decodeUnknownSync(SessionStartBody);
const decodeRecorded = Schema.decodeUnknownSync(SessionRecordedBody);

describe("/session/start の本文の decode", () => {
  for (const key of ["title", "audio", "screen"]) {
    it(`${key} が null のとき、既定値に読み替えず、decode に失敗する`, () => {
      expect(() => decodeStart({ app: "us.zoom.xos", [key]: null })).toThrow();
    });
  }

  it("欄を省略したとき、audio と screen は true、vocab は空、title は無しになる", () => {
    expect(decodeStart({ app: "us.zoom.xos" })).toEqual({ app: "us.zoom.xos", audio: true, screen: true, vocab: [] });
  });

  it("指定した値は既定値で上書きしない（空の title・false・空白だけの app・vocab）", () => {
    expect(decodeStart({ app: " ", title: "", audio: false, screen: false, vocab: ["語"] })).toEqual({
      app: " ",
      title: "",
      audio: false,
      screen: false,
      vocab: ["語"],
    });
  });

  it("title に文字列を指定したとき、そのまま残る", () => {
    expect(decodeStart({ app: "us.zoom.xos", title: "週次" }).title).toBe("週次");
  });

  it("真偽値でない screen は既定値に読み替えず、decode に失敗する", () => {
    expect(() => decodeStart({ app: "us.zoom.xos", screen: "true" })).toThrow();
  });

  it("空の app は decode に失敗する", () => {
    expect(() => decodeStart({ app: "" })).toThrow();
  });
});

describe("/session/recorded の本文の decode", () => {
  it("file だけのとき、vocab は空、realtime は false で、title と selfFile は無しになる", () => {
    expect(decodeRecorded({ file: "/tmp/a.m4a" })).toEqual({ file: "/tmp/a.m4a", vocab: [], realtime: false });
  });

  it("title が null のとき、無しに読み替えず、decode に失敗する", () => {
    expect(() => decodeRecorded({ file: "/tmp/a.m4a", title: null })).toThrow();
  });

  it("指定した値は既定値で上書きしない（title・vocab・realtime・selfFile）", () => {
    expect(decodeRecorded({ file: "/tmp/a.m4a", selfFile: "/tmp/b.m4a", title: "", vocab: ["語"], realtime: true })).toEqual({
      file: "/tmp/a.m4a",
      selfFile: "/tmp/b.m4a",
      title: "",
      vocab: ["語"],
      realtime: true,
    });
  });

  it("judge は省略でき、あれば decode した値のまま持つ（鍵は持たず環境変数の名前だけ）", () => {
    const judge = { name: "clef", route: "system-one", apiKeyEnv: "CLOUDFLARE_API_TOKEN", accountIdEnv: "CLOUDFLARE_ACCOUNT_ID", model: "clef", timeoutMs: 2000 };
    expect(decodeRecorded({ file: "/tmp/a.m4a", judge })).toEqual({ file: "/tmp/a.m4a", vocab: [], realtime: false, judge });
    expect(decodeRecorded({ file: "/tmp/a.m4a" })).not.toHaveProperty("judge");
  });

  it("形が合わない judge は decode に失敗する", () => {
    expect(() => decodeRecorded({ file: "/tmp/a.m4a", judge: { name: "jev" } })).toThrow();
  });

  it("null の realtime は既定値に読み替えず、decode に失敗する", () => {
    expect(() => decodeRecorded({ file: "/tmp/a.m4a", realtime: null })).toThrow();
  });
});

describe("経路の記述", () => {
  const routes = Object.values(ServerRoutes);

  it("17 本の method と path が、今の server の経路と一致する", () => {
    expect(routes.map(({ method, path }) => `${method} ${path}`).sort()).toEqual(
      [
        "GET /apps",
        "POST /session/start",
        "POST /session/recorded",
        "POST /session/stop",
        "GET /session/status",
        "POST /session/resume",
        "POST /session/self-pause",
        "POST /session/speaker-name",
        "POST /share/open",
        "POST /share/close",
        "GET /share/status",
        "GET /server",
        "GET /check",
        "GET /deps/check",
        "POST /deps/install",
        "POST /update",
        "GET /ws",
      ].sort(),
    );
  });
});
