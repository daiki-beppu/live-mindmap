// portOf（http.ts）: 待受けのアドレスからポートを読む。throw せず Effect を返し、TCP でないときは defect にする
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Result } from "effect";
import { NetAddress } from "effect/net";
import { portOf } from "../src/http.ts";

describe("portOf", () => {
  it.effect("TCP のアドレスなら、そのポートで成功する", () => Effect.gen(function* () {
    const address = NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 4321);
    expect(yield* portOf(address)).toBe(4321);
  }));

  it("UnixPathAddress でも throw せず、Effect を返す", () => {
    const address = NetAddress.unixPathAddress("/tmp/live-mindmap.sock");
    expect(() => portOf(address)).not.toThrow();
  });

  it.effect("UnixPathAddress は想定外の失敗（型付きの失敗ではなく defect）になる", () => Effect.gen(function* () {
    const address = NetAddress.unixPathAddress("/tmp/live-mindmap.sock");
    const exit = yield* Effect.exit(portOf(address));
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(Result.isFailure(Cause.findError(exit.cause))).toBe(true); // 型付きの失敗は無い
    expect(Cause.squash(exit.cause)).toMatchObject({ message: "TCP のポートで待ち受けていない" });
  }));
});
