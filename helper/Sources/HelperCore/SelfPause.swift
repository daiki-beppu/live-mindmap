import Foundation

/// server が helper を起動するときに渡す、休止の指示の認証用トークンの環境変数名。起動ごとに server が作り、指示の JSON の `token` で返す。
public let helperControlTokenEnvironmentKey = "LIVE_MINDMAP_HELPER_CONTROL_TOKEN"

/// `自分` の休止の状態（Issue #1069）。`SelfPauseRule` が決めた休止・再開（手動の指示と会議アプリのマイクの使用）で変わり、休止の間に取った音は `RunAudio` が捨てる。
/// 休止・再開は、指示を受け付けた時刻（ホスト時刻）の境界として覚える。音の側は、バッファを取得した時刻でその境界と照らして振り分ける
/// （読んだ時点の状態では、休止の前に取った音を休止の後に読んだ場合や、休止中に取った音を再開の後に読んだ場合を取り違える）。
/// 同じ状態の指示は何も変えない（`request` が false を返す）。音の流れの側（別スレッド）と指示を読む側から使うので、ロックで守る。
public final class SelfPause: @unchecked Sendable {
    private let lock = NSLock()
    /// 最新の要求の状態（同じ状態の指示を見分ける）
    private var requested: Bool
    /// 取り出し済みの境界までを反映した状態（音の側の位置）
    private var applied: Bool
    private var boundaries: [(hostTime: UInt64, paused: Bool)] = []

    /// 規則（`SelfPauseRule`）が休止から始めるときは `paused: true`。
    public init(paused: Bool = false) {
        self.requested = paused
        self.applied = paused
    }

    /// 状態を `paused` にする境界を、`hostTime`（指示を受け付けた時刻）に置く。状態が変わったときだけ true を返す。
    public func request(_ paused: Bool, at hostTime: UInt64) -> Bool {
        lock.withLock {
            guard requested != paused else { return false }
            requested = paused
            boundaries.append((hostTime, paused))
            return true
        }
    }

    /// 取得時刻が `hostTime` のバッファの扱い。`hostTime` 以下の境界を取り出して反映し、
    /// その時点で休止中か（`paused`）と、取り出した境界に休止への切り替えが含まれたか（`enteredPause`。含まれたら、それより前の区間を閉じる）を返す。
    func resolve(at hostTime: UInt64) -> (paused: Bool, enteredPause: Bool) {
        lock.withLock {
            var entered = false
            while let boundary = boundaries.first, boundary.hostTime <= hostTime {
                boundaries.removeFirst()
                applied = boundary.paused
                if boundary.paused { entered = true }
            }
            return (applied, entered)
        }
    }

    /// サーバーからの指示（`{"type":"self-pause","paused":boolean,"token":string}`）が求める状態。
    /// 壊れた JSON・知らない type・`paused` が真偽値でない指示・`token` が `token` と一致しない指示は nil。`token` が空のときは何も受け付けない。
    public static func requestedState(in message: String, token: String) -> Bool? {
        instructedState(in: message, type: "self-pause", token: token)
    }

    /// サーバーからの指示（`{"type":<type>,"paused":boolean,"token":string}`）が求める状態。指示の読み取りの規則は type によらず同じ。
    /// 録画ファイルの読み取りの停止（`reading-pause`。`FileReadingGate`）も、ここで読む。
    static func instructedState(in message: String, type: String, token: String) -> Bool? {
        guard !token.isEmpty,
              let object = try? JSONSerialization.jsonObject(with: Data(message.utf8)) as? [String: Any],
              object["type"] as? String == type,
              let sent = object["token"] as? String,
              constantTimeEqual(sent, token),
              let value = object["paused"] as? NSNumber,
              CFGetTypeID(value) == CFBooleanGetTypeID()
        else { return nil }
        return value.boolValue
    }

    private static func constantTimeEqual(_ lhs: String, _ rhs: String) -> Bool {
        let left = Array(lhs.utf8), right = Array(rhs.utf8)
        guard left.count == right.count else { return false }
        var difference: UInt8 = 0
        for index in left.indices { difference |= left[index] ^ right[index] }
        return difference == 0
    }
}

/// 始めた時点の休止の状態（`paused` と理由）と、起動し直しで引き継ぐ状態を、時刻を付けて 1 回ずつ `emit` する。
/// サーバーは起動の間に求めた状態を、helper が受け付けるまで知らないので、指示の処理を始める前にこれを出す。
public func announceSelfPause(_ rule: SelfPauseRule, at hostTime: UInt64, origin: UInt64, emit: (HelperEvent) async -> Void) async {
    await emit(.selfPause(paused: rule.paused, reason: rule.reason, start: offsetSeconds(from: origin, to: hostTime)))
    await emit(.selfPauseState(rule.carryOver))
}

/// サーバーからの指示を順に読み、認証できた指示の求める状態を、届いた順に `request` へ渡す。
/// 認証できない指示・読み取れない指示では呼ばない。同じ状態の指示を何も変えないことは、渡した先の規則が受け持つ。`messages` が終わると戻る。
public func serveSelfPauseRequests<Messages: AsyncSequence>(
    _ messages: Messages, token: String, request: (Bool) -> Void
) async where Messages.Element == String {
    do {
        for try await message in messages {
            guard let paused = SelfPause.requestedState(in: message, token: token) else { continue }
            request(paused)
        }
    } catch {}
}
