import Testing
@testable import HelperCore

// Issue #161: 起動し直すたびに録音ファイルの番号を増やす（CT-AUDIO-NAME）。1 回目の名前は変えない（order.md:68）。
@Suite("録音ファイルの名前（起動し直しの番号）")
struct RecordingFileNameTests {
    @Test("1 回目（attempt == 1）は番号を付けない")
    func firstAttemptHasNoSuffix() {
        #expect(recordingFileName(track: .相手, attempt: 1) == "相手.m4a")
        #expect(recordingFileName(track: .自分, attempt: 1) == "自分.m4a")
    }

    @Test("2 回目以降は -N の番号が付く")
    func laterAttemptsAreSuffixed() {
        #expect(recordingFileName(track: .相手, attempt: 2) == "相手-2.m4a")
        #expect(recordingFileName(track: .自分, attempt: 3) == "自分-3.m4a")
    }

    @Test("同じ attempt なら、両トラックで番号が揃う")
    func sameAttemptSameSuffixAcrossTracks() {
        #expect(recordingFileName(track: .相手, attempt: 5).hasSuffix("-5.m4a"))
        #expect(recordingFileName(track: .自分, attempt: 5).hasSuffix("-5.m4a"))
    }
}
