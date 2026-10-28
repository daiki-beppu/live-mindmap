import AVFoundation
import CoreAudio
import Foundation
@testable import HelperCore
import Testing

private enum LiveTestError: Error, Equatable {
    case timeout(String)
    case diarizerStopped
    case binaryFrame
    case microphoneStart
    case recordingFinish
}

private let finalText = "こんにちは"

private final class Cell<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value { lock.withLock { stored } }
    func update(_ body: (inout Value) -> Void) { lock.withLock { body(&stored) } }
}

private func waitFor(_ name: String, _ condition: () -> Bool) async throws {
    let deadline = ContinuousClock.now + .seconds(10)
    while !condition() {
        guard ContinuousClock.now < deadline else { throw LiveTestError.timeout(name) }
        try await Task.sleep(for: .milliseconds(2))
    }
}

private final class FakeAudio: LiveTap, LiveMicrophone {
    let started = Cell(false)
    let stopped = Cell(false)
    let onPermission = Cell<(() -> Void)?>(nil)
    let beforeStart = Cell<(() -> Void)?>(nil)
    let startFailure = Cell<LiveTestError?>(nil)
    let receivedFrames = Cell(true)
    let onCurrentLine = Cell<(() -> Void)?>(nil)
    let stream: AsyncThrowingStream<CapturedAudio, Error>
    let input: AsyncThrowingStream<CapturedAudio, Error>.Continuation
    init() { (stream, input) = AsyncThrowingStream.makeStream(of: CapturedAudio.self) }
    func requestPermission() async throws { onPermission.value?() }
    func start() throws -> AsyncThrowingStream<CapturedAudio, Error> {
        started.update { $0 = true }
        beforeStart.value?()
        if let failure = startFailure.value { throw failure }
        return stream
    }
    func stop() { stopped.update { $0 = true }; input.finish() }
    var hasReceivedFrames: Bool { receivedFrames.value }
    func currentLine() -> String { onCurrentLine.value?(); return "fake audio" }
}

private final class FakeClock: LiveClock {
    let time: Cell<UInt64>
    let sleeps = Cell<[Duration]>([])
    init(time: UInt64) { self.time = Cell(time) }
    func now() -> UInt64 { time.value }
    func sleep(for duration: Duration) async throws {
        let parts = duration.components
        let nanos = UInt64(parts.seconds) * 1_000_000_000 + UInt64(parts.attoseconds / 1_000_000_000)
        let deadline = now() + AudioConvertNanosToHostTime(nanos)
        sleeps.update { $0.append(duration) }
        try await waitFor("仮想時計の待機期限") { self.now() >= deadline }
    }
    func advanceTenSeconds() { time.update { $0 += AudioConvertNanosToHostTime(10_000_000_000) } }
}

private final class FakeUsage: LiveInputUsage {
    let using = Cell(false)
    let reads = Cell(0)
    let stopped = Cell(false)
    let notify = Cell<(@Sendable () -> Void)?>(nil)
    func readProcesses() -> [InputProcess]? {
        let result = [InputProcess(bundleID: "test.meeting", pid: 42, isRunningInput: using.value)]
        reads.update { $0 += 1 }
        return result
    }
    func observe(_ onChange: @escaping @Sendable () -> Void) -> () -> Void {
        notify.update { $0 = onChange }
        return { self.stopped.update { $0 = true }; self.notify.update { $0 = nil } }
    }
    func beginUsing() { using.update { $0 = true }; notify.value?() }
}

private struct FakeTranscriber: Transcriber {
    func prepare() async throws {}
    func transcribe(_ audio: AsyncThrowingStream<CapturedAudio, Error>, origin: UInt64) async throws -> AsyncThrowingStream<TranscriptionResult, Error> {
        AsyncThrowingStream { output in
            let task = Task {
                do {
                    var heard = false
                    for try await _ in audio { heard = true }
                    if heard {
                        output.yield(TranscriptionResult(text: finalText, isFinal: true, start: 0, end: 1))
                    }
                    output.finish()
                } catch { output.finish(throwing: error) }
            }
            output.onTermination = { _ in task.cancel() }
        }
    }
}

private final class FakeDiarizer: SpeakerDiarizer {
    let ready = Cell(false)
    let produce = Cell(false)
    let afterProducing = Cell<(() -> Void)?>(nil)
    func prepare() async throws {}
    func diarize(_ audio: AsyncThrowingStream<CapturedAudio, Error>, origin: UInt64) async throws -> AsyncThrowingStream<SpeakerDiarization, Error> {
        AsyncThrowingStream { output in
            let task = Task {
                do {
                    var iterator = audio.makeAsyncIterator()
                    _ = try await iterator.next()
                    ready.update { $0 = true }
                    try await waitFor("話者イベントを出す指示") { self.produce.value }
                    output.yield(.segment(SpeakerSegment(start: 0, end: 1, slot: 0, isFinal: true)))
                    output.yield(.settled(to: 1))
                    afterProducing.value?()
                    while try await iterator.next() != nil {}
                    output.finish(throwing: LiveTestError.diarizerStopped)
                } catch { output.finish(throwing: error) }
            }
            output.onTermination = { _ in task.cancel() }
        }
    }
}

private final class FakeScreen: LiveScreenSource {
    let started = Cell(false)
    let stopped = Cell(false)
    let events: AsyncStream<HelperEvent>
    private let output: AsyncStream<HelperEvent>.Continuation
    private let ending: AsyncStream<Void>
    private let end: AsyncStream<Void>.Continuation
    init() {
        (events, output) = AsyncStream.makeStream(of: HelperEvent.self)
        (ending, end) = AsyncStream.makeStream(of: Void.self)
    }
    func run() async {
        started.update { $0 = true }
        for await _ in ending {}
        output.yield(.screen(start: 1, image: String(repeating: "A", count: 1024 * 1024), lines: ["last screen"]))
        output.yield(.screenOff(start: 2, reason: .許可なし))
        output.finish()
    }
    func stop() { stopped.update { $0 = true }; end.finish() }
}

private final class Client {
    let task: URLSessionWebSocketTask
    let frames = Cell<[String]>([])
    private let receiveError = Cell<Error?>(nil)
    private let reader: Task<Void, Never>
    init(port: UInt16, observe: (@Sendable (String?) -> Void)? = nil) {
        task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.maximumMessageSize = 8 * 1024 * 1024
        task.resume()
        let task = task
        let frames = frames
        let receiveError = receiveError
        reader = Task {
            do {
                while !Task.isCancelled {
                    switch try await task.receive() {
                    case .string(let text):
                        frames.update { $0.append(text) }
                        observe?(text)
                    case .data: throw LiveTestError.binaryFrame
                    @unknown default: throw LiveTestError.binaryFrame
                    }
                }
            } catch {
                observe?(nil)
                receiveError.update { $0 = error }
            }
        }
    }
    func close() { task.cancel(with: .goingAway, reason: nil); reader.cancel() }
    func requireOpenWhileDeliveryIsHeld() async throws {
        let deadline = ContinuousClock.now + .milliseconds(200)
        repeat {
            try #require(receiveError.value == nil, "tap-silent の配送保留中に接続が閉じた")
            try await Task.sleep(for: .milliseconds(2))
        } while ContinuousClock.now < deadline
    }
    func waitForClosed() async throws {
        try await waitFor("server による接続終了") { self.receiveError.value != nil }
    }
    func waitForEvent(_ event: HelperEvent) async throws {
        let text = try event.jsonString()
        do {
            try await waitFor("socket イベント \(String(text.prefix(80)))") { self.frames.value.contains(text) }
        } catch {
            let summaries = frames.value.map { frame -> String in
                guard let object = try? JSONSerialization.jsonObject(with: Data(frame.utf8)) as? [String: Any] else { return "invalid JSON" }
                return "\(object["type"] ?? "?") bytes=\(frame.utf8.count) text=\((object["text"] as? String)?.count ?? 0)"
            }
            print("client=\(String(describing: task.originalRequest?.url)) received events: \(summaries); expected bytes=\(text.utf8.count); receive error=\(String(describing: receiveError.value))")
            throw error
        }
    }
}

private final class Fixture {
    let tap = FakeAudio()
    let microphone = FakeAudio()
    let usage = FakeUsage()
    let origin: UInt64 = 1_000_000
    let clock: FakeClock
    init() { clock = FakeClock(time: origin + AudioConvertNanosToHostTime(6_000_000_000)) }
    var time: UInt64 { clock.now() }
    func session(screen: LiveScreen, diarizer: FakeDiarizer? = nil, recording: URL? = nil, explicitOrigin: Bool = true, makeRecording: RunAudio.Recording? = nil, sendEvent: (@Sendable (HelperEvent, WebSocketServer) async -> Void)? = nil) -> LiveSession {
        let devices = LiveDevices(
            tap: tap, microphone: microphone, makeTranscriber: { _ in FakeTranscriber() },
            makeDiarizer: { diarizer }, inputUsage: usage, screen: screen, clock: clock
        )
        let settings = LiveSettings(
            bundleID: "test.meeting", ownPID: 1, port: 0, origin: explicitOrigin ? origin : nil,
            recording: recording.map { .init(directory: $0, attempt: 2) }, marksDuplicates: false,
            selfPauseCarryOver: SelfPauseCarryOver(manual: .pause, basis: .idle, lastKnown: .idle, idleFor: 3),
            controlToken: "test-control", log: { _ in }
        )
        if let sendEvent {
            return LiveSession(devices: devices, settings: settings, recording: makeRecording, sendEvent: sendEvent)
        }
        if let makeRecording { return LiveSession(devices: devices, settings: settings, recording: makeRecording) }
        return LiveSession(devices: devices, settings: settings)
    }
    func sample() throws -> CapturedAudio {
        let format = try #require(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1))
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 480))
        buffer.frameLength = 480
        try #require(buffer.floatChannelData)[0].update(repeating: 0.25, count: 480)
        return CapturedAudio(buffer: buffer, hostTime: origin)
    }
}

private func runSession(_ session: LiveSession) -> (Task<Void, Never>, Cell<Result<Void, Error>?>) {
    let result = Cell<Result<Void, Error>?>(nil)
    let task = Task {
        do { try await session.run(); result.update { $0 = .success(()) } }
        catch { result.update { $0 = .failure(error) } }
    }
    return (task, result)
}

private func waitForCompletion(_ result: Cell<Result<Void, Error>?>) async throws {
    try await waitFor("LiveSession.run の終了") { result.value != nil }
    try #require(result.value).get()
}

@Suite("ライブのセッション", .timeLimit(.minutes(1)))
struct LiveSessionITTests {
    @Test("マイクの構成変更と録音終了の失敗が重なっても構成変更を返す")
    func microphoneConfigurationChangeWinsOverRecordingFailure() async throws {
        let fixture = Fixture()
        let created = Cell<[Track]>([])
        let failed = Cell<[Track]>([])
        let (ending, end) = AsyncStream.makeStream(of: Void.self)
        defer { end.finish() }
        let session = fixture.session(screen: .off, makeRecording: { track, stream, _ in
            created.update { $0.append(track) }
            // 音声へ録音の失敗を流さず、run 本体と finish の異なる失敗を競合させる。
            let finished = Task<Void, Error> {
                for await _ in ending {}
                failed.update { $0.append(track) }
                throw LiveTestError.recordingFinish
            }
            return (stream: stream, finished: finished)
        })
        defer { session.stop() }
        _ = try await session.start()
        let (running, result) = runSession(session)
        defer { running.cancel() }
        try await waitFor("両トラックの録音生成") { created.value.count == 2 }
        fixture.microphone.input.finish(throwing: MicrophoneError.configurationChanged)
        end.finish()
        try await waitFor("マイクと録音が失敗したセッションの終了") { result.value != nil }

        #expect(Set(created.value) == Set([Track.相手, .自分]))
        #expect(Set(failed.value) == Set([Track.相手, .自分]))
        #expect {
            try #require(result.value).get()
        } throws: { error in
            if case MicrophoneError.configurationChanged = error { return true }
            return false
        }
    }

    @Test("無音の tap は注入時計の10秒後に接続クライアントへ通知する")
    func silentTapUsesInjectedClock() async throws {
        let fixture = Fixture()
        fixture.tap.receivedFrames.update { $0 = false }
        let session = fixture.session(screen: .off)
        defer { session.stop() }
        let client = Client(port: try await session.start())
        defer { client.close() }
        try await client.waitForEvent(.origin(hostTime: fixture.origin))
        let (running, result) = runSession(session)
        defer { running.cancel() }
        try await waitFor("tap の10秒待機登録") { fixture.clock.sleeps.value.contains(.seconds(10)) }

        fixture.clock.advanceTenSeconds()
        try await client.waitForEvent(.tapSilent(start: offsetSeconds(from: fixture.origin, to: fixture.time)))
        session.stop()
        try await waitForCompletion(result)
    }

    @Test("無音の判定中に stop が重なっても通知を配送してから接続を閉じる")
    func stopDuringSilentJudgementDrainsNotification() async throws {
        let fixture = Fixture()
        fixture.tap.receivedFrames.update { $0 = false }
        let trace = Cell<[String]>([])
        defer { print("tap-silent delivery sequence: \(trace.value)") }
        let deliveryEntered = Cell(false)
        let releaseDelivery = Cell(false)
        defer { releaseDelivery.update { $0 = true } }
        let expected = HelperEvent.tapSilent(start: offsetSeconds(
            from: fixture.origin, to: fixture.time + AudioConvertNanosToHostTime(10_000_000_000)
        ))
        let expectedJSON = try expected.jsonString()
        let session = fixture.session(screen: .off, sendEvent: { event, server in
            if case .tapSilent = event {
                trace.update { $0.append("delivery-entered") }
                deliveryEntered.update { $0 = true }
                do {
                    try await waitFor("tap-silent の配送ゲート解放") { releaseDelivery.value }
                } catch {
                    Issue.record(error)
                    return
                }
            }
            await server.send(event)
        })
        defer { session.stop() }
        let client = Client(port: try await session.start(), observe: { text in
            if text == expectedJSON { trace.update { $0.append("tap-silent-received") } }
            if text == nil { trace.update { $0.append("connection-closed") } }
        })
        defer { client.close() }
        try await client.waitForEvent(.origin(hostTime: fixture.origin))
        let (running, result) = runSession(session)
        defer { running.cancel() }
        try await waitFor("tap の10秒待機登録") { fixture.clock.sleeps.value.contains(.seconds(10)) }
        let judging = Cell(false)
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        fixture.tap.onCurrentLine.update { $0 = {
            judging.update { $0 = true }
            #expect(release.wait(timeout: .now() + 10) == .success)
        } }
        defer { fixture.tap.onCurrentLine.update { $0 = nil } }
        fixture.clock.advanceTenSeconds()
        try await waitFor("無音判定中の機器読み出し") { judging.value }
        let stopping = Cell(false)
        let stop = Task.detached {
            trace.update { $0.append("stop-requested") }
            stopping.update { $0 = true }
            session.stop()
        }
        defer { stop.cancel() }
        try await waitFor("判定中の停止要求") { stopping.value }
        release.signal()
        try await waitFor("生成済み tap-silent の配送保留") { deliveryEntered.value }
        try await waitFor("停止要求による両入力の停止") { fixture.tap.stopped.value && fixture.microphone.stopped.value }
        await stop.value
        trace.update { $0.append("inputs-stopped") }
        try await client.requireOpenWhileDeliveryIsHeld()
        trace.update { $0.append("delivery-released") }
        releaseDelivery.update { $0 = true }
        try await client.waitForEvent(expected)
        try await client.waitForClosed()
        try await waitForCompletion(result)
        trace.update { $0.append("run-completed") }
        #expect(client.frames.value.filter { $0 == expectedJSON }.count == 1)
        let received = try #require(trace.value.firstIndex(of: "tap-silent-received"))
        let closed = try #require(trace.value.firstIndex(of: "connection-closed"))
        #expect(received < closed)
    }

    @Test("マイクの開始に失敗しても開始済み入力を停止し末尾を配送してから元の失敗を返す")
    func microphoneFailureDrainsAndClosesSession() async throws {
        let fixture = Fixture()
        let screen = FakeScreen()
        let usage = fixture.usage
        fixture.microphone.beforeStart.update { $0 = { usage.beginUsing() } }
        fixture.microphone.startFailure.update { $0 = .microphoneStart }
        let session = fixture.session(screen: .capture { _ in screen })
        defer { session.stop() }
        let client = Client(port: try await session.start())
        defer { client.close() }
        try await client.waitForEvent(.origin(hostTime: fixture.origin))
        let (running, result) = runSession(session)
        defer { running.cancel() }

        try await waitFor("マイク開始失敗後の LiveSession.run の終了") { result.value != nil }
        #expect(throws: LiveTestError.microphoneStart) { try #require(result.value).get() }
        #expect(fixture.tap.started.value && fixture.microphone.started.value && screen.started.value)
        #expect(fixture.tap.stopped.value && fixture.microphone.stopped.value && fixture.usage.stopped.value && screen.stopped.value)
        try await client.waitForEvent(.screen(start: 1, image: String(repeating: "A", count: 1024 * 1024), lines: ["last screen"]))
        try await client.waitForEvent(.screenOff(start: 2, reason: .許可なし))
        try await client.waitForEvent(.selfPauseState(SelfPauseCarryOver(manual: .none, basis: .unknown, lastKnown: .using, idleFor: 0)))
    }

    @Test("準備後に接続すると原点・画面の許可なし・モデルなしが注入時計の時刻で届く", arguments: [false, true])
    func startupEventsUseInjectedClock(explicitOrigin: Bool) async throws {
        let fixture = Fixture()
        let clock = fixture.clock
        fixture.microphone.onPermission.update { $0 = { clock.time.update { $0 += AudioConvertNanosToHostTime(2_000_000_000) } } }
        let session = fixture.session(screen: .denied, explicitOrigin: explicitOrigin)
        defer { session.stop() }
        let port = try await session.start()
        let client = Client(port: port)
        defer { client.close() }
        let origin = explicitOrigin ? fixture.origin : fixture.time
        let offset = offsetSeconds(from: origin, to: fixture.time)
        try await client.waitForEvent(.origin(hostTime: origin))
        try await client.waitForEvent(.screenOff(start: offset, reason: .許可なし))
        try await client.waitForEvent(.speakerOff(start: offset, reason: .モデルなし))
        session.stop()
        let (running, result) = runSession(session)
        defer { running.cancel() }
        try await waitForCompletion(result)
    }

    @Test("共有画面を取らず話者の末尾を出した直後に止めても発言・話者・最後の休止状態を配送し録音を閉じる", arguments: [false, true])
    func noScreenDrainsFinalEventsAndRecording(screenDenied: Bool) async throws {
        let fixture = Fixture()
        let diarizer = FakeDiarizer()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("live-session-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let session = fixture.session(screen: screenDenied ? .denied : .off, diarizer: diarizer, recording: directory)
        defer { session.stop() }
        let client = Client(port: try await session.start())
        defer { client.close() }
        try await client.waitForEvent(.origin(hostTime: fixture.origin))
        let (running, result) = runSession(session)
        defer { running.cancel() }
        try await waitFor("tap とマイクの開始") { fixture.tap.started.value && fixture.microphone.started.value }
        fixture.tap.input.yield(try fixture.sample())
        fixture.microphone.input.yield(try fixture.sample())
        try await waitFor("話者分離と休止監視の開始") { diarizer.ready.value && fixture.usage.reads.value > 0 }
        try await client.waitForEvent(.selfPauseState(SelfPauseCarryOver(manual: .pause, basis: .idle, lastKnown: .idle, idleFor: 3)))
        fixture.usage.beginUsing()
        diarizer.afterProducing.update { $0 = { session.stop() } }
        defer { diarizer.afterProducing.update { $0 = nil } }
        diarizer.produce.update { $0 = true }
        try await waitForCompletion(result)

        let segment = HelperEvent.speaker(track: .相手, start: 0, end: 1, slot: 0, isFinal: true)
        let settled = HelperEvent.speakerSettled(track: .相手, to: 1)
        let off = HelperEvent.speakerOff(start: offsetSeconds(from: fixture.origin, to: fixture.time), reason: .途中で停止)
        let remark = event(from: TranscriptionResult(text: finalText, isFinal: true, start: 0, end: 1), track: .相手)
        let state = HelperEvent.selfPauseState(SelfPauseCarryOver(manual: .none, basis: .unknown, lastKnown: .using, idleFor: 0))
        let resumed = HelperEvent.selfPause(paused: false, reason: .automatic, start: offsetSeconds(from: fixture.origin, to: fixture.time))
        for event in [segment, settled, off, remark, state, resumed] { try await client.waitForEvent(event) }
        let speakerFrames = client.frames.value.filter { text in [segment, settled, off].contains { (try? $0.jsonString()) == text } }
        #expect(speakerFrames == (try [segment, settled, off].map { try $0.jsonString() }))
        #expect(fixture.tap.stopped.value && fixture.microphone.stopped.value && fixture.usage.stopped.value)
        for track in [Track.相手, .自分] {
            let file = try AVAudioFile(forReading: directory.appendingPathComponent(recordingFileName(track: track, attempt: 2)))
            #expect(file.length > 0)
        }
    }

    @Test("tap・マイク・入力通知・画面が開いたままでも重複した stop で戻り末尾の画面を配送する")
    func stopClosesOpenInputsAndScreen() async throws {
        let fixture = Fixture()
        let screen = FakeScreen()
        let session = fixture.session(screen: .capture { _ in screen })
        defer { session.stop() }
        let client = Client(port: try await session.start())
        defer { client.close() }
        try await client.waitForEvent(.origin(hostTime: fixture.origin))
        let (running, result) = runSession(session)
        defer { running.cancel() }
        try await waitFor("すべての入力の開始") {
            fixture.tap.started.value && fixture.microphone.started.value && fixture.usage.notify.value != nil && screen.started.value
        }
        session.stop()
        session.stop()
        try await waitForCompletion(result)
        try await client.waitForEvent(.screen(start: 1, image: String(repeating: "A", count: 1024 * 1024), lines: ["last screen"]))
        try await client.waitForEvent(.screenOff(start: 2, reason: .許可なし))
        #expect(fixture.tap.stopped.value && fixture.microphone.stopped.value && fixture.usage.stopped.value && screen.stopped.value)
    }

    @Test("run 前に stop しても開いたままの偽入力に待たされず終了する")
    func stopBeforeRunCompletes() async throws {
        let fixture = Fixture()
        let screen = FakeScreen()
        let session = fixture.session(screen: .capture { _ in screen })
        _ = try await session.start()
        defer { session.stop() }
        session.stop()
        session.stop()
        let (running, result) = runSession(session)
        defer { running.cancel() }
        try await waitForCompletion(result)
    }
}
