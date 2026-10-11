import CoreAudio
import Foundation

/// タップが無音かどうかを判定するまでの時間。開始からこの時間、フレームのあるバッファが 1 つも届かなければ無音と見なす。
public let tapSilentJudgementDelay: Duration = .seconds(10)

/// 記録する機器 1 件。読めなかった部分は nil。
public struct TapDevice: Sendable, Equatable {
    public var uid: String?
    public var name: String?

    public init(uid: String?, name: String?) {
        self.uid = uid
        self.name = name
    }
}

/// 記録する対象プロセス 1 件。読めなかった値は nil。
public struct TapProcessDevices: Sendable, Equatable {
    public var pid: Int32?
    /// 出力スコープの `kAudioProcessPropertyDevices`。
    public var devices: [TapDevice]?
    public var isRunningOutput: Bool?

    public init(pid: Int32?, devices: [TapDevice]?, isRunningOutput: Bool?) {
        self.pid = pid
        self.devices = devices
        self.isRunningOutput = isRunningOutput
    }
}

private func describe(_ device: TapDevice?) -> String {
    guard let device else { return "?" }
    return "\(device.uid ?? "?")(\(device.name ?? "?"))"
}

/// 集約デバイスの主のサブデバイス・既定の出力・対象プロセスの出力先を 1 行にする。読めない値は `?`。Core Audio は呼ばない。
public func tapDevicesLine(aggregateMain: TapDevice?, defaultOutput: TapDevice?, processes: [TapProcessDevices]) -> String {
    var parts = [
        "tap devices:",
        "aggregate-main=\(describe(aggregateMain))",
        "default-output=\(describe(defaultOutput))",
    ]
    for process in processes {
        let devices = process.devices.map { "[" + $0.map { describe($0) }.joined(separator: ",") + "]" } ?? "?"
        let running = process.isRunningOutput.map { $0 ? "true" : "false" } ?? "?"
        parts.append("process[\(process.pid.map(String.init) ?? "?")]=\(devices)")
        parts.append("running-output=\(running)")
    }
    return parts.joined(separator: " ")
}

private func deviceString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    (try? audioProperty(object, selector, default: "" as CFString)) as String?
}

private func tapDevice(object: AudioObjectID) -> TapDevice? {
    guard object != kAudioObjectUnknown else { return nil }
    return TapDevice(
        uid: deviceString(object, kAudioDevicePropertyDeviceUID), name: deviceString(object, kAudioObjectPropertyName))
}

private func tapDevice(uid: String) -> TapDevice {
    var translated = AudioObjectID(kAudioObjectUnknown)
    var cfUID = uid as CFString
    var address = audioAddress(kAudioHardwarePropertyTranslateUIDToDevice)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let status = withUnsafeMutablePointer(to: &cfUID) { qualifier in
        AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, UInt32(MemoryLayout<CFString>.size), qualifier, &size,
            &translated)
    }
    let name = status == noErr && translated != kAudioObjectUnknown ? deviceString(translated, kAudioObjectPropertyName) : nil
    return TapDevice(uid: uid, name: name)
}

private func processDevices(_ process: AudioObjectID) -> [TapDevice]? {
    var address = audioAddress(kAudioProcessPropertyDevices, scope: kAudioObjectPropertyScopeOutput)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(process, &address, 0, nil, &size) == noErr else { return nil }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(process, &address, 0, nil, &size, &ids) == noErr else { return nil }
    return ids.prefix(Int(size) / MemoryLayout<AudioObjectID>.size).map { tapDevice(object: $0) ?? TapDevice(uid: nil, name: nil) }
}

/// いま読める値から、記録の 1 行を作る。読めない値は `?` にして、throw しない。
/// `aggregateMainUID` は ProcessTap が集約デバイスの主のサブデバイスに使った UID（作る前や読めないときは nil）。
public func currentTapDevices(targets: [AudioProcess], aggregateMainUID: String?) -> String {
    let defaultOutput = (try? audioProperty(
        AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice,
        default: AudioObjectID(kAudioObjectUnknown))).flatMap { tapDevice(object: $0) }
    let processes = targets.map { target -> TapProcessDevices in
        let pid = try? audioProperty(target.objectID, kAudioProcessPropertyPID, default: Int32(0))
        let running = try? audioProperty(target.objectID, kAudioProcessPropertyIsRunningOutput, default: UInt32(0))
        return TapProcessDevices(pid: pid, devices: processDevices(target.objectID), isRunningOutput: running.map { $0 != 0 })
    }
    return tapDevicesLine(
        aggregateMain: aggregateMainUID.map { tapDevice(uid: $0) }, defaultOutput: defaultOutput, processes: processes)
}
