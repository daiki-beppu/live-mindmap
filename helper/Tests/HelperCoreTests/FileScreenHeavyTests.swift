import Foundation
import Testing

@Suite("録画の動画の文字を共有画面へ送る", .timeLimit(.minutes(2)))
struct FileScreenHeavyTests {
    @Test("動画に描いた文字（港南店・Zendesk）が、画像のある screen の lines に届く")
    func drawnTextReachesScreenLines() async throws {
        let dir = try FileAudioTestSupport.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let movie = try await FileScreenTestSupport.makeMovie(in: dir, video: .text(["港南店", "Zendesk"]))

        let shown = FileScreenTestSupport.screens(in: try await FileScreenTestSupport.collect(movie)).filter { $0.image != nil }

        #expect(!shown.isEmpty)
        let joined = shown.flatMap { $0.lines ?? [] }.joined(separator: "\n")
        #expect(joined.contains("港南店"), "lines: \(joined)")
        #expect(joined.contains("Zendesk"), "lines: \(joined)")
    }
}
