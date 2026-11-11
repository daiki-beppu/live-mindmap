public let microphoneConfigurationChangedExitCode: Int32 = 75

public func exitCode(for error: Error) -> Int32 {
    if let microphoneError = error as? MicrophoneError, case .configurationChanged = microphoneError {
        return microphoneConfigurationChangedExitCode
    }
    return 1
}
