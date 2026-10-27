import Foundation

public protocol LiveTap {
    func start() throws -> AsyncThrowingStream<CapturedAudio, Error>
    func stop()
    var hasReceivedFrames: Bool { get }
    func currentLine() -> String
}

public protocol LiveMicrophone {
    func requestPermission() async throws
    func start() throws -> AsyncThrowingStream<CapturedAudio, Error>
    func stop()
}

public protocol LiveInputUsage {
    func readProcesses() -> [InputProcess]?
    func observe(_ onChange: @escaping @Sendable () -> Void) -> () -> Void
}

public protocol LiveClock {
    func now() -> UInt64
    func sleep(for duration: Duration) async throws
}

public protocol LiveScreenSource {
    var events: AsyncStream<HelperEvent> { get }
    func run() async
    func stop()
}

public enum LiveScreen {
    case off
    case denied
    case capture((UInt64) -> any LiveScreenSource)
}

public struct LiveDevices {
    public let tap: any LiveTap
    public let microphone: any LiveMicrophone
    public let makeTranscriber: (Track) -> any Transcriber
    public let makeDiarizer: () -> (any SpeakerDiarizer)?
    public let inputUsage: any LiveInputUsage
    public let screen: LiveScreen
    public let clock: any LiveClock

    public init(
        tap: any LiveTap, microphone: any LiveMicrophone,
        makeTranscriber: @escaping (Track) -> any Transcriber,
        makeDiarizer: @escaping () -> (any SpeakerDiarizer)?,
        inputUsage: any LiveInputUsage, screen: LiveScreen, clock: any LiveClock
    ) {
        self.tap = tap
        self.microphone = microphone
        self.makeTranscriber = makeTranscriber
        self.makeDiarizer = makeDiarizer
        self.inputUsage = inputUsage
        self.screen = screen
        self.clock = clock
    }
}
