import Darwin

public let microphoneConfigurationChangedExitCode = Int32(EX_TEMPFAIL)

public func exitCode(for error: Error) -> Int32 {
    if let microphoneError = error as? MicrophoneError, case .configurationChanged = microphoneError {
        return microphoneConfigurationChangedExitCode
    }
    return 1
}
