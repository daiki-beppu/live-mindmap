import CWebRTCAPM

/// 10 ms（48 kHz・モノラルの 480 サンプル）ごとの参照と、マイクのエコー除去。
/// reverse はスピーカーに出た音（参照）、capture はマイクの音で、その場で書き換える。
/// 1 つの Task だけが呼ぶ。
protocol EchoCanceller: Sendable {
    func processReverse(_ frame: UnsafePointer<Float>)
    func processCapture(_ frame: UnsafeMutablePointer<Float>)
}

public enum EchoCancellationError: Error, CustomStringConvertible {
    case createFailed

    public var description: String {
        switch self {
        case .createFailed: return "WebRTC AEC3 を初期化できない"
        }
    }
}

/// AEC に一度に渡すサンプルの数（48 kHz の 10 ms）。
let echoFrameSamples = 480
let echoSampleRate = 48_000

/// 実際の WebRTC AEC3（`CWebRTCAPM`）。48 kHz・モノラル固定。
final class WebRTCEchoCanceller: EchoCanceller, @unchecked Sendable {
    private let handle: ApmRef

    init() throws {
        guard let handle = apm_create(Int32(echoSampleRate), 1) else { throw EchoCancellationError.createFailed }
        self.handle = handle
    }

    deinit { apm_destroy(handle) }

    func processReverse(_ frame: UnsafePointer<Float>) {
        let status = apm_process_reverse(handle, frame, Int32(echoFrameSamples))
        assert(status == 0, "apm_process_reverse が失敗した: \(status)")
    }

    func processCapture(_ frame: UnsafeMutablePointer<Float>) {
        let status = apm_process_capture(handle, frame, Int32(echoFrameSamples))
        assert(status == 0, "apm_process_capture が失敗した: \(status)")
    }
}
