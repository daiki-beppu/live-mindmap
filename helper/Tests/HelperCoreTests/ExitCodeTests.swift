import Foundation
import Testing
@testable import HelperCore

@Suite("終了コード", .timeLimit(.minutes(1)))
struct ExitCodeTests {
    private struct UnrelatedError: Error {}

    @Test("構成の変化の終了コードは 75（サーバーの定数と合わせる）")
    func configurationChangedExitCodeIsFixed() {
        #expect(microphoneConfigurationChangedExitCode == 75)
    }

    @Test("MicrophoneError.configurationChanged は構成の変化の終了コードになる")
    func configurationChangedMapsToConfigurationChangedExitCode() {
        #expect(exitCode(for: MicrophoneError.configurationChanged) == microphoneConfigurationChangedExitCode)
        #expect(exitCode(for: MicrophoneError.configurationChanged) == 75)
    }

    @Test("ほかのマイクのエラーは 1")
    func otherMicrophoneErrorsMapToOne() {
        #expect(exitCode(for: MicrophoneError.permissionDenied) == 1)
        #expect(exitCode(for: MicrophoneError.invalidInputFormat) == 1)
        #expect(exitCode(for: MicrophoneError.backlogExceeded(limit: 1)) == 1)
    }

    @Test("マイク以外の型のエラーは 1")
    func unrelatedErrorsMapToOne() {
        #expect(exitCode(for: UnrelatedError()) == 1)
        #expect(exitCode(for: CocoaError(.fileNoSuchFile)) == 1)
    }
}
