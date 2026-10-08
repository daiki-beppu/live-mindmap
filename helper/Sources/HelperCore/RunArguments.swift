import Foundation

// `run` サブコマンドの引数の解釈。純粋関数にして `HelperCoreTests` から検証できるようにする
// （`live-mindmap-helper` の実行ターゲットにはテストターゲットがないため）。Issue #161。

/// `run` サブコマンドの引数を解釈した結果。
public struct RunArguments: Equatable {
    public var app: String
    public var port: UInt16
    public var audioDir: String?
    public var origin: UInt64?
    public var audioIndex: Int
    /// 共有画面を取り込まない（`--no-screen`。値は取らない）。既定は取り込む。
    public var noScreen: Bool

    public init(app: String, port: UInt16 = 8765, audioDir: String? = nil, origin: UInt64? = nil, audioIndex: Int = 1, noScreen: Bool = false) {
        self.app = app
        self.port = port
        self.audioDir = audioDir
        self.origin = origin
        self.audioIndex = audioIndex
        self.noScreen = noScreen
    }
}

public struct RunArgumentsError: Error, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
}

private let defaultRunPort: UInt16 = 8765

/// `arguments` は `run` サブコマンドの語の後に続く引数の列（`--app` などのフラグと値）。
public func parseRunArguments(_ arguments: [String]) -> Result<RunArguments, RunArgumentsError> {
    var app: String?
    var port = defaultRunPort
    var audioDir: String?
    var origin: UInt64?
    var audioIndex = 1
    var noScreen = false
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
        default:
            return .failure(RunArgumentsError("不明な引数: \(arguments[index])"))
        }
    }
    guard let app else {
        return .failure(RunArgumentsError("--app が必要"))
    }
    return .success(RunArguments(app: app, port: port, audioDir: audioDir, origin: origin, audioIndex: audioIndex, noScreen: noScreen))
}
