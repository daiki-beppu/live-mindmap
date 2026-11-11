import Foundation

public let screenGridWidth = 128
public let screenGridHeight = 72
public let screenLumaDifferenceThreshold = 10
public let screenChangedCellRatioThreshold = 0.005
public let screenMotionLumaDifferenceThreshold = 3
public let screenMotionHoldSeconds = 1.0
public let screenMotionAverageSeconds = 10.0
public let screenFrequentMotionRatio = 0.25
public let screenWideMotionCellCount = 8
public let screenWideMotionMargin = 2
public let screenPointMotionMargin = 1
public let screenSpeakerFrameLumaTolerance = 6
public let screenSpeakerFrameMaxChangedRatio = 0.1
public let screenSentHistoryCount = 30
public let screenTitleRefreshSeconds = 1.0
public let screenWindowRetryInterval = 2.0
public let screenBrowserBundleIDs = [
    "com.google.Chrome", "com.microsoft.edgemac", "com.apple.Safari",
    "company.thebrowser.Browser", "com.brave.Browser", "org.mozilla.firefox",
]
public let screenMeetingTabTitleKeywords = ["Meet"]
public let screenFramesPerSecond = 4
public let screenMaxWidth = 1280
public let screenMaxHeight = 720
public let screenJPEGQuality = 0.8

public struct ScreenFrame: Sendable, Equatable {
    public var luma: [UInt8]
    public var time: Double
    public var title: String?

    public init(luma: [UInt8], time: Double, title: String?) {
        self.luma = luma
        self.time = time
        self.title = title
    }
}

public enum ScreenInput: Sendable, Equatable {
    case frame(ScreenFrame)
    case windowGone(time: Double)
}

public enum ScreenDecision: Sendable, Equatable {
    case send(start: Double)
    case none(start: Double)
    case nothing
}

func normalizedScreenTabTitle(_ title: String) -> String {
    title
        .replacingOccurrences(of: #"^\([0-9]+\)\s+"#, with: "", options: .regularExpression)
        .replacingOccurrences(of: #"\s*🔊\s*$"#, with: "", options: .regularExpression)
}

private func canRememberScreenTabTitle(_ title: String) -> Bool {
    let normalized = normalizedScreenTabTitle(title)
    return !normalized.isEmpty && !["live-mindmap", "about:blank", "新しいタブ", "New Tab"].contains(normalized)
}

private let screenProvisionalSeconds = 60.0
private let screenRetargetSeconds = 10.0

public func screenShowsMeeting(bundleID: String, title: String?, rememberedTitle: String? = nil) -> Bool {
    guard screenBrowserBundleIDs.contains(bundleID) else { return true }
    guard let title, !title.isEmpty else { return true }
    return screenMeetingTabTitleKeywords.contains { title.contains($0) }
        || rememberedTitle.map { normalizedScreenTabTitle(title) == normalizedScreenTabTitle($0) } == true
}

enum ScreenFrameContent: Sendable, Equatable {
    case updated
    case unchanged
    case unusable
}

func screenFrameToJudge<Image>(
    _ content: ScreenFrameContent,
    previous: (luma: [UInt8], image: Image)?,
    render: () -> (luma: [UInt8], image: Image)?
) -> (luma: [UInt8], image: Image)? {
    switch content {
    case .updated: return render()
    case .unchanged: return previous
    case .unusable: return nil
    }
}

public struct ScreenShot: Sendable, Equatable {
    public var image: String
    public var lines: [String]?

    public init(image: String, lines: [String]?) {
        self.image = image
        self.lines = lines
    }

    init(jpeg: Data, recognizedLines: [String]?) {
        self.init(image: jpeg.base64EncodedString(), lines: recognizedLines)
    }
}

public struct ScreenChangeDetector: Sendable {
    private let bundleID: String?
    private enum Tab: Sendable {
        case unknown
        case provisional(title: String, since: Double, candidate: Candidate?)
        case confirmed(title: String)
    }
    private struct Candidate: Sendable {
        let title: String
        let since: Double
    }
    private var tab: Tab = .unknown
    var rememberedTabTitle: String? {
        switch tab {
        case .unknown: nil
        case .provisional(let title, _, _), .confirmed(let title): title
        }
    }
    var confirmedTabTitle: String? {
        if case .confirmed(let title) = tab { return title }
        return nil
    }
    private var comparison = ScreenImageComparison()
    private var provisionalComparison = ScreenImageComparison()
    private var buffered: [(start: Double, shot: ScreenShot)] = []
    private var outputHasImage = false
    private var absentSince: Double?

    public init(bundleID: String) {
        self.bundleID = bundleID
    }

    private init() {
        bundleID = nil
    }

    public static func withoutTabDetection() -> Self {
        Self()
    }

    var fileProgress: Double? { comparison.fileProgress }

    mutating func fileScreenEvent(for frame: ScreenFrame, encode: () -> ScreenShot?) -> [HelperEvent] {
        let events = screenEvent(for: frame, encode: encode)
        comparison.confirmFileProgress()
        return events
    }

    public mutating func next(_ input: ScreenInput) -> ScreenDecision {
        switch input {
        case .windowGone(let time):
            confirmTab()
            return clearComparisons(at: time)
        case .frame(let frame):
            updateTab(for: frame)
            return judge(frame)
        }
    }

    private mutating func updateTab(for frame: ScreenFrame) {
        guard let bundleID, screenBrowserBundleIDs.contains(bundleID) else { return }
        switch tab {
        case .unknown:
            if let title = frame.title, canRememberScreenTabTitle(title) {
                tab = .provisional(title: title, since: frame.time, candidate: nil)
                provisionalComparison = comparison
            }
        case .confirmed:
            break
        case .provisional(let title, let since, let candidate):
            if frame.time - since >= screenProvisionalSeconds {
                confirmTab()
                return
            }
            guard let proposed = frame.title, canRememberScreenTabTitle(proposed),
                  !isMeet(proposed), normalizedScreenTabTitle(proposed) != normalizedScreenTabTitle(title) else {
                tab = .provisional(title: title, since: since, candidate: nil)
                return
            }
            if let candidate, normalizedScreenTabTitle(candidate.title) == normalizedScreenTabTitle(proposed) {
                if frame.time - candidate.since >= screenRetargetSeconds {
                    tab = .provisional(title: proposed, since: since, candidate: nil)
                    buffered.removeAll()
                    comparison = ScreenImageComparison()
                    provisionalComparison = ScreenImageComparison()
                }
            } else {
                tab = .provisional(title: title, since: since, candidate: Candidate(title: proposed, since: frame.time))
            }
        }
    }

    private func isMeet(_ title: String?) -> Bool {
        title.map { title in screenMeetingTabTitleKeywords.contains { title.contains($0) } } == true
    }

    private func shouldBuffer(_ frame: ScreenFrame) -> Bool {
        if case .provisional = tab { return !isMeet(frame.title) }
        return false
    }

    private mutating func confirmTab() {
        guard case .provisional(let title, _, _) = tab else { return }
        if let start = provisionalComparison.lastSentStart,
           comparison.lastSentStart.map({ start >= $0 }) ?? true {
            comparison = provisionalComparison
        }
        provisionalComparison = ScreenImageComparison()
        tab = .confirmed(title: title)
    }

    private mutating func judge(_ frame: ScreenFrame) -> ScreenDecision {
        if let bundleID, !screenShowsMeeting(bundleID: bundleID, title: frame.title, rememberedTitle: rememberedTabTitle) {
            if absentSince == nil { absentSince = frame.time }
            return clearComparisons(at: frame.time)
        }
        absentSince = nil
        if shouldBuffer(frame) { return provisionalComparison.judge(frame) }
        return comparison.judge(frame)
    }

    private mutating func clearComparisons(at time: Double) -> ScreenDecision {
        let sent = comparison.windowGone(at: time)
        let pending = provisionalComparison.windowGone(at: time)
        return sent == .nothing ? pending : sent
    }

    public mutating func screenEvent(for frame: ScreenFrame, encode: () -> ScreenShot?) -> [HelperEvent] {
        updateTab(for: frame)
        let buffering = shouldBuffer(frame)
        let before = buffering ? provisionalComparison : comparison
        let decision = judge(frame)
        var events = flushConfirmedImages()
        switch decision {
        case .nothing:
            break
        case .none(let start):
            events += clearOutput(at: start)
        case .send(let start):
            guard let shot = encode() else {
                if buffering { provisionalComparison = before } else { comparison = before }
                return events
            }
            if buffering {
                buffered.append((start, shot))
            } else {
                events.append(.screen(start: start, image: shot.image, lines: shot.lines, ocrFailed: shot.lines == nil, meetingTabTitle: rememberedTabTitle))
                outputHasImage = true
            }
        }
        return events
    }

    public mutating func screenEvent(windowGoneAt time: Double) -> [HelperEvent] {
        var events = finish()
        _ = clearComparisons(at: time)
        absentSince = time
        events += clearOutput(at: time)
        return events
    }

    public mutating func finish() -> [HelperEvent] {
        confirmTab()
        return flushConfirmedImages()
    }

    private mutating func flushConfirmedImages() -> [HelperEvent] {
        guard confirmedTabTitle != nil, !buffered.isEmpty else { return [] }
        var events = buffered.sorted { $0.start < $1.start }.map {
            HelperEvent.screen(start: $0.start, image: $0.shot.image, lines: $0.shot.lines, ocrFailed: $0.shot.lines == nil, meetingTabTitle: rememberedTabTitle)
        }
        buffered.removeAll()
        outputHasImage = true
        if let absentSince { events += clearOutput(at: absentSince) }
        return events
    }

    private mutating func clearOutput(at time: Double) -> [HelperEvent] {
        guard outputHasImage else { return [] }
        outputHasImage = false
        return [.screen(start: time, image: nil, lines: nil, meetingTabTitle: rememberedTabTitle)]
    }
}

private struct ScreenImageComparison: Sendable {
    private var lastSent: [UInt8]?
    private(set) var lastSentStart: Double?
    private var lastSentTime = 0.0
    private var sentHistory: [[UInt8]] = []
    private var previous: (luma: [UInt8], time: Double)?
    private var lastMotionTime: [Double] = []
    private var motionAverage: [Double] = []
    private var remembered: [UInt8] = []
    private var rememberedTime: [Double] = []

    private(set) var fileProgress: Double?

    mutating func confirmFileProgress() {
        guard let lastSent, let previous else { return }
        let moving = movingCells(at: previous.time)
        let pending = remembered.indices
            .filter { moving[$0] && abs(Int(previous.luma[$0]) - Int(lastSent[$0])) > screenLumaDifferenceThreshold }
            .map { rememberedTime[$0] }.min()
        fileProgress = max(fileProgress ?? lastSentTime, max(lastSentTime, pending ?? previous.time))
    }

    mutating func windowGone(at time: Double) -> ScreenDecision {
        guard lastSent != nil else { return .nothing }
        reset()
        return .none(start: time)
    }

    private mutating func reset() {
        lastSent = nil
        lastSentStart = nil
        lastSentTime = 0
        sentHistory = []
        previous = nil
        lastMotionTime = []
        motionAverage = []
        remembered = []
        rememberedTime = []
    }

    mutating func judge(_ frame: ScreenFrame) -> ScreenDecision {
        let luma = frame.luma
        if remembered.count != luma.count { reset(trackingFor: luma.count) }
        updateMotion(luma, at: frame.time)
        updateRemembered(luma, at: frame.time)
        previous = (luma, frame.time)

        guard let base = lastSent else {
            return send(luma, decidedAt: frame.time, start: frame.time)
        }
        guard luma.count == base.count, !luma.isEmpty else {
            return send(luma, decidedAt: frame.time, start: frame.time)
        }

        let excluded = excludedCells(at: frame.time)
        var compared = 0
        var differing: [Int] = []
        for index in 0..<luma.count where !excluded[index] {
            compared += 1
            if abs(Int(luma[index]) - Int(base[index])) > screenLumaDifferenceThreshold { differing.append(index) }
        }
        guard compared > 0, Double(differing.count) / Double(compared) > screenChangedCellRatioThreshold else { return .nothing }
        if Double(differing.count) / Double(luma.count) < screenSpeakerFrameMaxChangedRatio,
           sentHistory.contains(where: { matches(luma, $0, at: differing) }) {
            return .nothing
        }
        let start = max(median(differing.map { rememberedTime[$0] }), lastSentTime)
        return send(luma, decidedAt: frame.time, start: start)
    }

    private mutating func send(_ luma: [UInt8], decidedAt time: Double, start: Double) -> ScreenDecision {
        let start = max(start, fileProgress ?? start)
        lastSent = luma
        lastSentStart = start
        lastSentTime = time
        sentHistory.append(luma)
        if sentHistory.count > screenSentHistoryCount { sentHistory.removeFirst(sentHistory.count - screenSentHistoryCount) }
        return .send(start: start)
    }

    private mutating func reset(trackingFor count: Int) {
        previous = nil
        lastMotionTime = [Double](repeating: -.infinity, count: count)
        motionAverage = [Double](repeating: 0, count: count)
        remembered = []
        rememberedTime = []
    }

    private mutating func updateMotion(_ luma: [UInt8], at time: Double) {
        guard let previous, previous.luma.count == luma.count else { return }
        let elapsed = time - previous.time
        let alpha = elapsed > 0 ? 1 - exp(-elapsed / screenMotionAverageSeconds) : 0
        for index in 0..<luma.count {
            let moved = abs(Int(luma[index]) - Int(previous.luma[index])) > screenMotionLumaDifferenceThreshold
            if moved { lastMotionTime[index] = time }
            motionAverage[index] += alpha * ((moved ? 1 : 0) - motionAverage[index])
        }
    }

    private mutating func updateRemembered(_ luma: [UInt8], at time: Double) {
        if remembered.count != luma.count {
            remembered = luma
            rememberedTime = [Double](repeating: time, count: luma.count)
            return
        }
        for index in 0..<luma.count where abs(Int(luma[index]) - Int(remembered[index])) > screenLumaDifferenceThreshold {
            remembered[index] = luma[index]
            rememberedTime[index] = time
        }
    }

    private func movingCells(at time: Double) -> [Bool] {
        motionAverage.indices.map { index in
            time - lastMotionTime[index] < screenMotionHoldSeconds || motionAverage[index] > screenFrequentMotionRatio
        }
    }

    private func excludedCells(at time: Double) -> [Bool] {
        let moving = movingCells(at: time)
        let count = moving.count
        var excluded = moving
        for index in 0..<count where moving[index] {
            let x = index % screenGridWidth
            let y = index / screenGridWidth
            var neighbors = 0
            for dy in -2...2 {
                for dx in -2...2 where isMoving(moving, x + dx, y + dy) { neighbors += 1 }
            }
            let margin = neighbors >= screenWideMotionCellCount ? screenWideMotionMargin : screenPointMotionMargin
            for dy in -margin...margin {
                for dx in -margin...margin {
                    let nx = x + dx
                    let ny = y + dy
                    if nx >= 0, nx < screenGridWidth, ny >= 0, ny < screenGridHeight { excluded[ny * screenGridWidth + nx] = true }
                }
            }
        }
        return excluded
    }

    private func isMoving(_ moving: [Bool], _ x: Int, _ y: Int) -> Bool {
        guard x >= 0, x < screenGridWidth, y >= 0, y < screenGridHeight else { return false }
        return moving[y * screenGridWidth + x]
    }

    private func matches(_ luma: [UInt8], _ sent: [UInt8], at cells: [Int]) -> Bool {
        guard sent.count == luma.count else { return false }
        return cells.allSatisfy { abs(Int(luma[$0]) - Int(sent[$0])) <= screenSpeakerFrameLumaTolerance }
    }

    private func median(_ values: [Double]) -> Double {
        let sorted = values.sorted()
        let middle = sorted.count / 2
        return sorted.count % 2 == 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
    }
}

public struct ScreenWindowCandidate: Sendable, Equatable {
    public var id: UInt32
    public var bundleID: String?
    public var isOnScreen: Bool
    public var width: Double
    public var height: Double

    public init(id: UInt32, bundleID: String?, isOnScreen: Bool, width: Double, height: Double) {
        self.id = id
        self.bundleID = bundleID
        self.isOnScreen = isOnScreen
        self.width = width
        self.height = height
    }
}

public func selectScreenWindow(bundleID: String, among candidates: [ScreenWindowCandidate]) -> ScreenWindowCandidate? {
    candidates
        .filter { $0.isOnScreen && $0.bundleID == bundleID }
        .max { $0.width * $0.height < $1.width * $1.height }
}

public enum ScreenWindowSearchState: Sendable, Equatable {
    case notStarted
    case capturing(windowID: UInt32)
    case windowGone
}

public enum ScreenWindowSearchAction: Sendable, Equatable {
    case startCapture(windowID: UInt32)
    case retry(after: Double)
    case nothing
}

public func nextScreenWindowAction(
    bundleID: String,
    state: ScreenWindowSearchState,
    among candidates: [ScreenWindowCandidate]
) -> ScreenWindowSearchAction {
    if case .capturing(let id) = state, candidates.contains(where: { $0.id == id }) {
        return .nothing
    }
    guard let chosen = selectScreenWindow(bundleID: bundleID, among: candidates) else {
        return .retry(after: screenWindowRetryInterval)
    }
    return .startCapture(windowID: chosen.id)
}

public func fitScreenSize(width: Int, height: Int) -> (width: Int, height: Int) {
    if width <= screenMaxWidth && height <= screenMaxHeight { return (width, height) }
    if width * screenMaxHeight >= height * screenMaxWidth {
        return (screenMaxWidth, max(1, height * screenMaxWidth / width))
    }
    return (max(1, width * screenMaxHeight / height), screenMaxHeight)
}
