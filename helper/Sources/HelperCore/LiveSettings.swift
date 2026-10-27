import Foundation

public enum LiveSessionDiagnostic {
    case tapDevices(String)
    case echoCancellationEnabled
    case screenDenied
    case controlDisabled
}

public struct LiveSettings {
    public struct Recording {
        public let directory: URL
        public let attempt: Int

        public init(directory: URL, attempt: Int) {
            self.directory = directory
            self.attempt = attempt
        }
    }

    public let bundleID: String
    public let ownPID: Int32
    public let port: UInt16
    public let origin: UInt64?
    public let recording: Recording?
    public let marksDuplicates: Bool
    public let selfPauseCarryOver: SelfPauseCarryOver
    public let controlToken: String?
    public let log: (LiveSessionDiagnostic) -> Void

    public init(
        bundleID: String, ownPID: Int32, port: UInt16, origin: UInt64?, recording: Recording?,
        marksDuplicates: Bool, selfPauseCarryOver: SelfPauseCarryOver, controlToken: String?,
        log: @escaping (LiveSessionDiagnostic) -> Void
    ) {
        self.bundleID = bundleID
        self.ownPID = ownPID
        self.port = port
        self.origin = origin
        self.recording = recording
        self.marksDuplicates = marksDuplicates
        self.selfPauseCarryOver = selfPauseCarryOver
        self.controlToken = controlToken
        self.log = log
    }
}
