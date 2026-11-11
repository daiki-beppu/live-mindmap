import Foundation

public struct AudioProcess: Sendable, Equatable {
    public var objectID: UInt32
    public var bundleID: String
    public var isRunningOutput: Bool

    public init(objectID: UInt32, bundleID: String, isRunningOutput: Bool) {
        self.objectID = objectID
        self.bundleID = bundleID
        self.isRunningOutput = isRunningOutput
    }
}

public struct RunningApp: Sendable, Equatable {
    public var bundleID: String
    public var name: String

    public init(bundleID: String, name: String) {
        self.bundleID = bundleID
        self.name = name
    }
}

public struct MeetingApp: Sendable, Equatable, Encodable {
    public var bundleID: String
    public var name: String

    public init(bundleID: String, name: String) {
        self.bundleID = bundleID
        self.name = name
    }
}

public enum MeetingAppError: Error, Equatable, CustomStringConvertible {
    case noMatchingProcess(bundleID: String)

    public var description: String {
        switch self {
        case .noMatchingProcess(let bundleID):
            return "\(bundleID) に合う音声プロセスがない。Mac 全体のタップには切り替えない"
        }
    }
}

func belongs(_ processBundleID: String, toApp appBundleID: String) -> Bool {
    processBundleID == appBundleID || processBundleID.hasPrefix(appBundleID + ".")
}

public func meetingApps(audioProcesses: [AudioProcess], runningApps: [RunningApp]) -> [MeetingApp] {
    var result: [MeetingApp] = []
    for process in audioProcesses where process.isRunningOutput {
        let owner = runningApps
            .filter { belongs(process.bundleID, toApp: $0.bundleID) }
            .max { $0.bundleID.count < $1.bundleID.count }
        guard let owner, !result.contains(where: { $0.bundleID == owner.bundleID }) else { continue }
        result.append(MeetingApp(bundleID: owner.bundleID, name: owner.name))
    }
    return result
}

public func tapTargets(forApp bundleID: String, in audioProcesses: [AudioProcess]) throws -> [AudioProcess] {
    let targets = audioProcesses.filter { belongs($0.bundleID, toApp: bundleID) }
    guard !targets.isEmpty else { throw MeetingAppError.noMatchingProcess(bundleID: bundleID) }
    return targets
}
