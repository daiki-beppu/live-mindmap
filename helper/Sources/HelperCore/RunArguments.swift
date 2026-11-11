import Foundation

public struct RunArguments: Equatable {
    public var app: String
    public var port: UInt16
    public var closeDeadline: Duration
    public var audioDir: String?
    public var origin: UInt64?
    public var audioIndex: Int
    public var noScreen: Bool
    public var selfPauseCarryOver: SelfPauseCarryOver

    public init(app: String, port: UInt16 = 8765, closeDeadline: Duration, audioDir: String? = nil, origin: UInt64? = nil, audioIndex: Int = 1, noScreen: Bool = false, selfPauseCarryOver: SelfPauseCarryOver = .initial) {
        self.app = app
        self.port = port
        self.closeDeadline = closeDeadline
        self.audioDir = audioDir
        self.origin = origin
        self.audioIndex = audioIndex
        self.noScreen = noScreen
        self.selfPauseCarryOver = selfPauseCarryOver
    }
}

public struct RunArgumentsError: Error, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
}

private let defaultRunPort: UInt16 = 8765

public func parseRunArguments(_ arguments: [String]) -> Result<RunArguments, RunArgumentsError> {
    var app: String?
    var port = defaultRunPort
    var closeDeadline: Duration?
    var audioDir: String?
    var origin: UInt64?
    var audioIndex = 1
    var noScreen = false
    var carryOver = SelfPauseCarryOver.initial
    var index = 0
    while index < arguments.count {
        switch arguments[index] {
        case "--app" where index + 1 < arguments.count:
            app = arguments[index + 1]
            index += 2
        case "--port" where index + 1 < arguments.count:
            guard let value = UInt16(arguments[index + 1]) else {
                return .failure(RunArgumentsError("--port は 0〜65535 の整数にする"))
            }
            port = value
            index += 2
        case "--audio-dir" where index + 1 < arguments.count:
            audioDir = arguments[index + 1]
            index += 2
        case "--close-deadline-ms" where index + 1 < arguments.count:
            guard let value = Int64(arguments[index + 1]), value >= 0 else {
                return .failure(RunArgumentsError("--close-deadline-ms は 0 以上の整数にする"))
            }
            closeDeadline = .milliseconds(value)
            index += 2
        case "--origin" where index + 1 < arguments.count:
            guard let value = UInt64(arguments[index + 1]) else {
                return .failure(RunArgumentsError("--origin は 0 以上の整数にする"))
            }
            origin = value
            index += 2
        case "--audio-index" where index + 1 < arguments.count:
            guard let value = Int(arguments[index + 1]), value >= 1 else {
                return .failure(RunArgumentsError("--audio-index は 1 以上の整数にする"))
            }
            audioIndex = value
            index += 2
        case "--no-screen":
            noScreen = true
            index += 1
        case "--self-manual" where index + 1 < arguments.count:
            guard let value = SelfPauseManual(rawValue: arguments[index + 1]), value != .none else {
                return .failure(RunArgumentsError("--self-manual は pause か take にする"))
            }
            carryOver.manual = value
            index += 2
        case "--self-basis" where index + 1 < arguments.count:
            guard let value = InputJudgement(rawValue: arguments[index + 1]), value != .unknown else {
                return .failure(RunArgumentsError("--self-basis は using か idle にする"))
            }
            carryOver.basis = value
            index += 2
        case "--self-last-known" where index + 1 < arguments.count:
            guard let value = InputJudgement(rawValue: arguments[index + 1]), value != .unknown else {
                return .failure(RunArgumentsError("--self-last-known は using か idle にする"))
            }
            carryOver.lastKnown = value
            index += 2
        case "--self-idle-for" where index + 1 < arguments.count:
            guard let value = Double(arguments[index + 1]), value.isFinite, value >= 0 else {
                return .failure(RunArgumentsError("--self-idle-for は 0 以上の数にする"))
            }
            carryOver.idleFor = value
            index += 2
        default:
            return .failure(RunArgumentsError("不明な引数: \(arguments[index])"))
        }
    }
    guard let app else {
        return .failure(RunArgumentsError("--app が必要"))
    }
    guard let closeDeadline else {
        return .failure(RunArgumentsError("--close-deadline-ms が必要"))
    }
    return .success(RunArguments(app: app, port: port, closeDeadline: closeDeadline, audioDir: audioDir, origin: origin, audioIndex: audioIndex, noScreen: noScreen, selfPauseCarryOver: carryOver))
}
