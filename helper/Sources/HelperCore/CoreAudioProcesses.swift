import AppKit
import CoreAudio

public enum CoreAudioError: Error, CustomStringConvertible {
    case status(String, OSStatus)

    public var description: String {
        switch self {
        case let .status(operation, status): return "\(operation) に失敗した（OSStatus \(status)）"
        }
    }
}

func audioAddress(
    _ selector: AudioObjectPropertySelector, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: scope,
        mElement: kAudioObjectPropertyElementMain
    )
}

func audioProperty<T>(
    _ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, default initial: T
) throws -> T {
    var address = audioAddress(selector, scope: scope)
    var value = initial
    var size = UInt32(MemoryLayout<T>.size)
    let status = withUnsafeMutableBytes(of: &value) { bytes in
        AudioObjectGetPropertyData(object, &address, 0, nil, &size, bytes.baseAddress!)
    }
    guard status == noErr else { throw CoreAudioError.status("プロパティ \(selector) の取得", status) }
    return value
}

/// Core Audio のプロセス一覧（bundle id を持つものだけ）。
public func currentAudioProcesses() throws -> [AudioProcess] {
    var address = audioAddress(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    var status = AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size)
    guard status == noErr else { throw CoreAudioError.status("プロセス一覧のサイズ取得", status) }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids)
    guard status == noErr else { throw CoreAudioError.status("プロセス一覧の取得", status) }

    return ids.compactMap { id in
        guard let bundleID = try? audioProperty(id, kAudioProcessPropertyBundleID, default: "" as CFString) as String,
              !bundleID.isEmpty
        else { return nil }
        let running = (try? audioProperty(id, kAudioProcessPropertyIsRunningOutput, default: UInt32(0))) ?? 0
        return AudioProcess(objectID: id, bundleID: bundleID, isRunningOutput: running != 0)
    }
}

/// 起動中の通常アプリ（Dock に出るもの）。
public func currentRunningApps() -> [RunningApp] {
    NSWorkspace.shared.runningApplications.compactMap { app in
        guard app.activationPolicy == .regular, let bundleID = app.bundleIdentifier else { return nil }
        return RunningApp(bundleID: bundleID, name: app.localizedName ?? bundleID)
    }
}

// 検証用（マージしない）: helper だけの変更で CI のジョブの振り分けを確かめる
