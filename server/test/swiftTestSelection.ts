export const testIds = {
  unit: ["HelperCoreTests.StreamSplitTests/split()", "SttBenchTests.SynthTimelineTests/build()"],
  it: ["HelperCoreTests.RelayITTests/relay()", "SttBenchTests.BuildMicrophoneITTests/build()"],
  heavy: [
    "HelperCoreTests.EchoCancellerHeavyTests/cancel()",
    "HelperCoreTests.SpeechAnalyzerTranscriberHeavyTests/transcribe()",
  ],
};

export const selectionOf = (command: string): ((id: string) => boolean) => {
  const options = [...command.matchAll(/--(skip|filter)\s+(?:'([^']*)'|"([^"]*)"|(\S+))/g)];
  if (options.length !== 1) {
    throw new Error(`${command}: --skip / --filter はちょうど 1 回必要だが ${options.length} 回ある`);
  }
  const [, kind, single, double, bare] = options[0]!;
  const pattern = new RegExp(single ?? double ?? bare!);
  return kind === "skip" ? (id) => !pattern.test(id) : (id) => pattern.test(id);
};
