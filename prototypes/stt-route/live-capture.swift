// PROTOTYPE — 使い捨て。issue #9「リアルタイム音声取得と STT の経路」の実地確認用。
// 相手の声 = システム音声（Core Audio のプロセスタップ）、自分の声 = マイク を別トラックで取り、
// それぞれ SpeechAnalyzer（ja-JP・端末内）に流して、確定結果を JSON Lines で stdout に出す。
//
//   swiftc -O -swift-version 5 live-capture.swift -o /tmp/live-capture
//   /tmp/live-capture [--aec] [--no-mic] [--no-system] [--volatile] > live.jsonl
//
//   --app <bundle id の前方一致>  そのアプリ（とヘルパー）の音だけをタップする。省略時は Mac 全体の音
//   --aec  マイクに Apple の音声処理（エコーキャンセル）をかける。スピーカーで聞くとき用
//   Ctrl-C で止める。

import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation
import Speech

let args = CommandLine.arguments
let useAEC = args.contains("--aec")
let useMic = !args.contains("--no-mic")
let useSystem = !args.contains("--no-system")
let wantVolatile = args.contains("--volatile")
let appPrefix = args.firstIndex(of: "--app").map { args[$0 + 1] }  // 例: com.google.Chrome / us.zoom.xos

func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }
let outLock = NSLock()
func emit(_ obj: [String: Any]) {
  let d = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
  outLock.lock(); print(String(data: d, encoding: .utf8)!); fflush(stdout); outLock.unlock()
}

let t0 = Date()
func now() -> Double { Date().timeIntervalSince(t0) }

// MARK: - トラック = 1 本の音声 → 1 つの SpeechAnalyzer

final class Track: @unchecked Sendable {
  let name: String
  let transcriber: SpeechTranscriber
  let analyzer: SpeechAnalyzer
  let target: AVAudioFormat
  let cont: AsyncStream<AnalyzerInput>.Continuation
  let stream: AsyncStream<AnalyzerInput>
  var converter: AVAudioConverter?
  var offset: Double?  // このトラックの音声 0 秒が、セッション開始から何秒後か
  var fedSeconds = 0.0
  var lastLevelLog = 0.0
  var peak: Float = 0

  init(name: String) async throws {
    self.name = name
    transcriber = SpeechTranscriber(
      locale: Locale(identifier: "ja-JP"),
      transcriptionOptions: [],
      reportingOptions: wantVolatile ? [.volatileResults] : [],
      attributeOptions: [.audioTimeRange])
    if let req = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      try await req.downloadAndInstall()
    }
    analyzer = SpeechAnalyzer(modules: [transcriber])
    target = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])!
    (stream, cont) = AsyncStream<AnalyzerInput>.makeStream()
  }

  func run() {
    Task {
      do {
        for try await r in transcriber.results {
          let off = offset ?? 0
          emit([
            "track": name,
            "final": r.isFinal,
            "start": off + r.range.start.seconds,
            "end": off + r.range.end.seconds,
            "arrived": now(),
            "lag": now() - (off + r.range.end.seconds),
            "text": String(r.text.characters),
          ])
        }
      } catch { log("\(name) results error: \(error)") }
    }
    Task {
      do { try await analyzer.start(inputSequence: stream) } catch { log("\(name) analyzer error: \(error)") }
    }
  }

  // IO スレッドから呼ばれる。受け取ったバッファを analyzer の形式に変換して流す
  func feed(_ buf: AVAudioPCMBuffer) {
    if offset == nil { offset = now(); log("\(name): first audio at \(String(format: "%.2f", offset!))s, format \(buf.format)") }
    if converter == nil || converter!.inputFormat != buf.format {
      converter = AVAudioConverter(from: buf.format, to: target)
    }
    let outCap = AVAudioFrameCount(Double(buf.frameLength) * target.sampleRate / buf.format.sampleRate) + 64
    let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: outCap)!
    var given = false
    var err: NSError?
    converter!.convert(to: out, error: &err) { _, st in
      if given { st.pointee = .noDataNow; return nil }
      given = true; st.pointee = .haveData; return buf
    }
    if let err { log("\(name) convert error: \(err)"); return }
    fedSeconds += Double(buf.frameLength) / buf.format.sampleRate
    // 5 秒ごとに入力レベルを出す（無音で取れていないのか、取れているのかを見分けるため）
    if let ch = buf.floatChannelData {
      for i in 0..<Int(buf.frameLength) { peak = max(peak, abs(ch[0][i])) }
    }
    if fedSeconds - lastLevelLog >= 5 {
      log("\(name): fed \(Int(fedSeconds))s peak \(String(format: "%.3f", peak))")
      lastLevelLog = fedSeconds; peak = 0
    }
    cont.yield(AnalyzerInput(buffer: out))
  }
}

// MARK: - システム音声（プロセスタップ + 集約デバイス）

func getProp<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ initial: T) -> T {
  var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var v = initial
  var size = UInt32(MemoryLayout<T>.size)
  let st = AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &v)
  if st != noErr { log("getProp \(sel) failed: \(st)") }
  return v
}

// 音を出しうるプロセス（Core Audio のプロセスオブジェクト）のうち、bundle id が前方一致するもの
func audioProcesses(matching prefix: String) -> [AudioObjectID] {
  var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size)
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids)
  return ids.filter { id in
    let bid: CFString = getProp(id, kAudioProcessPropertyBundleID, "" as CFString)
    let hit = (bid as String).hasPrefix(prefix)
    if hit {
      let pid: pid_t = getProp(id, kAudioProcessPropertyPID, pid_t(0))
      let out: UInt32 = getProp(id, kAudioProcessPropertyIsRunningOutput, UInt32(0))
      log("tap target: \(bid) (object \(id), pid \(pid), output running \(out))")
    }
    return hit
  }
}

func startSystemTap(_ track: Track) throws {
  let desc: CATapDescription
  if let appPrefix {
    let procs = audioProcesses(matching: appPrefix)
    guard !procs.isEmpty else { throw NSError(domain: "tap", code: 0, userInfo: [NSLocalizedDescriptionKey: "no audio process matches \(appPrefix)"]) }
    desc = CATapDescription(stereoMixdownOfProcesses: procs)
  } else {
    desc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
  }
  desc.uuid = UUID()
  desc.name = "live-mindmap-prototype-tap"
  desc.isPrivate = true
  desc.muteBehavior = .unmuted
  var tapID = AudioObjectID(kAudioObjectUnknown)
  var st = AudioHardwareCreateProcessTap(desc, &tapID)
  guard st == noErr else { throw NSError(domain: "tap", code: Int(st), userInfo: [NSLocalizedDescriptionKey: "AudioHardwareCreateProcessTap failed \(st)"]) }

  var asbd: AudioStreamBasicDescription = getProp(tapID, kAudioTapPropertyFormat, AudioStreamBasicDescription())
  let fmt = AVAudioFormat(streamDescription: &asbd)!

  let outDev: AudioObjectID = getProp(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, AudioObjectID(0))
  let outUID: CFString = getProp(outDev, kAudioDevicePropertyDeviceUID, "" as CFString)

  let aggDesc: [String: Any] = [
    kAudioAggregateDeviceNameKey: "live-mindmap-prototype",
    kAudioAggregateDeviceUIDKey: UUID().uuidString,
    kAudioAggregateDeviceMainSubDeviceKey: outUID as String,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceIsStackedKey: false,
    kAudioAggregateDeviceTapAutoStartKey: true,
    kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outUID as String]],
    kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: desc.uuid.uuidString]],
  ]
  var aggID = AudioObjectID(kAudioObjectUnknown)
  st = AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggID)
  guard st == noErr else { throw NSError(domain: "tap", code: Int(st), userInfo: [NSLocalizedDescriptionKey: "AudioHardwareCreateAggregateDevice failed \(st)"]) }

  var procID: AudioDeviceIOProcID?
  let q = DispatchQueue(label: "tap-io")
  st = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, q) { _, inData, _, _, _ in
    guard let src = AVAudioPCMBuffer(pcmFormat: fmt, bufferListNoCopy: inData, deallocator: nil) else { return }
    track.feed(src)
  }
  guard st == noErr else { throw NSError(domain: "tap", code: Int(st)) }
  st = AudioDeviceStart(aggID, procID)
  guard st == noErr else { throw NSError(domain: "tap", code: Int(st), userInfo: [NSLocalizedDescriptionKey: "AudioDeviceStart failed \(st)"]) }
  // 出力先がスピーカーかイヤホンか（二重文字起こし対策を切り替える材料）
  let transport: UInt32 = getProp(outDev, kAudioDevicePropertyTransportType, UInt32(0))
  var dsAddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDataSource, mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
  var ds: UInt32 = 0
  var dsSize = UInt32(MemoryLayout<UInt32>.size)
  AudioObjectGetPropertyData(outDev, &dsAddr, 0, nil, &dsSize, &ds)
  func fourcc(_ v: UInt32) -> String { String(bytes: [24, 16, 8, 0].map { UInt8((v >> $0) & 0xff) }, encoding: .ascii) ?? "?" }
  log("system: output transport=\(fourcc(transport)) datasource=\(fourcc(ds))  (bltn+ispk=内蔵スピーカー, bltn+hdpn=有線イヤホン, blue=Bluetooth)")
  log("system: tap started, output device uid=\(outUID), format \(fmt)")
}

// MARK: - マイク

let engine = AVAudioEngine()
func startMic(_ track: Track) throws {
  let input = engine.inputNode
  if useAEC {
    try input.setVoiceProcessingEnabled(true)
    // 他アプリの音を下げる（ダッキング）を最小に。タップとの相性を見るため
    input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
  }
  let fmt = input.outputFormat(forBus: 0)
  input.installTap(onBus: 0, bufferSize: 4096, format: fmt) { buf, _ in track.feed(buf) }
  try engine.start()
  log("mic: started (aec=\(useAEC)), format \(fmt)")
}

// MARK: - main

if args.contains("--list") {
  _ = audioProcesses(matching: "")
  exit(0)
}

log("mic permission: \(AVCaptureDevice.authorizationStatus(for: .audio).rawValue) (3=authorized)")
if useMic, AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
  let ok = await AVCaptureDevice.requestAccess(for: .audio)
  log("mic access granted: \(ok)")
}

var tracks: [Track] = []
// --mic-first: マイク（音声処理）を先に開始してからタップを作る（順番で相性が変わるかの確認）
let micFirst = args.contains("--mic-first")
if useMic && micFirst {
  let t = try await Track(name: "mic"); t.run(); try startMic(t); tracks.append(t)
}
if useSystem {
  let t = try await Track(name: "system"); t.run(); try startSystemTap(t); tracks.append(t)
}
if useMic && !micFirst {
  let t = try await Track(name: "mic"); t.run(); try startMic(t); tracks.append(t)
}
log("running. Ctrl-C to stop.")

signal(SIGINT, SIG_IGN)
let sigSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigSrc.setEventHandler {
  log("stopping…")
  Task {
    for t in tracks {
      t.cont.finish()
      try? await t.analyzer.finalizeAndFinishThroughEndOfInput()
    }
    try? await Task.sleep(for: .seconds(1))
    exit(0)
  }
}
sigSrc.resume()
while true { try await Task.sleep(for: .seconds(3600)) }
