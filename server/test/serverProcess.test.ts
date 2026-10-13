import { describe, expect, it } from "vitest";
import { planServerStop } from "../src/serverProcess.ts";

// 止める相手の決め方。シグナルを送るのは、ポートで応答したサーバーが名乗った PID だけ
describe("planServerStop", () => {
  it.each([
    { reported: 100, recorded: 100, recordedAlive: true, plan: { action: "terminate", pid: 100 } },
    // 記録が古くても（別の起動のもの・無い）、応答したサーバーの PID を使う
    { reported: 100, recorded: 200, recordedAlive: true, plan: { action: "terminate", pid: 100 } },
    { reported: 100, recorded: undefined, recordedAlive: false, plan: { action: "terminate", pid: 100 } },
    { reported: undefined, recorded: undefined, recordedAlive: false, plan: { action: "not-running", stale: undefined } },
    { reported: undefined, recorded: 200, recordedAlive: false, plan: { action: "not-running", stale: 200 } },
    // 応答が無いのに記録の PID が生きている: 使い回された別のプロセスかもしれないので送らない
    { reported: undefined, recorded: 200, recordedAlive: true, plan: { action: "unresponsive", pid: 200 } },
  ] as const)("応答 $reported・記録 $recorded（生存 $recordedAlive）→ $plan.action", ({ plan, ...input }) => {
    expect(planServerStop(input)).toEqual(plan);
  });
});
