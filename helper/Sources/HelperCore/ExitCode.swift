/// マイクの入力の構成の変化（`MicrophoneError.configurationChanged`）で `run` が終わるときの終了コード。
/// BSD の sysexits.h の `EX_TEMPFAIL`（一時的な失敗。やり直すよう促す）で、「起動し直せば新しい機器で取り込める」という意味に合う。
/// サーバーの `HELPER_EXIT_CONFIGURATION_CHANGED`（server/src/core/intake.ts）と同じ値にそろえる（両側のテストで値を固定している）。
public let microphoneConfigurationChangedExitCode: Int32 = 75

/// `run` が throw したエラーから、ヘルパーの終了コードを決める。
/// 構成の変化は `microphoneConfigurationChangedExitCode`、それ以外のエラーは 1（使い方の誤りの 2 は `main` が直接返す）。
public func exitCode(for error: Error) -> Int32 {
    if let microphoneError = error as? MicrophoneError, case .configurationChanged = microphoneError {
        return microphoneConfigurationChangedExitCode
    }
    return 1
}
