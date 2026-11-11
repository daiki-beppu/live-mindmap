import AVFoundation
import Foundation
import Testing
@testable import HelperCore

private extension FileScreenReader {
    func holdExecutor(entered: GateFlag, release: DispatchSemaphore) -> Bool {
        entered.raise()
        let released = release.wait(timeout: .now() + .seconds(30))
        #expect(readerStatus == .reading)
        return released == .success
    }
}

@Suite("録画の映像読み手の独立性と取り消し", .timeLimit(.minutes(1)))
struct FileScreenITTests {
    @Test("一方の読み手が executor を占有していても、もう一方はフレームを読める")
    func blockedReaderDoesNotBlockAnotherReader() async throws {
        let dir = try FileAudioTestSupport.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let movie = try await FileScreenTestSupport.makeMovie(in: dir, video: .black)
        guard case .reading(let first) = await FileScreenReader.open(movie) else {
            Issue.record("最初の映像読み手を開始できない")
            return
        }
        guard case .reading(let second) = await FileScreenReader.open(movie) else {
            await first.cancel()
            Issue.record("もう一方の映像読み手を開始できない")
            return
        }

        let entered = GateFlag()
        let release = DispatchSemaphore(value: 0)
        let holding = Task { await first.holdExecutor(entered: entered, release: release) }
        defer { release.signal() }
        do {
            try await gateWaitUntil("最初の読み手が executor を占有する") { entered.isRaised }
            let stepped = GateFlag()
            let reading = Task {
                if case .end = await second.step() { Issue.record("最初のフレームを読まずに終了した") }
                stepped.raise()
            }
            defer { reading.cancel() }
            try await gateWaitUntil("最初の読み手を解放する前に、もう一方がフレームを読む") { stepped.isRaised }
            await reading.value
        } catch {
            release.signal()
            _ = await holding.value
            await first.cancel()
            await second.cancel()
            throw error
        }
        release.signal()
        #expect(await holding.value)
        await first.cancel()
        await second.cancel()
    }

    @Test("executor の占有中は取り消しが reader に触れず、解放後に取り消しが完了し、同じ読み手は終端を返す")
    func cancelTouchesReaderOnlyOnScreenQueue() async throws {
        let dir = try FileAudioTestSupport.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let movie = try await FileScreenTestSupport.makeMovie(in: dir, video: .black)
        guard case .reading(let reading) = await FileScreenReader.open(movie) else {
            Issue.record("映像を読み始められない")
            return
        }

        if case .end = await reading.step() { Issue.record("取り消す前に最初のフレームを読めない") }
        let entered = GateFlag()
        let release = DispatchSemaphore(value: 0)
        let holding = Task { await reading.holdExecutor(entered: entered, release: release) }
        defer { release.signal() }
        do {
            try await gateWaitUntil("読み手が executor を占有する") { entered.isRaised }
            let requested = GateFlag()
            let cancelling = Task {
                requested.raise()
                await reading.cancel()
            }
            try await gateWaitUntil("別のタスクが取り消しを要求する") { requested.isRaised }
            release.signal()
            #expect(await holding.value)
            await cancelling.value
        } catch {
            release.signal()
            _ = await holding.value
            await reading.cancel()
            throw error
        }

        #expect(await reading.readerStatus == .cancelled)
        let step = await reading.step()
        guard case .end = step else {
            Issue.record("取り消した後の step() は .end のはず")
            return
        }
    }
}
