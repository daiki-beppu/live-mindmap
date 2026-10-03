import Foundation

// スピーカーで会議を聞くと、相手の声がマイクにも入る。`自分` の確定結果と途中結果のうち、
// 前後 8 秒の `相手` の発言とほぼ同じ文字列のものを重複とみなし、印を付けて流す（捨てない）。

/// 前後に見る時間（秒）。2 トラックの区切りは揃わず、STT の確定にも遅れがあるため、広めに取る。
let duplicateWindow: Double = 8

/// 重複とみなす文字 3-gram の被覆率のしきい値。
/// 漏れた発言の実測（12 件）は 0.68〜1.00（docs/knowledge/2026-09-30.md）。それより下に余裕を取りつつ、
/// 自分の言葉と漏れが半々の発言（0.5 前後）には印を付けない値にした。
let duplicateThreshold: Double = 0.6

/// `自分` の確定結果を、`相手` の発言を待って保留する上限（秒）。`相手` が無音のときに止まらないための値で、窓の後側と同じ。
let duplicateHoldLimit: Double = 8

private let gramLength = 3

/// 空白・句読点・記号を除き、小文字にする。認識結果の表記の揺れによる取りこぼしを減らす。
private func normalized(_ text: String) -> [Character] {
    text.lowercased().filter { !$0.isWhitespace && !$0.isPunctuation && !$0.isSymbol }.map { $0 }
}

private func grams(_ characters: [Character]) -> Set<String> {
    guard characters.count >= gramLength else { return [] }
    return Set((0...(characters.count - gramLength)).map { String(characters[$0..<($0 + gramLength)]) })
}

/// `text` の文字 3-gram（集合）のうち、`context` にも現れるものの割合。
/// `text` が正規化後に 3 文字未満なら 3-gram を作れないので nil。
public func coverage(of text: String, in context: String) -> Double? {
    let own = grams(normalized(text))
    guard !own.isEmpty else { return nil }
    let contextGrams = grams(normalized(context))
    return Double(own.intersection(contextGrams).count) / Double(own.count)
}

/// `text` が `context` と重複しているか。確定結果と途中結果で共通の判定基準（被覆率が `duplicateThreshold` 以上）。
/// 正規化後に 3 文字未満で被覆率を出せない `text` は、重複ではない。
private func exceedsThreshold(_ text: String, in context: String) -> Bool {
    guard let value = coverage(of: text, in: context) else { return false }
    return value >= duplicateThreshold
}

/// `mine` の前後 8 秒に時間範囲が重なる `相手` の確定結果を、start 順に区切りなしで連結した文脈
/// （2 トラックの区切りは揃わないため）。
private func theirContext(around mine: TranscriptionResult, among theirs: [TranscriptionResult]) -> String {
    let lower = mine.start - duplicateWindow
    let upper = mine.end + duplicateWindow
    return theirs
        .filter { $0.end >= lower && $0.start <= upper }
        .sorted { $0.start < $1.start }
        .map(\.text)
        .joined()
}

/// `mine`（`自分` の確定結果）が、前後 8 秒の `相手` の確定結果と重複しているか。
public func isDuplicate(_ mine: TranscriptionResult, among theirs: [TranscriptionResult]) -> Bool {
    exceedsThreshold(mine.text, in: theirContext(around: mine, among: theirs))
}

/// `自分` の確定結果の判定を、後 8 秒の `相手` の発言が届くまで保留する。
/// `resolve` は 1 つずつ順に呼ぶ（呼び出し側が FIFO を保つ）。
public actor DuplicateMarker {
    private let sleep: @Sendable (Duration) async throws -> Void
    private var theirs: [TranscriptionResult] = []
    private var theirLatestPartial: TranscriptionResult?
    private var latestTheirEnd = -Double.infinity
    private var theirsFinished = false
    private var waiter: CheckedContinuation<Void, Never>?
    private var generation = 0
    private var deadlineReached = false

    /// `sleep` は保留の上限の待ち処理。テストで差し替える。
    public init(sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.sleep = sleep
    }

    /// `相手` の確定結果を文脈に加える。
    public func add(theirs result: TranscriptionResult) {
        theirs.append(result)
        latestTheirEnd = max(latestTheirEnd, result.end)
        wake()
    }

    /// `相手` の最新の途中結果を文脈に加える（古いものは置き換える）。保留中の判定は待たせないので、`wake` しない。
    public func add(theirPartial result: TranscriptionResult) {
        theirLatestPartial = result
    }

    /// `mine`（`自分` の途中結果）が重複かを、届いた時点の文脈ですぐ返す（保留しない）。
    /// 文脈は、前後 8 秒の `相手` の確定結果に、`相手` の最新の途中結果（時間では絞らない）を続けたもの。
    public func isDuplicate(partial mine: TranscriptionResult) -> Bool {
        let context = theirContext(around: mine, among: theirs) + (theirLatestPartial?.text ?? "")
        return exceedsThreshold(mine.text, in: context)
    }

    /// `相手` の流れが終わった。以降、保留中の判定を待たせない。
    public func finishTheirs() {
        theirsFinished = true
        wake()
    }

    /// `mine` が重複かを返す。後 8 秒の `相手` の確定結果が届く、`相手` の流れが終わる、保留の上限に達する、のどれかで判定する。
    public func resolve(_ mine: TranscriptionResult, heldSince: ContinuousClock.Instant) async -> Bool {
        generation += 1
        let current = generation
        deadlineReached = false
        let timer = Task { [sleep] in
            // 上限は保留を始めた時刻から数える。前の発言の待ちで遅れた分は、待ち時間から引く。
            try? await sleep(max(.zero, .seconds(duplicateHoldLimit) - (.now - heldSince)))
            guard !Task.isCancelled else { return }
            self.reachDeadline(generation: current)
        }
        while !theirsFinished, latestTheirEnd < mine.end + duplicateWindow, !deadlineReached, !Task.isCancelled {
            await withTaskCancellationHandler {
                await withCheckedContinuation { waiter = $0 }
            } onCancel: {
                Task { await self.wake() }
            }
        }
        timer.cancel()
        let result = HelperCore.isDuplicate(mine, among: theirs)
        // 以降の `自分` の発言は、この発言の start の 8 秒前より後に始まる。それより前に終わった `相手` の発言は要らない。
        theirs.removeAll { $0.end < mine.start - duplicateWindow }
        return result
    }

    private func reachDeadline(generation fired: Int) {
        guard fired == generation else { return }
        deadlineReached = true
        wake()
    }

    private func wake() {
        waiter?.resume()
        waiter = nil
    }
}
