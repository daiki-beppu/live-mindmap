import Foundation

// `transcribe-file` サブコマンドの引数の解釈。純粋関数にして `HelperCoreTests` から検証できるようにする
// （`live-mindmap-helper` の実行ターゲットにはテストターゲットがないため）。流儀は `parseRunArguments` と同じ。

/// `transcribe-file` サブコマンドの引数を解釈した結果。
public struct TranscribeFileArguments: Equatable {
    public var file: String
    public var port: UInt16
    /// ファイルの音声を `相手.m4a` として書く先のフォルダ。省略したら音声を書かない。
    public var audioDir: String?

    public init(file: String, port: UInt16 = defaultTranscribeFilePort, audioDir: String? = nil) {
        self.file = file
        self.port = port
        self.audioDir = audioDir
    }
}

public struct TranscribeFileArgumentsError: Error, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
}

/// `run` と同じ。サーバーは `Helpers.launch` で `--port` を足して起動する。
public let defaultTranscribeFilePort: UInt16 = 8765

/// `arguments` は `transcribe-file` の語の後に続く引数の列（`--file`・`--port`・`--audio-dir` とその値）。
public func parseTranscribeFileArguments(_ arguments: [String]) -> Result<TranscribeFileArguments, TranscribeFileArgumentsError> {
    var file: String?
    var port = defaultTranscribeFilePort
    var audioDir: String?
    var index = 0
    while index < arguments.count {
        switch arguments[index] {
        case "--file" where index + 1 < arguments.count:
            file = arguments[index + 1]
            index += 2
        case "--audio-dir" where index + 1 < arguments.count:
            audioDir = arguments[index + 1]
            index += 2
        case "--port" where index + 1 < arguments.count:
            guard let value = UInt16(arguments[index + 1]) else {
                return .failure(TranscribeFileArgumentsError("--port は 0〜65535 の整数にする"))
            }
            port = value
            index += 2
        default:
            return .failure(TranscribeFileArgumentsError("不明な引数: \(arguments[index])"))
        }
    }
    guard let file else {
        return .failure(TranscribeFileArgumentsError("--file が必要"))
    }
    return .success(TranscribeFileArguments(file: file, port: port, audioDir: audioDir))
}
