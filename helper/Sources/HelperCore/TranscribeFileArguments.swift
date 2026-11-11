import Foundation

public struct TranscribeFileArguments: Equatable {
    public var file: String
    public var port: UInt16
    public var closeDeadline: Duration
    public var audioDir: String?
    public var selfFile: String?
    public var from: Double?
    public var selfFrom: Double?

    public init(file: String, port: UInt16 = defaultTranscribeFilePort, closeDeadline: Duration, audioDir: String? = nil, selfFile: String? = nil, from: Double? = nil, selfFrom: Double? = nil) {
        self.file = file
        self.port = port
        self.closeDeadline = closeDeadline
        self.audioDir = audioDir
        self.selfFile = selfFile
        self.from = from
        self.selfFrom = selfFrom
    }
}

public struct TranscribeFileArgumentsError: Error, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
}

public let defaultTranscribeFilePort: UInt16 = 8765

public func parseTranscribeFileArguments(_ arguments: [String]) -> Result<TranscribeFileArguments, TranscribeFileArgumentsError> {
    var file: String?
    var port = defaultTranscribeFilePort
    var closeDeadline: Duration?
    var audioDir: String?
    var selfFile: String?
    var from: Double?
    var selfFrom: Double?
    var index = 0
    while index < arguments.count {
        switch arguments[index] {
        case "--file" where index + 1 < arguments.count:
            file = arguments[index + 1]
            index += 2
        case "--self-file" where index + 1 < arguments.count:
            selfFile = arguments[index + 1]
            index += 2
        case "--audio-dir" where index + 1 < arguments.count:
            audioDir = arguments[index + 1]
            index += 2
        case "--from" where index + 1 < arguments.count:
            guard let value = Double(arguments[index + 1]), value.isFinite, value >= 0 else {
                return .failure(TranscribeFileArgumentsError("--from は 0 以上の秒数にする"))
            }
            from = value
            index += 2
        case "--self-from" where index + 1 < arguments.count:
            guard let value = Double(arguments[index + 1]), value.isFinite, value >= 0 else {
                return .failure(TranscribeFileArgumentsError("--self-from は 0 以上の秒数にする"))
            }
            selfFrom = value
            index += 2
        case "--port" where index + 1 < arguments.count:
            guard let value = UInt16(arguments[index + 1]) else {
                return .failure(TranscribeFileArgumentsError("--port は 0〜65535 の整数にする"))
            }
            port = value
            index += 2
        case "--close-deadline-ms" where index + 1 < arguments.count:
            guard let value = Int64(arguments[index + 1]), value >= 0 else {
                return .failure(TranscribeFileArgumentsError("--close-deadline-ms は 0 以上の整数にする"))
            }
            closeDeadline = .milliseconds(value)
            index += 2
        default:
            return .failure(TranscribeFileArgumentsError("不明な引数: \(arguments[index])"))
        }
    }
    guard let file else {
        return .failure(TranscribeFileArgumentsError("--file が必要"))
    }
    if selfFrom != nil, selfFile == nil {
        return .failure(TranscribeFileArgumentsError("--self-from には --self-file が必要"))
    }
    guard let closeDeadline else {
        return .failure(TranscribeFileArgumentsError("--close-deadline-ms が必要"))
    }
    return .success(TranscribeFileArguments(file: file, port: port, closeDeadline: closeDeadline, audioDir: audioDir, selfFile: selfFile, from: from, selfFrom: selfFrom))
}
