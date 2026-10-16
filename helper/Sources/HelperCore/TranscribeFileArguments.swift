import Foundation

// `transcribe-file` サブコマンドの引数の解釈。純粋関数にして `HelperCoreTests` から検証できるようにする
// （`live-mindmap-helper` の実行ターゲットにはテストターゲットがないため）。流儀は `parseRunArguments` と同じ。

/// `transcribe-file` サブコマンドの引数を解釈した結果。
public struct TranscribeFileArguments: Equatable {
    public var file: String
    public var port: UInt16
    /// ファイルの音声を `相手.m4a`（`selfFile` があれば `自分.m4a` も）として書く先のフォルダ。省略したら音声を書かない。
    public var audioDir: String?
    /// 自分用の録音のファイル（`cli recorded --self`）。`file` は相手用のまま。省略したら 1 本だけを `相手` として文字にする。
    public var selfFile: String?
    /// `file`（相手）の読み始める音声の時刻（ファイルの先頭からの秒）。省略したら先頭から。サーバーが起動し直すとき、そのトラックで最後に作った発言の `end` を渡す。
    public var from: Double?
    /// `selfFile`（自分）の読み始める音声の時刻。省略したら先頭から。`selfFile` があるときだけ指定できる。
    public var selfFrom: Double?

    public init(file: String, port: UInt16 = defaultTranscribeFilePort, audioDir: String? = nil, selfFile: String? = nil, from: Double? = nil, selfFrom: Double? = nil) {
        self.file = file
        self.port = port
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

/// `run` と同じ。サーバーは `Helpers.launch` で `--port` を足して起動する。
public let defaultTranscribeFilePort: UInt16 = 8765

/// `arguments` は `transcribe-file` の語の後に続く引数の列（`--file`・`--self-file`・`--port`・`--audio-dir`・`--from`・`--self-from` とその値）。
public func parseTranscribeFileArguments(_ arguments: [String]) -> Result<TranscribeFileArguments, TranscribeFileArgumentsError> {
    var file: String?
    var port = defaultTranscribeFilePort
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
            // 0 以上の有限の秒数だけ。`Double("nan")`・`Double("inf")` は値になるので、有限かどうかも確かめる
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
    return .success(TranscribeFileArguments(file: file, port: port, audioDir: audioDir, selfFile: selfFile, from: from, selfFrom: selfFrom))
}
