// helper の `swift test` が層（unit・軽い IT・重い IT）をどう選ぶかを、結果で確かめるための共有の補助。
// helperScripts.it.test.ts（package.json の scripts）と checkWorkflow.it.test.ts（check.yml の helper ジョブ）が使う。

// テスト ID は `<ターゲット>.<型名>/<関数名>()`。層は型名の接尾辞で決まる
export const testIds = {
  unit: ["HelperCoreTests.StreamSplitTests/split()", "SttBenchTests.SynthTimelineTests/build()"],
  it: ["HelperCoreTests.RelayITTests/relay()", "SttBenchTests.BuildMicrophoneITTests/build()"],
  heavy: [
    "HelperCoreTests.EchoCancellerHeavyTests/cancel()",
    "HelperCoreTests.SpeechAnalyzerTranscriberHeavyTests/transcribe()",
  ],
};

// swift test のコマンドから --skip / --filter を 1 つだけ取り出し、テスト ID が実行されるかを返す述語にする
export const selectionOf = (command: string): ((id: string) => boolean) => {
  const options = [...command.matchAll(/--(skip|filter)\s+(?:'([^']*)'|"([^"]*)"|(\S+))/g)];
  if (options.length !== 1) {
    throw new Error(`${command}: --skip / --filter はちょうど 1 回必要だが ${options.length} 回ある`);
  }
  const [, kind, single, double, bare] = options[0]!;
  const pattern = new RegExp(single ?? double ?? bare!);
  return kind === "skip" ? (id) => !pattern.test(id) : (id) => pattern.test(id);
};
