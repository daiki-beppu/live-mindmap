import Foundation

// スピーカーで会議を聞くと、相手の声がマイクにも入る。`自分` の確定結果と途中結果のうち、
// 前後 8 秒の `相手` の発言（確定結果と、確定前の最新の途中結果）とほぼ同じ文字列のものを重複とみなし、印を付けて流す（捨てない）。
// 正規化後 3 文字未満の断片は 3-gram を作れず内容で比べられないので、`相手` の文字と時間区間が重なるかで判定する（Issue #163）。

/// 前後に見る時間（秒）。2 トラックの区切りは揃わず、STT の確定にも遅れがあるため、広めに取る。
let duplicateWindow: Double = 8

/// 重複とみなす文字 3-gram の被覆率のしきい値。
/// 漏れた発言の実測（12 件）は 0.68〜1.00（docs/knowledge/2026-09-30.md）。それより下に余裕を取りつつ、
/// 自分の言葉と漏れが半々の発言（0.5 前後）には印を付けない値にした。
let duplicateThreshold: Double = 0.6

/// `自分` の確定結果を、`相手` の発言を待って保留する上限（秒）。`相手` が無音のときに止まらないための値で、窓の後側と同じ。
let duplicateHoldLimit: Double = 8

/// `自分` の途中結果を、区間が重なる `相手` の文字を待って保留する上限（秒）。`相手` が無音のときに止まらないための値。
/// Issue #163 の要求どおり 1 秒とする（字幕の遅れは最大でこの分だけ増える）。
let minePartialHoldLimit: Double = 1

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
/// 呼び出し側が正規化後 3 文字未満の `text` を時間の重なりで先に判定するので、ここに渡るのは 3 文字以上の `text` だけを前提にする。
private func exceedsThreshold(_ text: String, in context: String) -> Bool {
    guard let value = coverage(of: text, in: context) else { return false }
    return value >= duplicateThreshold
}

/// `text` が正規化後 3 文字未満（3-gram を作れず、内容では判定できない）か。
private func isShortFragment(_ text: String) -> Bool {
    normalized(text).count < gramLength
}

/// `a` と `b` の時間区間が、端点を含めて重なっているか。
private func overlaps(_ a: TranscriptionResult, _ b: TranscriptionResult) -> Bool {
    a.start <= b.end && b.start <= a.end
}

/// `mine` の区間が `candidates` のどれかと重なるか。
private func overlapsAny(_ mine: TranscriptionResult, among candidates: [TranscriptionResult]) -> Bool {
    candidates.contains { overlaps($0, mine) }
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

/// `mine`（`自分` の確定結果）が、前後 8 秒の `相手` の発言（確定結果。呼び出し側が途中結果を加えてもよい）と重複しているか。
/// 正規化後 3 文字未満の断片は内容で比べられないので、`theirs` のどれかと時間区間が重なるかで判定する（時間窓では絞らない）。
public func isDuplicate(_ mine: TranscriptionResult, among theirs: [TranscriptionResult]) -> Bool {
    if isShortFragment(mine.text) {
        return overlapsAny(mine, among: theirs)
    }
    return exceedsThreshold(mine.text, in: theirContext(around: mine, among: theirs))
}

/// 判定が済み、流すべき `自分` の結果。`result.isFinal` が true なら確定結果、false なら途中結果。
/// `relayMine` が 1 つの消費者として受け取り、そのまま broadcast する。
public struct MineDecision: Sendable, Equatable {
    public let result: TranscriptionResult
    public let duplicate: Bool
}

/// `自分` の確定結果の判定を、後 8 秒の `相手` の発言が届くまで保留する。
/// `自分` の途中結果も、区間が重なる `相手` の文字が届くまで（上限 1 秒）保留し、届いた文脈で判定して流す。
/// 一度印なしで流した途中結果（まだ発言になっていないもの）は、`相手` の文字が届くたびに照らし直し、
/// 重複になっていたら印付きで流し直す。
/// 判定の済んだ途中結果と確定結果は `mineDecisions` の 1 つの流れに積む。`自分` 向けの送信順序はこの流れが決める
/// （同じ発話の途中結果が確定結果に追い越されると、確定で消した字幕が古い本文で戻る）。
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

    // `自分` の途中結果の保留。最新の 1 件だけ持ち、書き換えは上書き（タイマーは作り直さない）。
    private var heldPartial: TranscriptionResult?
    private var heldPartialGeneration = 0
    private var heldPartialTimer: Task<Void, Never>?
    // 印なしで流した、まだ発言になっていない最新の途中結果。`相手` の文字が届くたびに照らし直す対象。
    private var lastEmittedPartial: TranscriptionResult?

    private let mineDecisionContinuation: AsyncStream<MineDecision>.Continuation
    /// 判定が済んだ `自分` の途中結果と確定結果の流れ。消費者は `relayMine` の 1 タスクだけを前提にする
    /// （`AsyncStream` は複数消費者を支えない）。
    public nonisolated let mineDecisions: AsyncStream<MineDecision>

    /// `sleep` は保留の上限の待ち処理。テストで差し替える。確定結果の 8 秒と途中結果の 1 秒の両方で使う。
    public init(sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.sleep = sleep
        let (stream, continuation) = AsyncStream.makeStream(of: MineDecision.self)
        self.mineDecisions = stream
        self.mineDecisionContinuation = continuation
    }

    /// `相手` の確定結果を文脈に加える。区間が重なる保留中の `自分` の途中結果を解放し、
    /// まだ発言になっていない直前の途中結果を照らし直す。
    public func add(theirs result: TranscriptionResult) {
        theirs.append(result)
        latestTheirEnd = max(latestTheirEnd, result.end)
        releaseHeldPartialIfOverlapping(with: result)
        recheckLastEmittedPartial()
        wake()
    }

    /// `相手` の最新の途中結果を文脈に加える（古いものは置き換える）。確定結果の保留中の判定は待たせないので `wake` しない。
    /// `自分` の途中結果の保留は、区間が重なれば解放し、まだ発言になっていない直前の途中結果を照らし直す。
    public func add(theirPartial result: TranscriptionResult) {
        theirLatestPartial = result
        releaseHeldPartialIfOverlapping(with: result)
        recheckLastEmittedPartial()
    }

    /// `mine`（`自分` の途中結果）が重複かを、届いた時点の文脈ですぐ返す（保留しない）。
    /// 文脈は、前後 8 秒の `相手` の確定結果に、`相手` の最新の途中結果（時間では絞らない）を続けたもの。
    /// 正規化後 3 文字未満の断片は内容で比べられないので、`相手` の確定結果・最新の途中結果のどれかと時間区間が重なるかで判定する。
    public func isDuplicate(partial mine: TranscriptionResult) -> Bool {
        if isShortFragment(mine.text) {
            return overlapsAnyTheirContext(mine)
        }
        let context = theirContext(around: mine, among: theirs) + (theirLatestPartial?.text ?? "")
        return exceedsThreshold(mine.text, in: context)
    }

    /// `mine`（`自分` の途中結果）を保留する。区間が重なる `相手` の文字が既に文脈にある、または `相手` の流れが
    /// 既に終わっているときは、待っても文脈が増えないので保留せずその場で判定して流す。
    /// 保留は 1 件だけ持つ。同じ区切りの書き換えは上書きし、上限のタイマーは最初の到着時にだけ作る（Issue #163）。
    /// 書き換えで区間が伸び、重なりの有無が変わることがある。直前の保留が残ったままだと、
    /// 古い保留のタイマーが後から古い内容を流してしまうので、即時判定する前に必ず解除しておく。
    public func hold(minePartial result: TranscriptionResult) {
        guard !theirsFinished, !overlapsAnyTheirContext(result) else {
            clearHeldPartial()
            judgeAndEmitPartial(result)
            return
        }
        if heldPartial == nil {
            heldPartialGeneration += 1
            let generation = heldPartialGeneration
            let wait = Duration.seconds(minePartialHoldLimit)
            heldPartialTimer = Task { [sleep] in
                try? await sleep(wait)
                guard !Task.isCancelled else { return }
                self.releaseHeldPartialAtDeadline(generation: generation)
            }
        }
        heldPartial = result
    }

    /// `自分` の確定結果が届いた。同じ区切りの途中結果がまだ保留中なら、その時点の文脈で判定して流す。
    /// 捨てると、その内容は字幕に出ないまま確定結果の判定待ち（最大 8 秒）に置き換わり、
    /// 途中結果の遅れを 1 秒までとする要求（Issue #163）を満たせない。
    /// 流し終えたら、その内容は確定結果が発言として置き換えるので、以降 `相手` の文字が届いても照らし直さない。
    public func emitHeldPartialAndEndRecheck() {
        releaseHeldPartialIfAny()
        lastEmittedPartial = nil
    }

    /// 判定の済んだ `自分` の確定結果を出力へ積む。`自分` 向けの送信は 1 つの流れだけが行うので、
    /// 同じ発話の途中結果を確定結果が追い越さない。
    public func emit(resolvedRemark result: TranscriptionResult, duplicate: Bool) {
        mineDecisionContinuation.yield(MineDecision(result: result, duplicate: duplicate))
    }

    /// `自分` 向けの出力を閉じる。確定結果の判定をすべて終えてから呼ぶ（判定の済んだ結果を落とさないため）。
    public func finishMineDecisions() {
        mineDecisionContinuation.finish()
    }

    /// `自分` の流れが終わった。保留中の途中結果があれば、捨てずに判定して流す。
    public func finishMine() {
        releaseHeldPartialIfAny()
    }

    /// `相手` の流れが終わった。以降、保留中の判定を待たせない。保留中の `自分` の途中結果も、
    /// 待っても文脈が増えないので判定して流す。
    public func finishTheirs() {
        theirsFinished = true
        releaseHeldPartialIfAny()
        wake()
    }

    /// `mine` が重複かを返す。後 8 秒の `相手` の確定結果が届く、`相手` の流れが終わる、保留の上限に達する、のどれかで判定する。
    /// 文脈は、前後 8 秒の `相手` の確定結果と、窓に重なる `相手` の最新の途中結果。
    public func resolve(_ mine: TranscriptionResult, heldSince: ContinuousClock.Instant) async -> Bool {
        generation += 1
        let current = generation
        deadlineReached = false
        // 上限は保留を始めた時刻から数える。前の発言の待ちで遅れた分は、待ち時間から引く。
        // 待ち時間はタスクの外で求める。タスクの中で求めると、Xcode 26.6（Swift 6.3.3）の debug ビルドで
        // 「freed pointer was not the last allocation」で落ちた（PR #109 の二分探索）。
        let wait = max(.zero, .seconds(duplicateHoldLimit) - (.now - heldSince))
        let timer = Task { [sleep] in
            try? await sleep(wait)
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
        // 上限で打ち切ったとき、長く続く `相手` の発言の確定はまだ届いていない。その発言の途中結果も文脈に入れ、
        // 漏れた `自分` の発言を取りこぼさない。途中結果は確定後も残るので、確定結果と同じ窓で絞る。
        let result = HelperCore.isDuplicate(mine, among: theirs + [theirLatestPartial].compactMap { $0 })
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

    /// 保留中の `自分` の途中結果が `event` と区間が重なれば解放する。
    private func releaseHeldPartialIfOverlapping(with event: TranscriptionResult) {
        guard let held = heldPartial, overlaps(held, event) else { return }
        releaseHeldPartial(held)
    }

    /// 保留中の `自分` の途中結果があれば解放する。
    private func releaseHeldPartialIfAny() {
        guard let held = heldPartial else { return }
        releaseHeldPartial(held)
    }

    /// 保留の上限のタイマーが到達した。その間に別の経路で解放済み、または書き換え後の新しい保留サイクルなら無視する。
    private func releaseHeldPartialAtDeadline(generation: Int) {
        guard generation == heldPartialGeneration, let held = heldPartial else { return }
        releaseHeldPartial(held)
    }

    /// 保留を解いて、タイマーを止め、判定して流す。
    private func releaseHeldPartial(_ result: TranscriptionResult) {
        clearHeldPartial()
        judgeAndEmitPartial(result)
    }

    /// 保留中の途中結果とタイマーを、流さずに解く。書き換えで重なりの有無が変わって即時判定へ切り替わったとき、
    /// 古い保留のタイマーが後から古い内容を流さないようにする。
    private func clearHeldPartial() {
        heldPartial = nil
        heldPartialTimer?.cancel()
        heldPartialTimer = nil
    }

    /// 印なしで流した、まだ発言になっていない直前の途中結果を、現在の文脈で照らし直す。重複になっていたら印付きで流し直す。
    private func recheckLastEmittedPartial() {
        guard let candidate = lastEmittedPartial, isDuplicate(partial: candidate) else { return }
        lastEmittedPartial = nil
        mineDecisionContinuation.yield(MineDecision(result: candidate, duplicate: true))
    }

    /// `result` を判定し、流す。印なしなら「まだ発言になっていない最新の途中結果」として覚え、印つきなら覚えない。
    private func judgeAndEmitPartial(_ result: TranscriptionResult) {
        let duplicate = isDuplicate(partial: result)
        mineDecisionContinuation.yield(MineDecision(result: result, duplicate: duplicate))
        lastEmittedPartial = duplicate ? nil : result
    }

    /// `mine` の区間が、`相手` の確定結果か最新の途中結果のどれかと重なるか。
    private func overlapsAnyTheirContext(_ mine: TranscriptionResult) -> Bool {
        overlapsAny(mine, among: theirs) || (theirLatestPartial.map { overlaps($0, mine) } ?? false)
    }
}
