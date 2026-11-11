import CoreAudio

public enum OutputRoute: Sendable, Equatable {
    case builtInSpeaker
    case headphones
    case bluetooth
    case other

    public var marksDuplicates: Bool {
        switch self {
        case .builtInSpeaker, .bluetooth, .other: return true
        case .headphones: return false
        }
    }
}

private func fourCC(_ code: String) -> UInt32 {
    code.utf8.reduce(0) { $0 << 8 | UInt32($1) }
}

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

public func currentOutputRoute() throws -> OutputRoute {
    let device = try audioProperty(
        AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice, default: AudioObjectID(0))
    let transportType = try audioProperty(device, kAudioDevicePropertyTransportType, default: UInt32(0))
    let dataSource = try? audioProperty(
        device, kAudioDevicePropertyDataSource, scope: kAudioDevicePropertyScopeOutput, default: UInt32(0))
    return outputRoute(transportType: transportType, dataSource: dataSource)
}
