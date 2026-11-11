import Foundation

public struct MixArguments: Equatable {
    public var session: String
    public var out: String
    public var track: Track?

    public init(session: String, out: String, track: Track? = nil) {
        self.session = session
        self.out = out
        self.track = track
    }
}

public func parseMixArguments(_ arguments: [String]) -> Result<MixArguments, RunArgumentsError> {
    var session: String?
    var out: String?
    var track: Track?
    var index = 0
    while index < arguments.count {
        switch arguments[index] {
        case "--session" where index + 1 < arguments.count:
            session = arguments[index + 1]
            index += 2
        case "--out" where index + 1 < arguments.count:
            out = arguments[index + 1]
            index += 2
        case "--track" where index + 1 < arguments.count:
            guard arguments[index + 1] == Track.自分.rawValue else {
                return .failure(RunArgumentsError("--track に指定できるのは 自分 だけ"))
            }
            track = .自分
            index += 2
        default:
            return .failure(RunArgumentsError("不明な引数: \(arguments[index])"))
        }
    }
    guard let session else { return .failure(RunArgumentsError("--session が必要")) }
    guard let out else { return .failure(RunArgumentsError("--out が必要")) }
    return .success(MixArguments(session: session, out: out, track: track))
}
