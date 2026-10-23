import Foundation
import Testing
@testable import HelperCore

private let browser = "com.google.Chrome"
private let gmail = "Gmail - Inbox"
private let youtube = "配信 - YouTube"

private func tabFrame(_ time: Double, _ title: String?, _ value: UInt8) -> ScreenFrame {
    ScreenFrame(luma: [UInt8](repeating: value, count: screenGridWidth * screenGridHeight), time: time, title: title)
}

private func emitTab(_ emitter: ScreenEventEmitter, at time: Double, title: String?, value: UInt8, image: String) {
    emitter.emit(tabFrame(time, title, value)) { ScreenShot(image: image, lines: [image + " OCR"]) }
}

// JSON is the observable stream contract; extra notification metadata does not change image equality.
struct TabScreen: Decodable, Equatable {
    let type: String
    let start: Double
    let image: String?
    let lines: [String]?
    let reason: String?
}

extension TabScreen {
    init(event: HelperEvent) throws {
        self = try JSONDecoder().decode(TabScreen.self, from: Data(event.jsonString().utf8))
    }
}

func drainTabs(_ emitter: ScreenEventEmitter) async throws -> [TabScreen] {
    emitter.close()
    var result: [TabScreen] = []
    for await event in emitter.events {
        result.append(try TabScreen(event: event))
    }
    return result
}

private func imageScreen(_ start: Double, _ image: String) -> TabScreen {
    TabScreen(type: "screen", start: start, image: image, lines: [image + " OCR"], reason: nil)
}

private func nullScreen(_ start: Double) -> TabScreen {
    TabScreen(type: "screen", start: start, image: nil, lines: nil, reason: nil)
}

@Suite("ブラウザの仮の会議タブ", .timeLimit(.minutes(1)))
struct ScreenProvisionalTabTests {
    @Test("保留画像と同じ輝度のMeetも確定前に送出し、同じ送出画像は再送しない")
    func identicalMeetIsComparedWithSentImages() throws {
        var detector = ScreenChangeDetector(bundleID: browser)
        #expect(detector.screenEvent(for: tabFrame(0, gmail, 30)) { ScreenShot(image: "gmail", lines: ["gmail OCR"]) }.isEmpty)
        let events = detector.screenEvent(for: tabFrame(1, "Meet - abc", 30)) { ScreenShot(image: "meet", lines: ["meet OCR"]) }
        #expect(try events.map { try TabScreen(event: $0) } == [imageScreen(1, "meet")])
        #expect(detector.screenEvent(for: tabFrame(2, "Meet - abc", 30)) { Issue.record("同一画像は再送しない"); return nil }.isEmpty)
    }

    @Test("通常確定後も最新の送出画像と比較し、異なる対象へ戻った画面を送る", arguments: [gmail, "Meet - abc"])
    func confirmationKeepsLatestImageComparison(_ title: String) throws {
        var detector = ScreenChangeDetector(bundleID: browser)
        _ = detector.screenEvent(for: tabFrame(0, gmail, 30)) { ScreenShot(image: "gmail", lines: ["gmail OCR"]) }
        _ = detector.screenEvent(for: tabFrame(1, "Meet - abc", 200)) { ScreenShot(image: "meet", lines: ["meet OCR"]) }
        _ = detector.screenEvent(for: tabFrame(2, "Meet - abc", 200)) { ScreenShot(image: "meet", lines: ["meet OCR"]) }
        let value: UInt8 = title == gmail ? 30 : 200
        var events: [HelperEvent] = []
        for time in stride(from: 60.0, through: 80, by: 0.25) {
            events += detector.screenEvent(for: tabFrame(time, title, value)) {
                ScreenShot(image: "gmail-return", lines: ["gmail-return OCR"])
            }
        }
        let expected = [imageScreen(0, "gmail")] + (title == gmail ? [imageScreen(60, "gmail-return")] : [])
        #expect(try events.map { try TabScreen(event: $0) } == expected)
    }

    @Test("即時送出がない通常確定は保留画像を比較基準にして重複を抑止する")
    func confirmationWithoutMeetKeepsBufferedComparison() throws {
        var detector = ScreenChangeDetector(bundleID: browser)
        #expect(detector.screenEvent(for: tabFrame(0, gmail, 30)) { ScreenShot(image: "gmail", lines: ["gmail OCR"]) }.isEmpty)
        var events: [HelperEvent] = []
        for time in stride(from: 60.0, through: 80, by: 0.25) {
            events += detector.screenEvent(for: tabFrame(time, gmail, 30)) {
                Issue.record("確定済みの保留画像を重複生成しない")
                return nil
            }
        }
        #expect(try events.map { try TabScreen(event: $0) } == [imageScreen(0, "gmail")])
    }

    @Test("Meetより新しい保留画像だけが確定後の比較基準になる", arguments: [UInt8(30), 100])
    func newerBufferedImageBecomesComparison(_ value: UInt8) throws {
        var detector = ScreenChangeDetector(bundleID: browser)
        _ = detector.screenEvent(for: tabFrame(0, gmail, 30)) { ScreenShot(image: "gmail", lines: ["gmail OCR"]) }
        let meet = detector.screenEvent(for: tabFrame(1, "Meet - abc", 200)) { ScreenShot(image: "meet", lines: ["meet OCR"]) }
        #expect(try meet.map { try TabScreen(event: $0) } == [imageScreen(1, "meet")])
        _ = detector.screenEvent(for: tabFrame(2, "Meet - abc", 200)) { Issue.record("同一Meetは再送しない"); return nil }
        _ = detector.screenEvent(for: tabFrame(49.75, gmail, 30)) { Issue.record("保留画像と同一なら生成しない"); return nil }
        var events: [HelperEvent] = []
        for time in stride(from: 50.0, through: 80, by: 0.25) {
            let current = detector.screenEvent(for: tabFrame(time, gmail, value)) {
                ScreenShot(image: "gmail-return", lines: ["gmail-return OCR"])
            }
            if time < 60 { #expect(current.isEmpty) }
            events += current
        }
        #expect(try events.map { try TabScreen(event: $0) } == [imageScreen(0, "gmail"), imageScreen(value == 30 ? 60 : 50, "gmail-return")])
    }

    @Test("復帰画像の生成失敗後は同一フレームで再試行し、保留画像は再配送しない")
    func failedReturnEncodeRetriesAfterConfirmation() throws {
        var detector = ScreenChangeDetector(bundleID: browser)
        _ = detector.screenEvent(for: tabFrame(0, gmail, 30)) { ScreenShot(image: "gmail", lines: ["gmail OCR"]) }
        _ = detector.screenEvent(for: tabFrame(1, "Meet - abc", 200)) { ScreenShot(image: "meet", lines: ["meet OCR"]) }
        _ = detector.screenEvent(for: tabFrame(2, "Meet - abc", 200)) { nil }
        var attempts: [Double] = []
        var events: [HelperEvent] = []
        for time in stride(from: 60.0, through: 80, by: 0.25) {
            let current = detector.screenEvent(for: tabFrame(time, gmail, 30)) {
                attempts.append(time)
                if attempts.count == 1 { return nil }
                return ScreenShot(image: "gmail-return", lines: ["gmail-return OCR"])
            }
            events += current
        }
        #expect(attempts.count == 2)
        if attempts.count == 2 {
            #expect(attempts[1] == attempts[0] + 0.25)
        }
        #expect(try events.map { try TabScreen(event: $0) } == [imageScreen(0, "gmail"), imageScreen(60, "gmail-return")])
    }

    @Test("Meetの画像生成失敗は送出側の比較だけを戻し、同一フレームを再試行する")
    func failedMeetEncodeCanRetry() throws {
        var detector = ScreenChangeDetector(bundleID: browser)
        _ = detector.screenEvent(for: tabFrame(0, gmail, 30)) { ScreenShot(image: "gmail", lines: ["gmail OCR"]) }
        #expect(detector.screenEvent(for: tabFrame(1, "Meet - abc", 30)) { nil }.isEmpty)
        let retry = detector.screenEvent(for: tabFrame(2, "Meet - abc", 30)) { ScreenShot(image: "meet", lines: ["meet OCR"]) }
        #expect(try retry.map { try TabScreen(event: $0) } == [imageScreen(2, "meet")])
        #expect(try detector.finish().map { try TabScreen(event: $0) } == [imageScreen(0, "gmail")])
    }

    @Test("仮期間中は画像を返さず、60秒のフレームで元のstartとOCRをまとめて返す")
    func provisionalImagesStayInsideDetectorUntilDeadline() throws {
        var detector = ScreenChangeDetector(bundleID: browser)
        for (time, value, image) in [(0.0, UInt8(30), "first"), (1, 200, "moving"), (2, 200, "second"), (59.999, 200, "unchanged")] {
            let events = detector.screenEvent(for: tabFrame(time, youtube, value)) {
                ScreenShot(image: image, lines: [image + " OCR"])
            }
            #expect(events.isEmpty)
        }
        let events = detector.screenEvent(for: tabFrame(60, youtube, 200)) {
            Issue.record("変化のない確定フレームは画像化しない")
            return nil
        }
        #expect(try events.map { try TabScreen(event: $0) } == [imageScreen(0, "first"), imageScreen(1, "second")])
    }

    @Test("Gmailから継続した配信へ覚え直し、配信のJPEGとOCRだけを元の時刻順に送る")
    func retargetDiscardsGmailAndFlushesYouTubeInStartOrder() async throws {
        var writes: [String] = []
        let emitter = ScreenEventEmitter(bundleID: browser, writeStderr: { writes.append($0) })
        emitTab(emitter, at: 0, title: gmail, value: 30, image: "gmail")
        emitTab(emitter, at: 10.6, title: youtube, value: 30, image: "candidate")
        emitTab(emitter, at: 20.599, title: youtube, value: 30, image: "too-soon")
        #expect(writes == ["会議のタブ: \(gmail)\n"])
        emitTab(emitter, at: 20.6, title: youtube, value: 30, image: "youtube-first")
        #expect(writes == ["会議のタブ: \(gmail)\n", "会議のタブ: \(youtube)\n"])
        emitTab(emitter, at: 21, title: youtube, value: 200, image: "moving")
        emitTab(emitter, at: 22, title: youtube, value: 200, image: "youtube-second")
        emitTab(emitter, at: 59.999, title: youtube, value: 200, image: "unchanged")
        #expect(writes.count == 2)
        emitTab(emitter, at: 60, title: youtube, value: 200, image: "unchanged")
        #expect(writes == ["会議のタブ: \(gmail)\n", "会議のタブ: \(youtube)\n", "会議のタブを確定しました: \(youtube)\n"])
        var iterator = emitter.events.makeAsyncIterator()
        let first = await iterator.next()
        let second = await iterator.next()
        #expect(try first.map { try TabScreen(event: $0) } == imageScreen(20.6, "youtube-first"))
        #expect(try second.map { try TabScreen(event: $0) } == imageScreen(21, "youtube-second"))
        #expect(try await drainTabs(emitter) == [])
    }

    @Test("正規化した候補は通知数と末尾の再生印が変わっても10秒継続する")
    func normalizedCandidateContinuesAcrossDecorations() {
        var detector = ScreenChangeDetector(bundleID: browser)
        _ = detector.next(.frame(tabFrame(0, gmail, 100)))
        _ = detector.next(.frame(tabFrame(10.6, "(3) 配信 - YouTube", 100)))
        _ = detector.next(.frame(tabFrame(20.6, "(4) 配信 - YouTube 🔊", 100)))
        #expect(detector.rememberedTabTitle.map(normalizedScreenTabTitle) == youtube)
        _ = detector.next(.frame(tabFrame(60, youtube, 100)))
        _ = detector.next(.frame(tabFrame(61, gmail, 100)))
        _ = detector.next(.frame(tabFrame(72, gmail, 100)))
        #expect(detector.rememberedTabTitle.map(normalizedScreenTabTitle) == youtube)
    }

    @Test("10秒未満の寄り道から元のタブへ戻ると候補の連続時間を持ち越さない")
    func shortVisitDoesNotAccumulateAcrossReturn() {
        var detector = ScreenChangeDetector(bundleID: browser)
        for (time, title) in [(0.0, gmail), (10, youtube), (19.999, youtube), (20, gmail), (21, youtube), (30.999, youtube)] {
            _ = detector.next(.frame(tabFrame(time, title, 100)))
            #expect(detector.rememberedTabTitle == gmail)
        }
        _ = detector.next(.frame(tabFrame(31, youtube, 100)))
        #expect(detector.rememberedTabTitle == youtube)
    }

    @Test("別候補・除外題名・読めない題名・Meetは候補の連続時間を中断する", arguments: [
        "別の配信", "live-mindmap", "about:blank", "新しいタブ", "New Tab", "", "Meet - abc", nil,
    ] as [String?])
    func interruptedCandidateMustStartAgain(_ interruption: String?) {
        var detector = ScreenChangeDetector(bundleID: browser)
        for (time, title) in [(0.0, Optional(gmail)), (10, Optional(youtube)), (19, interruption), (20, Optional(youtube)), (29.999, Optional(youtube))] {
            _ = detector.next(.frame(tabFrame(time, title, 100)))
        }
        #expect(detector.rememberedTabTitle == gmail)
        _ = detector.next(.frame(tabFrame(30, youtube, 100)))
        #expect(detector.rememberedTabTitle == youtube)
    }

    @Test("複数回覚え直しても最初の記憶から60秒で確定し、その後の別タブにはnullを一度だけ送る")
    func repeatedRetargetDoesNotExtendDeadline() async throws {
        var writes: [String] = []
        let emitter = ScreenEventEmitter(bundleID: browser, writeStderr: { writes.append($0) })
        for (time, title) in [(0.0, gmail), (10, youtube), (20, youtube), (30, "配信B"), (40, "配信B"), (60, "配信B"), (61, gmail), (72, gmail)] {
            emitTab(emitter, at: time, title: title, value: 100, image: title)
        }
        #expect(writes == ["会議のタブ: \(gmail)\n", "会議のタブ: \(youtube)\n", "会議のタブ: 配信B\n", "会議のタブを確定しました: 配信B\n"])
        #expect(try await drainTabs(emitter) == [imageScreen(40, "配信B"), nullScreen(61)])
    }

    @Test("候補が10秒に達する時刻が60秒の期限と同じなら元の対象を確定する")
    func deadlinePrecedesRetargetAtSixtySeconds() async throws {
        var writes: [String] = []
        let emitter = ScreenEventEmitter(bundleID: browser, writeStderr: { writes.append($0) })
        emitTab(emitter, at: 0, title: gmail, value: 100, image: "gmail")
        emitTab(emitter, at: 50, title: youtube, value: 100, image: "candidate")
        emitTab(emitter, at: 60, title: youtube, value: 100, image: "forbidden")
        #expect(writes == ["会議のタブ: \(gmail)\n", "会議のタブを確定しました: \(gmail)\n"])
        let events = try await drainTabs(emitter)
        #expect(events.filter { $0.image != nil } == [imageScreen(0, "gmail")])
        #expect(events.last?.image == nil)
    }

    @Test("覚え直しで旧タブの送信履歴を捨て、以前と同じ小領域の画面も新対象では送る")
    func retargetClearsSentHistory() async throws {
        let emitter = ScreenEventEmitter(bundleID: browser, writeStderr: { _ in })
        let base = tabFrame(0, gmail, 100).luma
        var changed = base
        for index in 0..<100 { changed[index] = 200 }
        for (time, title, pixels, image) in [
            (0.0, gmail, base, "gmail"), (1, gmail, changed, "moving-old"), (2, gmail, changed, "old-patch"),
            (3, youtube, base, "candidate"), (13, youtube, base, "new-base"),
            (14, youtube, changed, "moving-new"), (15, youtube, changed, "new-patch"), (60, youtube, changed, "unchanged"),
        ] {
            emitter.emit(ScreenFrame(luma: pixels, time: time, title: title)) { ScreenShot(image: image, lines: [image + " OCR"]) }
        }
        #expect(try await drainTabs(emitter) == [imageScreen(13, "new-base"), imageScreen(14, "new-patch")])
    }

    @Test("旧タブの継続的な動きは覚え直したタブの静止画を抑制しない")
    func retargetClearsMotionHistory() async throws {
        let emitter = ScreenEventEmitter(bundleID: browser, writeStderr: { _ in })
        emitTab(emitter, at: 0, title: gmail, value: 30, image: "gmail")
        for step in 1...19 {
            emitTab(emitter, at: Double(step) * 0.25, title: gmail, value: step % 2 == 0 ? 30 : 200, image: "moving-old")
        }
        emitTab(emitter, at: 5, title: youtube, value: 30, image: "candidate")
        emitTab(emitter, at: 15, title: youtube, value: 30, image: "youtube-first")
        emitTab(emitter, at: 15.25, title: youtube, value: 200, image: "moving-new")
        emitTab(emitter, at: 16.25, title: youtube, value: 200, image: "youtube-second")
        emitTab(emitter, at: 60, title: youtube, value: 200, image: "unchanged")
        #expect(try await drainTabs(emitter) == [imageScreen(15, "youtube-first"), imageScreen(15.25, "youtube-second")])
    }

    @Test("除外題名の待ち時間ではなく最初の記憶から60秒を数える")
    func deadlineStartsAtFirstEligibleTitle() async throws {
        var writes: [String] = []
        let emitter = ScreenEventEmitter(bundleID: browser, writeStderr: { writes.append($0) })
        emitTab(emitter, at: 0, title: "New Tab", value: 100, image: "excluded")
        emitTab(emitter, at: 100, title: gmail, value: 100, image: "gmail")
        emitTab(emitter, at: 159.999, title: gmail, value: 100, image: "unchanged")
        #expect(writes == ["会議のタブ: \(gmail)\n"])
        emitTab(emitter, at: 160, title: gmail, value: 100, image: "unchanged")
        #expect(writes.last == "会議のタブを確定しました: \(gmail)\n")
        #expect(try await drainTabs(emitter) == [imageScreen(100, "gmail")])
    }

    @Test("確定済みの題名本文や先頭の装飾を削除して別タブを許可しない", arguments: [
        "配信 (4) - YouTube", "🔊 配信 - YouTube", "(LIVE) 配信 - YouTube", "(4 配信 - YouTube", "(4)配信 - YouTube",
    ])
    func distinctTitleAfterConfirmationIsNotEncoded(_ title: String) async throws {
        let emitter = ScreenEventEmitter(bundleID: browser, writeStderr: { _ in })
        emitTab(emitter, at: 0, title: youtube, value: 100, image: "youtube")
        emitTab(emitter, at: 60, title: youtube, value: 100, image: "unchanged")
        var forbiddenEncodes = 0
        for time in [61.0, 72] {
            emitter.emit(tabFrame(time, title, 200)) {
                forbiddenEncodes += 1
                return ScreenShot(image: "forbidden", lines: ["forbidden"])
            }
        }
        #expect(try await drainTabs(emitter) == [imageScreen(0, "youtube"), nullScreen(61)])
        #expect(forbiddenEncodes == 0)
    }

    @Test("nilと空題名の保留画像も覚え直し時に旧タブと一緒に捨て、新対象の分だけ送る", arguments: [nil, ""] as [String?])
    func unreadableFramesBelongToCurrentTarget(_ title: String?) async throws {
        let emitter = ScreenEventEmitter(bundleID: browser, writeStderr: { _ in })
        emitTab(emitter, at: 0, title: gmail, value: 30, image: "gmail")
        emitTab(emitter, at: 1, title: title, value: 200, image: "moving-old")
        emitTab(emitter, at: 2, title: title, value: 200, image: "unreadable-old")
        emitTab(emitter, at: 10.6, title: youtube, value: 200, image: "candidate")
        emitTab(emitter, at: 20.6, title: youtube, value: 200, image: "youtube")
        emitTab(emitter, at: 21, title: title, value: 30, image: "moving-new")
        emitTab(emitter, at: 22, title: title, value: 30, image: "unreadable-new")
        emitTab(emitter, at: 60, title: youtube, value: 30, image: "unchanged")
        #expect(try await drainTabs(emitter) == [imageScreen(20.6, "youtube"), imageScreen(21, "unreadable-new")])
    }

    @Test("覚え直し時の画像生成に失敗しても旧画像を復活させず、新対象を再試行する")
    func failedRetargetEncodeDoesNotRestoreOldBuffer() async throws {
        var writes: [String] = []
        let emitter = ScreenEventEmitter(bundleID: browser, writeStderr: { writes.append($0) })
        emitTab(emitter, at: 0, title: gmail, value: 100, image: "gmail")
        emitTab(emitter, at: 10.6, title: youtube, value: 100, image: "candidate")
        emitter.emit(tabFrame(20.6, youtube, 100)) { nil }
        #expect(writes.last == "会議のタブ: \(youtube)\n")
        emitTab(emitter, at: 20.85, title: youtube, value: 100, image: "retry")
        emitTab(emitter, at: 60, title: youtube, value: 100, image: "unchanged")
        #expect(try await drainTabs(emitter) == [imageScreen(20.85, "retry")])
    }

    @Test("確定フレームの画像生成が失敗しても保留画像を一度送り、次のフレームで生成を再試行する")
    func failedEncodeAtConfirmationStillFlushesBuffer() async throws {
        var writes: [String] = []
        let emitter = ScreenEventEmitter(bundleID: browser, writeStderr: { writes.append($0) })
        emitTab(emitter, at: 0, title: youtube, value: 30, image: "first")
        emitTab(emitter, at: 58.75, title: youtube, value: 30, image: "unchanged")
        emitTab(emitter, at: 59, title: youtube, value: 200, image: "moving")
        emitter.emit(tabFrame(60, youtube, 200)) { nil }
        #expect(writes == ["会議のタブ: \(youtube)\n", "会議のタブを確定しました: \(youtube)\n"])
        var iterator = emitter.events.makeAsyncIterator()
        let first = await iterator.next()
        #expect(try first.map { try TabScreen(event: $0) } == imageScreen(0, "first"))
        emitTab(emitter, at: 60.25, title: youtube, value: 200, image: "retry")
        #expect(try await drainTabs(emitter) == [imageScreen(59, "retry")])
    }

    @Test("Meetは仮の画像より先に即時送出し、closeで確定した仮の画像を一度だけ送る")
    func meetBypassesProvisionalBuffer() async throws {
        let emitter = ScreenEventEmitter(bundleID: browser, writeStderr: { _ in })
        emitTab(emitter, at: 0, title: gmail, value: 30, image: "gmail")
        emitTab(emitter, at: 1, title: "Meet - abc", value: 30, image: "meet")
        emitTab(emitter, at: 2, title: "Meet - abc", value: 30, image: "unchanged")
        var iterator = emitter.events.makeAsyncIterator()
        let first = await iterator.next()
        #expect(try first.map { try TabScreen(event: $0) } == imageScreen(1, "meet"))
        #expect(try await drainTabs(emitter) == [imageScreen(0, "gmail")])
    }

    @Test("非ブラウザと録画の空bundle IDは直ちに画像を送る", arguments: ["us.zoom.xos", "com.microsoft.teams2", ""])
    func nonBrowserAndRecordingRemainImmediate(_ bundleID: String) async throws {
        var writes: [String] = []
        let emitter = ScreenEventEmitter(bundleID: bundleID, writeStderr: { writes.append($0) })
        emitTab(emitter, at: 0, title: gmail, value: 100, image: "first")
        var iterator = emitter.events.makeAsyncIterator()
        let first = await iterator.next()
        #expect(try first.map { try TabScreen(event: $0) } == imageScreen(0, "first"))
        #expect(try await drainTabs(emitter) == [])
        #expect(writes.isEmpty)
    }
}

private enum TabTermination: String, CaseIterable, Sendable {
    case windowGone, captureStopped, close

    func apply(to emitter: ScreenEventEmitter) {
        switch self {
        case .windowGone: emitter.emitWindowGone(at: 30)
        case .captureStopped: emitter.emitCaptureStopped(at: 30)
        case .close: emitter.close()
        }
    }

    var tail: [TabScreen] {
        switch self {
        case .windowGone: [nullScreen(30)]
        case .captureStopped: [nullScreen(30), TabScreen(type: "screen-off", start: 30, image: nil, lines: nil, reason: "許可なし")]
        case .close: []
        }
    }
}

@Suite("仮の会議タブの早期確定", .timeLimit(.minutes(1)))
struct ScreenProvisionalTerminationTests {
    @Test("全終端は現対象の画像を先に送り、重複終端で画像と確定通知を再送しない", arguments: TabTermination.allCases)
    fileprivate func earlyTerminationFlushesCurrentTarget(_ end: TabTermination) async throws {
        var writes: [String] = []
        let emitter = ScreenEventEmitter(bundleID: browser, writeStderr: { writes.append($0) })
        emitTab(emitter, at: 0, title: gmail, value: 100, image: "gmail")
        emitTab(emitter, at: 10.6, title: youtube, value: 100, image: "candidate")
        emitTab(emitter, at: 20.6, title: youtube, value: 100, image: "youtube")
        end.apply(to: emitter)
        end.apply(to: emitter)
        #expect(writes == ["会議のタブ: \(gmail)\n", "会議のタブ: \(youtube)\n", "会議のタブを確定しました: \(youtube)\n"])
        #expect(try await drainTabs(emitter) == [imageScreen(20.6, "youtube")] + end.tail)
    }

    @Test("画像生成中に他スレッドから来る終端でも、画像の確定と送出を先に終える", arguments: TabTermination.allCases)
    fileprivate func terminationDuringEncodePreservesOrder(_ end: TabTermination) async throws {
        var writes: [String] = []
        let emitter = ScreenEventEmitter(bundleID: browser, writeStderr: { writes.append($0) })
        let started = DispatchSemaphore(value: 0)
        let finished = DispatchSemaphore(value: 0)
        emitter.emit(tabFrame(0, youtube, 100)) {
            Thread {
                started.signal()
                end.apply(to: emitter)
                finished.signal()
            }.start()
            #expect(started.wait(timeout: .now() + 5) == .success)
            return ScreenShot(image: "youtube", lines: ["youtube OCR"])
        }
        #expect(finished.wait(timeout: .now() + 5) == .success)
        #expect(try await drainTabs(emitter) == [imageScreen(0, "youtube")] + end.tail)
        #expect(writes == ["会議のタブ: \(youtube)\n", "会議のタブを確定しました: \(youtube)\n"])
    }

    @Test("不在の最中に早期確定しても、保留画像の後にnullを送り現在の不在状態を保つ")
    func earlyTerminationWhileAwayEndsWithNull() async throws {
        let emitter = ScreenEventEmitter(bundleID: browser, writeStderr: { _ in })
        emitTab(emitter, at: 0, title: youtube, value: 100, image: "youtube")
        emitTab(emitter, at: 1, title: gmail, value: 100, image: "forbidden")
        emitter.emitWindowGone(at: 5)
        let events = try await drainTabs(emitter)
        #expect(events.filter { $0.image != nil } == [imageScreen(0, "youtube")])
        #expect(events.last?.type == "screen")
        #expect(events.last?.image == nil)
    }

    @Test("覚え直した題名を不在イベントのJSONでサーバーへ渡す")
    func nullEventCarriesRetargetedTitle() async throws {
        let emitter = ScreenEventEmitter(bundleID: browser, writeStderr: { _ in })
        emitTab(emitter, at: 0, title: gmail, value: 100, image: "gmail")
        emitTab(emitter, at: 10.6, title: youtube, value: 100, image: "candidate")
        emitTab(emitter, at: 20.6, title: youtube, value: 100, image: "youtube")
        emitTab(emitter, at: 60, title: youtube, value: 100, image: "unchanged")
        emitTab(emitter, at: 61, title: gmail, value: 100, image: "forbidden")
        emitter.close()
        struct NoticeScreen: Decodable { let image: String?; let meetingTabTitle: String? }
        var absent: [NoticeScreen] = []
        for await event in emitter.events {
            let json = try JSONDecoder().decode(NoticeScreen.self, from: Data(event.jsonString().utf8))
            if json.image == nil { absent.append(json) }
        }
        #expect(absent.count == 1)
        #expect(absent.last?.meetingTabTitle == youtube)
    }
}
