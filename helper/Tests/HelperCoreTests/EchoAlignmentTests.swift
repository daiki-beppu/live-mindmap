import Foundation
import Testing
@testable import HelperCore

// 参照（タップ）とマイクを hostTime で揃える状態機械。I/O を持たないので、差し替えの canceller の呼び出し順で確かめる。
// 参照の区切り j は全サンプルが Float(j + 1)、無音で埋めた区切りは 0。区切り j の開始時刻は base + 10 ms × j。

private let base: UInt64 = 1_000_000_000

@Suite("エコーキャンセルの時刻合わせ", .timeLimit(.minutes(1)))
struct EchoAlignmentTests {
    @Test("参照がマイクより 90 ms 早く始まるとき、各 capture の前に、その時刻までの参照が欠けも重複もなく reverse に渡される")
    func referenceLeadsMicrophoneByNinetyMilliseconds() {
        let canceller = RecordingEchoCanceller()
        var aligner = EchoAligner(canceller: canceller)
        aligner.addReference(referenceSamples(chunks: 0..<20), hostTime: base)
        aligner.addCapture(captureSamples(chunks: 9..<14), hostTime: base + hostTicks(milliseconds: 90))

        _ = aligner.drain(force: false)

        let events = canceller.events
        let reverseTags = reverseFrames(events).compactMap { uniformValue($0) }
        #expect(reverseTags.count == reverseFrames(events).count)
        // 参照は先頭から 1 区切りずつ、飛ばさず繰り返さず渡る
        #expect(reverseTags == (1...reverseTags.count).map { Float($0) })
        // k 番目の capture（時刻 90 + 10k ms）の前には、その時刻までに終わった参照 9 + k 区切りがすべて渡り、
        // それより先の参照（11 + k 区切り以降）は渡らない。先頭どうしで揃えると、最初の capture の前の reverse は 1 回になる
        let counts = reverseCountsBeforeEachCapture(events)
        #expect(counts.count == 5)
        for (k, count) in counts.enumerated() {
            #expect(count >= 9 + k, "capture \(k) の前の reverse の回数")
            #expect(count <= 10 + k, "capture \(k) の前の reverse の回数")
        }
        #expect(captureFrames(events).compactMap { uniformValue($0) } == (9..<14).map { captureValue(chunk: $0) })
    }

    @Test("参照が届いていない間は capture を呼ばず保留し、届いたあとで reverse → capture の順に処理する")
    func holdsCaptureUntilReferenceArrives() {
        let canceller = RecordingEchoCanceller()
        var aligner = EchoAligner(canceller: canceller)
        aligner.addCapture(captureSamples(chunks: 0..<5), hostTime: base)

        let heldOutput = aligner.drain(force: false)
        #expect(canceller.events.isEmpty)
        #expect(heldOutput.isEmpty)

        aligner.addReference(referenceSamples(chunks: 0..<10), hostTime: base)
        let output = aligner.drain(force: false)

        let events = canceller.events
        #expect(captureFrames(events).count == 5)
        #expect(output.flatMap(\.samples).count == 5 * echoTestFrameSamples)
        // 参照は本物の区切り（無音でない）が先に渡っている
        #expect(reverseFrames(events).allSatisfy { uniformValue($0) != 0 })
        if case .reverse? = events.first {} else { Issue.record("最初の呼び出しが reverse ではない: \(String(describing: events.first))") }
    }

    @Test("参照がマイクより 50 ms 遅れて始まるとき、参照が始まる前のマイクの区間も、無音の reverse を渡してから capture を呼ぶ")
    func fillsSilenceBeforeReferenceThatStartsAfterMicrophone() {
        let canceller = RecordingEchoCanceller()
        var aligner = EchoAligner(canceller: canceller)
        aligner.addReference(referenceSamples(chunks: 0..<10), hostTime: base + hostTicks(milliseconds: 50))
        aligner.addCapture(captureSamples(chunks: 0..<8), hostTime: base)
        _ = aligner.drain(force: false)

        let events = canceller.events
        let counts = reverseCountsBeforeEachCapture(events)
        #expect(counts.count == 8)
        // どの capture の前にも、reverse が 1 回以上渡っている
        #expect(counts.allSatisfy { $0 >= 1 })
        // 参照が始まる前（最初の 5 区間）は無音、始まったあとは本物の参照
        let reverses = reverseFrames(events)
        #expect(reverses.prefix(5).allSatisfy { uniformValue($0) == 0 })
        #expect(reverses.dropFirst(5).allSatisfy { uniformValue($0) != 0 })
    }

    @Test("参照がマイクより 10 ms 未満（5 ms）遅れて始まるとき、最初の capture の前に無音の reverse を渡し、その後は本物の参照を渡す")
    func fillsSilenceBeforeReferenceThatStartsLessThanOneFrameLate() {
        let canceller = RecordingEchoCanceller()
        var aligner = EchoAligner(canceller: canceller)
        aligner.addReference(referenceSamples(chunks: 0..<10), hostTime: base + hostTicks(milliseconds: 5))
        aligner.addCapture(captureSamples(chunks: 0..<8), hostTime: base)
        _ = aligner.drain(force: false)

        let events = canceller.events
        if case .reverse(let first)? = events.first {
            #expect(uniformValue(first) == 0)
        } else {
            Issue.record("最初の呼び出しが reverse ではない: \(String(describing: events.first))")
        }
        #expect(reverseCountsBeforeEachCapture(events) == [1, 2, 3, 4, 5, 6, 7, 8])
        #expect(reverseFrames(events).dropFirst().compactMap { uniformValue($0) } == (1...7).map { Float($0) })
    }

    @Test("参照の流れが終わったあとは、足りない参照を無音（すべて 0）の reverse で埋めてから capture を呼ぶ")
    func fillsMissingReferenceWithSilenceAfterReferenceFinished() {
        let canceller = RecordingEchoCanceller()
        var aligner = EchoAligner(canceller: canceller)
        aligner.addReference(referenceSamples(chunks: 0..<5), hostTime: base)
        aligner.addCapture(captureSamples(chunks: 0..<10), hostTime: base)
        aligner.referenceFinished()

        _ = aligner.drain(force: false)

        let events = canceller.events
        let reverses = reverseFrames(events)
        #expect(captureFrames(events).count == 10)
        #expect(Array(reverses.prefix(5)).compactMap { uniformValue($0) } == [1, 2, 3, 4, 5])
        #expect(reverses.count > 5)
        #expect(reverses.dropFirst(5).allSatisfy { $0.allSatisfy { $0 == 0 } })
        // k 番目の capture（時刻 10k ms）の前には、その時刻までの参照（本物と無音の合計）が k 区切り以上渡っている
        for (k, count) in reverseCountsBeforeEachCapture(events).enumerated() {
            #expect(count >= k, "capture \(k) の前の reverse の回数")
        }
    }

    @Test("参照が一度も届かないまま強制的に処理するときも、最初の capture の前に無音の reverse を渡す")
    func fillsSilenceBeforeFirstCaptureWhenReferenceNeverArrived() {
        let canceller = RecordingEchoCanceller()
        var aligner = EchoAligner(canceller: canceller)
        aligner.addCapture(captureSamples(chunks: 0..<3), hostTime: base)

        _ = aligner.drain(force: true)

        let events = canceller.events
        #expect(captureFrames(events).count == 3)
        #expect(reverseCountsBeforeEachCapture(events).allSatisfy { $0 >= 1 })
        #expect(reverseFrames(events).allSatisfy { $0.allSatisfy { $0 == 0 } })
    }

    @Test("参照がマイクより 500 ms を超えて届かないとき、流れが終わっていなくても無音で埋めて処理を進める")
    func fillsSilenceWhenReferenceIsMissingForTooLong() {
        let canceller = RecordingEchoCanceller()
        var aligner = EchoAligner(canceller: canceller)
        // 1 秒分のマイク。参照は届かない
        aligner.addCapture(captureSamples(chunks: 0..<100), hostTime: base)

        let output = aligner.drain(force: false)

        let events = canceller.events
        #expect(!output.isEmpty)
        #expect(!captureFrames(events).isEmpty)
        #expect(reverseFrames(events).allSatisfy { $0.allSatisfy { $0 == 0 } })
    }

    @Test("無音で埋めた範囲より前の時刻の参照が後から届いても、reverse に渡さない")
    func discardsReferenceOlderThanSilenceAlreadyFilled() {
        let canceller = RecordingEchoCanceller()
        var aligner = EchoAligner(canceller: canceller)
        aligner.addCapture(captureSamples(chunks: 0..<10), hostTime: base)
        _ = aligner.drain(force: true)
        #expect(!captureFrames(canceller.events).isEmpty)

        // すでに無音で埋めた 0〜100 ms の参照が遅れて届く。続きのマイクを処理する
        aligner.addReference(referenceSamples(chunks: 0..<10), hostTime: base)
        aligner.addCapture(captureSamples(chunks: 10..<12), hostTime: base + hostTicks(milliseconds: 100))
        _ = aligner.drain(force: true)

        #expect(reverseFrames(canceller.events).allSatisfy { $0.allSatisfy { $0 == 0 } })
        #expect(captureFrames(canceller.events).count == 12)
    }

    @Test("出力の最初のサンプルの hostTime は、入力の最初のマイクの hostTime のまま。サンプルは AEC の処理結果")
    func outputKeepsFirstMicrophoneHostTime() throws {
        let canceller = RecordingEchoCanceller()
        var aligner = EchoAligner(canceller: canceller)
        // 参照の区切りとは 10 ms の境に合わない時刻（123 ms）でマイクが始まる
        let micStart = base + hostTicks(milliseconds: 123)
        aligner.addReference(referenceSamples(chunks: 0..<30), hostTime: base)
        let input = captureSamples(chunks: 0..<4)
        aligner.addCapture(input, hostTime: micStart)

        let output = aligner.drain(force: false)

        #expect(try #require(output.first).hostTime == micStart)
        #expect(output.flatMap(\.samples) == input.map { $0 * 0.5 })
    }

    @Test("480 サンプルに満たない入力は次の入力へ持ち越し、480 サンプルそろった分だけ処理する")
    func carriesOverPartialFrames() {
        let canceller = RecordingEchoCanceller()
        var aligner = EchoAligner(canceller: canceller)
        aligner.addReference(referenceSamples(chunks: 0..<30), hostTime: base)
        let input = captureSamples(chunks: 0..<3)  // 1440 サンプル

        aligner.addCapture(Array(input[0..<700]), hostTime: base)
        aligner.addCapture(Array(input[700..<960]), hostTime: base + hostTicks(milliseconds: 700.0 / 48))
        let first = aligner.drain(force: false)
        #expect(captureFrames(canceller.events).count == 2)
        #expect(first.flatMap(\.samples).count == 2 * echoTestFrameSamples)

        aligner.addCapture(Array(input[960..<1440]), hostTime: base + hostTicks(milliseconds: 20))
        let second = aligner.drain(force: false)
        #expect(captureFrames(canceller.events).count == 3)
        #expect(second.flatMap(\.samples).count == echoTestFrameSamples)
    }
}
