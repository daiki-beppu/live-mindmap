import CWebRTCAPM

/// 10 ms（48 kHz・モノラルの 480 サンプル）ごとの参照と、マイクのエコー除去。
/// reverse はスピーカーに出た音（参照）、capture はマイクの音で、その場で書き換える。
/// 1 つの Task だけが呼ぶ。
public protocol EchoCanceller: Sendable {
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
public let echoFrameSamples = 480
public let echoSampleRate = 48_000

/// AEC3（`EchoCanceller3Config`）の設定。項目は同名の AEC3 の設定項目に写す。
public struct EchoCancellerSettings: Equatable, Sendable {
    /// `ep_strength.default_gain`: エコー経路の強さの初期値。
    public var epStrengthDefaultGain: Float

    public init(epStrengthDefaultGain: Float) {
        self.epStrengthDefaultGain = epStrengthDefaultGain
    }

    /// Issue #118 の計測の設定。固定コミットの AEC3 の既定値と同じ。変更前の数字を再現する基準なので、値を変えない。
    public static let baseline = EchoCancellerSettings(epStrengthDefaultGain: 1)

    /// 本番の設定（Issue #119）。`baseline` との違いは、エコー経路の強さの初期値を 1 から 0.01 に下げたことだけ。
    /// 漏れの無い条件では、開始直後に参照との相関が無いのに、既定の初期値（1）が発話を削る。
    /// 漏れのある条件では、5 秒以降の発話の残り方・漏れの低下量は変わらない（`docs/investigations/2026-10-04-aec-startup-config.md`）。
    public static let production = EchoCancellerSettings(epStrengthDefaultGain: 0.01)
}

/// 実際の WebRTC AEC3（`CWebRTCAPM`）。48 kHz・モノラル固定。
public final class WebRTCEchoCanceller: EchoCanceller, @unchecked Sendable {
    private let handle: ApmRef

    public init(settings: EchoCancellerSettings = .production) throws {
        var raw = ApmEchoSettings(ep_strength_default_gain: settings.epStrengthDefaultGain)
        guard let handle = apm_create(Int32(echoSampleRate), 1, &raw) else { throw EchoCancellationError.createFailed }
        self.handle = handle
    }

    deinit { apm_destroy(handle) }

    public func processReverse(_ frame: UnsafePointer<Float>) {
        let status = apm_process_reverse(handle, frame, Int32(echoFrameSamples))
        assert(status == 0, "apm_process_reverse が失敗した: \(status)")
    }

    public func processCapture(_ frame: UnsafeMutablePointer<Float>) {
        let status = apm_process_capture(handle, frame, Int32(echoFrameSamples))
        assert(status == 0, "apm_process_capture が失敗した: \(status)")
    }
}
