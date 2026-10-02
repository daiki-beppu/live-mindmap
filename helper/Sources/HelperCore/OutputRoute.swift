import CoreAudio

/// 既定の出力先の種類。会議の音がスピーカーから出ると、相手の声がマイクにも入る。
public enum OutputRoute: Sendable, Equatable {
    case builtInSpeaker
    case headphones
    case bluetooth
    /// USB・HDMI・AirPlay など。外部スピーカーとして扱う。
    case other

    /// `自分` の確定結果の重複判定をかけるか。イヤホンと Bluetooth（AirPods など）は声が漏れにくいので、かけない。
    public var marksDuplicates: Bool {
        switch self {
        case .builtInSpeaker, .other: return true
        case .headphones, .bluetooth: return false
        }
    }
}

/// Core Audio の four-char code（例: 'ispk'）を UInt32 にする。
private func fourCC(_ code: String) -> UInt32 {
    code.utf8.reduce(0) { $0 << 8 | UInt32($1) }
}

/// TransportType と DataSource から出力先を分類する。
/// 内蔵の DataSource は、スピーカーが 'ispk'、ヘッドフォンジャックが 'hdpn'。読めない（nil）ときは、スピーカーしかない Mac として内蔵スピーカーにする。
public func outputRoute(transportType: UInt32, dataSource: UInt32?) -> OutputRoute {
    switch transportType {
    case kAudioDeviceTransportTypeBuiltIn:
        return dataSource == fourCC("hdpn") ? .headphones : .builtInSpeaker
    case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE:
        return .bluetooth
    default:
        return .other
    }
}

/// 既定の出力デバイス（会議アプリの音が出る先）の種類を Core Audio から読む。
public func currentOutputRoute() throws -> OutputRoute {
    let device = try audioProperty(
        AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice, default: AudioObjectID(0))
    let transportType = try audioProperty(device, kAudioDevicePropertyTransportType, default: UInt32(0))
    // DataSource は出力スコープの値。持たないデバイスでは読めないので nil にする。
    let dataSource = try? audioProperty(
        device, kAudioDevicePropertyDataSource, scope: kAudioDevicePropertyScopeOutput, default: UInt32(0))
    return outputRoute(transportType: transportType, dataSource: dataSource)
}
