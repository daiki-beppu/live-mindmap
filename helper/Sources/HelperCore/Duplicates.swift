import Foundation

let duplicateWindow: Double = 8

let duplicateThreshold: Double = 0.6

let duplicateHoldLimit: Double = 8

/// Issue #163 の要求どおり 1 秒とする（字幕の遅れは最大でこの分だけ増える）。
let minePartialHoldLimit: Double = 1

private let gramLength = 3

private func normalized(_ text: String) -> [Character] {
    text.lowercased().filter { !$0.isWhitespace && !$0.isPunctuation && !$0.isSymbol }.map { $0 }
}

private func grams(_ characters: [Character]) -> Set<String> {
    guard characters.count >= gramLength else { return [] }
    return Set((0...(characters.count - gramLength)).map { String(characters[$0..<($0 + gramLength)]) })
}

public func coverage(of text: String, in context: String) -> Double? {
    let own = grams(normalized(text))
    guard !own.isEmpty else { return nil }
    let contextGrams = grams(normalized(context))
    return Double(own.intersection(contextGrams).count) / Double(own.count)
}

private func exceedsThreshold(_ text: String, in context: String) -> Bool {
    guard let value = coverage(of: text, in: context) else { return false }
    return value >= duplicateThreshold
}

private func isShortFragment(_ text: String) -> Bool {
    normalized(text).count < gramLength
}

private func overlaps(_ a: TranscriptionResult, _ b: TranscriptionResult) -> Bool {
    a.start <= b.end && b.start <= a.end
}

private func overlapsAny(_ mine: TranscriptionResult, among candidates: [TranscriptionResult]) -> Bool {
    candidates.contains { overlaps($0, mine) }
}

private func theirContext(around mine: TranscriptionResult, among theirs: [TranscriptionResult]) -> String {
    let lower = mine.start - duplicateWindow
    let upper = mine.end + duplicateWindow
    return theirs
        .filter { $0.end >= lower && $0.start <= upper }
        .sorted { $0.start < $1.start }
        .map(\.text)
        .joined()
}

public func isDuplicate(_ mine: TranscriptionResult, among theirs: [TranscriptionResult]) -> Bool {
    if isShortFragment(mine.text) {
        return overlapsAny(mine, among: theirs)
    }
    return exceedsThreshold(mine.text, in: theirContext(around: mine, among: theirs))
}

public struct MineDecision: Sendable, Equatable {
    public let result: TranscriptionResult
    public let duplicate: Bool
}

public actor DuplicateMarker {
    private let sleep: @Sendable (Duration) async throws -> Void
    private let clock: @Sendable () async -> Double
    private var theirs: [TranscriptionResult] = []
    private var theirLatestPartial: TranscriptionResult?
    private var latestTheirEnd = -Double.infinity
    private var theirsFinished = false
    private var waiter: CheckedContinuation<Void, Never>?
    private var generation = 0
    private var deadlineReached = false

    private var heldPartial: TranscriptionResult?
    private var heldPartialGeneration = 0
    private var heldPartialTimer: Task<Void, Never>?
    private var lastEmittedPartial: TranscriptionResult?

    private let heldMineFinals: AsyncStream<(TranscriptionResult, Double)>
    private let heldMineFinalContinuation: AsyncStream<(TranscriptionResult, Double)>.Continuation
    private var hasResolvedHeldFinals = false

    private let mineDecisionContinuation: AsyncStream<MineDecision>.Continuation
    public nonisolated let mineDecisions: AsyncStream<MineDecision>

    public init(
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        now: @escaping @Sendable () async -> Double = DuplicateMarker.wallClockSeconds
    ) {
        self.sleep = sleep
        self.clock = now
        let (heldFinals, heldFinalContinuation) = AsyncStream.makeStream(of: (TranscriptionResult, Double).self)
        self.heldMineFinals = heldFinals
        self.heldMineFinalContinuation = heldFinalContinuation
        let (stream, continuation) = AsyncStream.makeStream(of: MineDecision.self)
        self.mineDecisions = stream
        self.mineDecisionContinuation = continuation
    }

    private static let wallClockOrigin = ContinuousClock.now

    @Sendable public static func wallClockSeconds() -> Double {
        let elapsed = ContinuousClock.now - wallClockOrigin
        return Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
    }

    public func add(theirs result: TranscriptionResult) {
        theirs.append(result)
        latestTheirEnd = max(latestTheirEnd, result.end)
        releaseHeldPartialIfOverlapping(with: result)
        recheckLastEmittedPartial()
        wake()
    }

    public func add(theirPartial result: TranscriptionResult) {
        theirLatestPartial = result
        releaseHeldPartialIfOverlapping(with: result)
        recheckLastEmittedPartial()
    }

    public func isDuplicate(partial mine: TranscriptionResult) -> Bool {
        if isShortFragment(mine.text) {
            return overlapsAnyTheirContext(mine)
        }
        let context = theirContext(around: mine, among: theirs) + (theirLatestPartial?.text ?? "")
        return exceedsThreshold(mine.text, in: context)
    }

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

    public func hold(mineFinal result: TranscriptionResult) async {
        releaseHeldPartialIfAny()
        lastEmittedPartial = nil
        heldMineFinalContinuation.yield((result, await clock()))
    }

    public func endMineFinals() {
        heldMineFinalContinuation.finish()
    }

    public func resolveHeldFinals() async {
        precondition(!hasResolvedHeldFinals, "resolveHeldFinals must only be called once per marker")
        hasResolvedHeldFinals = true
        defer { mineDecisionContinuation.finish() }
        for await (result, heldSince) in heldMineFinals {
            let duplicate = await resolve(result, heldSince: heldSince)
            if Task.isCancelled { break }
            mineDecisionContinuation.yield(MineDecision(result: result, duplicate: duplicate))
        }
    }

    public func finishMine() {
        releaseHeldPartialIfAny()
    }

    public func finishTheirs() {
        theirsFinished = true
        releaseHeldPartialIfAny()
        wake()
    }

    private func resolve(_ mine: TranscriptionResult, heldSince: Double) async -> Bool {
        generation += 1
        let current = generation
        deadlineReached = false
        let elapsed = await clock() - heldSince
        let wait = Duration.seconds(max(0, duplicateHoldLimit - elapsed))
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
        let result = HelperCore.isDuplicate(mine, among: theirs + [theirLatestPartial].compactMap { $0 })
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

    private func releaseHeldPartialIfOverlapping(with event: TranscriptionResult) {
        guard let held = heldPartial, overlaps(held, event) else { return }
        releaseHeldPartial(held)
    }

    private func releaseHeldPartialIfAny() {
        guard let held = heldPartial else { return }
        releaseHeldPartial(held)
    }

    private func releaseHeldPartialAtDeadline(generation: Int) {
        guard generation == heldPartialGeneration, let held = heldPartial else { return }
        releaseHeldPartial(held)
    }

    private func releaseHeldPartial(_ result: TranscriptionResult) {
        clearHeldPartial()
        judgeAndEmitPartial(result)
    }

    private func clearHeldPartial() {
        heldPartial = nil
        heldPartialTimer?.cancel()
        heldPartialTimer = nil
    }

    private func recheckLastEmittedPartial() {
        guard let candidate = lastEmittedPartial, isDuplicate(partial: candidate) else { return }
        lastEmittedPartial = nil
        mineDecisionContinuation.yield(MineDecision(result: candidate, duplicate: true))
    }

    private func judgeAndEmitPartial(_ result: TranscriptionResult) {
        let duplicate = isDuplicate(partial: result)
        mineDecisionContinuation.yield(MineDecision(result: result, duplicate: duplicate))
        lastEmittedPartial = duplicate ? nil : result
    }

    private func overlapsAnyTheirContext(_ mine: TranscriptionResult) -> Bool {
        overlapsAny(mine, among: theirs) || (theirLatestPartial.map { overlaps($0, mine) } ?? false)
    }
}
