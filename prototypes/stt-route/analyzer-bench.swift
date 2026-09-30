// PROTOTYPE — 使い捨て。issue #9「リアルタイム音声取得と STT の経路」の計測用。
// 音声ファイルを実時間のペースで SpeechAnalyzer に流し込み、確定結果ごとに
// 「音声の終わり → 結果が届くまで」の遅延を JSON Lines で出す。
//
//   swiftc -O analyzer-bench.swift -o /tmp/analyzer-bench
//   /tmp/analyzer-bench <audio> [--speed 1.0] [--volatile] > out.jsonl

import AVFoundation
import Foundation
import Speech

let args = CommandLine.arguments
guard args.count >= 2 else {
  FileHandle.standardError.write("usage: analyzer-bench <audio> [--speed N] [--volatile]\n".data(using: .utf8)!)
  exit(2)
}
let url = URL(fileURLWithPath: args[1])
let speed = args.firstIndex(of: "--speed").map { Double(args[$0 + 1])! } ?? 1.0
let wantVolatile = args.contains("--volatile")

func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }
func emit(_ obj: [String: Any]) {
  let d = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
  print(String(data: d, encoding: .utf8)!)
  fflush(stdout)
}

let locale = Locale(identifier: "ja-JP")
let supported = await SpeechTranscriber.supportedLocales
log("supported ja: \(supported.contains { $0.identifier(.bcp47) == "ja-JP" })")

let transcriber = SpeechTranscriber(
  locale: locale,
  transcriptionOptions: [],
  reportingOptions: wantVolatile ? [.volatileResults] : [],
  attributeOptions: [.audioTimeRange])

if let req = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
  log("downloading assets…")
  try await req.downloadAndInstall()
}

let analyzer = SpeechAnalyzer(modules: [transcriber])
guard let fmt = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
  log("no format"); exit(1)
}
log("analyzer format: \(fmt)")

let file = try AVAudioFile(forReading: url)
let src = file.processingFormat
let conv = AVAudioConverter(from: src, to: fmt)!

let (stream, cont) = AsyncStream<AnalyzerInput>.makeStream()
let t0 = Date()
func now() -> Double { Date().timeIntervalSince(t0) * speed }  // 音声時間に換算した経過

let reader = Task {
  var fed = 0.0  // 流し込んだ音声の秒数
  let chunk = AVAudioFrameCount(src.sampleRate * 0.1)  // 100ms ずつ
  while file.framePosition < file.length {
    let inBuf = AVAudioPCMBuffer(pcmFormat: src, frameCapacity: chunk)!
    try file.read(into: inBuf, frameCount: chunk)
    if inBuf.frameLength == 0 { break }
    let outCap = AVAudioFrameCount(Double(inBuf.frameLength) * fmt.sampleRate / src.sampleRate) + 64
    let outBuf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: outCap)!
    var given = false
    var err: NSError?
    conv.convert(to: outBuf, error: &err) { _, st in
      if given { st.pointee = .noDataNow; return nil }
      given = true; st.pointee = .haveData; return inBuf
    }
    fed += Double(inBuf.frameLength) / src.sampleRate
    // 実時間ペース: 音声時間 fed に壁時計が追いつくまで待つ
    let wait = fed - now()
    if wait > 0 { try await Task.sleep(for: .seconds(wait / speed)) }
    cont.yield(AnalyzerInput(buffer: outBuf))
  }
  cont.finish()
  log("fed \(fed)s")
}

let results = Task {
  for try await r in transcriber.results {
    let text = String(r.text.characters)
    let start = r.range.start.seconds
    let end = r.range.end.seconds
    emit([
      "final": r.isFinal,
      "start": start, "end": end,
      "arrived": now(),
      "lag": now() - end,
      "text": text,
    ])
  }
}

try await analyzer.start(inputSequence: stream)
try await reader.value
try await analyzer.finalizeAndFinishThroughEndOfInput()
try await results.value
log("done in \(Date().timeIntervalSince(t0))s wall")
