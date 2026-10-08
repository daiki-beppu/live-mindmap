import { Runtime } from "effect";

// 終了コードは process.exitCode に置き、イベントループが空になって自然に終わるのを待つ（runMain の既定は失敗で process.exit を呼ぶ）。
// Why: 起動直後に process.exit すると、V8 の裏のコンパイルが GC を待ったまま Node の終了処理がそのスレッドの join で止まり、
// プロセスが終わらないことがある（負荷の高い CI で eval の失敗が 10 秒を超えて残った）。成功時の runMain と同じ終わり方にそろえる。
// 入口（server.ts・cli.ts）が共有する
export const exitNaturally: Runtime.Teardown = (exit) =>
  Runtime.defaultTeardown(exit, (code) => {
    process.exitCode = code;
  });
