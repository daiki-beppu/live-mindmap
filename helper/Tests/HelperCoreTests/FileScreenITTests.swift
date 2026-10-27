import AVFoundation
import Foundation
import Testing
@testable import HelperCore

@Suite("録画の映像読み手の取り消し", .timeLimit(.minutes(1)))
struct FileScreenITTests {
    /// 取り消し（`cancel()`）は、どのスレッドから呼ばれても、その場で AVAssetReader に触れない（Issue #1198）。
    /// 読み出しのキューが `next()` で塞がっている間に別のスレッドから `cancelReading` が入ると、MediaToolbox の中で落ちる。
    /// キューを塞いだまま取り消し、読み手がまだ読み出し中であることを見る。キューが空いた後の `next()` は nil で、読み手は止まっている。
    @Test("読み出しのキューが塞がっている間に取り消しても、AVAssetReader はその場で止まらない。キューが空いた後の next() は nil で、読み手は止まっている")
    func cancelTouchesReaderOnlyOnScreenQueue() async throws {
        let dir = try FileAudioTestSupport.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let movie = try await FileScreenTestSupport.makeMovie(in: dir, video: .black)
        guard case .reading(let reading) = await FileScreenReading.open(movie) else {
            Issue.record("映像を読み始められない")
            return
        }

        let held = DispatchSemaphore(value: 0)
        fileScreenQueue.async { held.wait() }
        reading.cancel()
        #expect(reading.readerStatus == .reading, "取り消した側のスレッドで AVAssetReader が止められた")
        held.signal()

        let step = await onFileScreenQueue { reading.step() }
        guard case .end = step else {
            Issue.record("取り消した後の step() は .end のはず")
            return
        }
        #expect(await onFileScreenQueue { reading.readerStatus } == .cancelled)
    }
}
