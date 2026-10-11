import Testing
import HelperCore

@Suite("タップの機器の記録行")
struct TapDevicesTests {
    private let speaker = TapDevice(uid: "BuiltInSpeakerDevice", name: "MacBook Proのスピーカー")
    private let airPods = TapDevice(uid: "AA-BB-CC", name: "AirPods")

    @Test("すべて読めたとき、uid(name) の形で 3 つを 1 行に並べる")
    func allReadable() {
        let line = tapDevicesLine(
            aggregateMain: airPods,
            defaultOutput: speaker,
            processes: [TapProcessDevices(pid: 1234, devices: [airPods], isRunningOutput: true)]
        )
        #expect(
            line == "tap devices: aggregate-main=AA-BB-CC(AirPods) default-output=BuiltInSpeakerDevice(MacBook Proのスピーカー) process[1234]=[AA-BB-CC(AirPods)] running-output=true"
        )
        #expect(!line.contains("\n"))
    }

    @Test("機器そのものが読めないときは ?")
    func unreadableDevices() {
        let line = tapDevicesLine(aggregateMain: nil, defaultOutput: nil, processes: [])
        #expect(line == "tap devices: aggregate-main=? default-output=?")
    }

    @Test("uid だけ・name だけ読めないときは、その部分だけ ?")
    func partiallyReadableDevice() {
        let line = tapDevicesLine(
            aggregateMain: TapDevice(uid: nil, name: "AirPods"),
            defaultOutput: TapDevice(uid: "BuiltInSpeakerDevice", name: nil),
            processes: []
        )
        #expect(line == "tap devices: aggregate-main=?(AirPods) default-output=BuiltInSpeakerDevice(?)")
    }

    @Test("プロセスの pid・機器の一覧・running-output が読めないときは ?")
    func unreadableProcessValues() {
        let line = tapDevicesLine(
            aggregateMain: airPods,
            defaultOutput: airPods,
            processes: [TapProcessDevices(pid: nil, devices: nil, isRunningOutput: nil)]
        )
        #expect(
            line == "tap devices: aggregate-main=AA-BB-CC(AirPods) default-output=AA-BB-CC(AirPods) process[?]=? running-output=?"
        )
    }

    @Test("running-output が false のときは false と出す")
    func notRunningOutput() {
        let line = tapDevicesLine(
            aggregateMain: airPods,
            defaultOutput: airPods,
            processes: [TapProcessDevices(pid: 7, devices: [airPods], isRunningOutput: false)]
        )
        #expect(line.hasSuffix("process[7]=[AA-BB-CC(AirPods)] running-output=false"))
    }

    @Test("プロセスが複数なら、全件を渡された順に出し、機器が複数ならコンマで区切る")
    func multipleProcesses() {
        let line = tapDevicesLine(
            aggregateMain: airPods,
            defaultOutput: speaker,
            processes: [
                TapProcessDevices(pid: 100, devices: [airPods, speaker], isRunningOutput: true),
                TapProcessDevices(pid: 200, devices: [speaker], isRunningOutput: false),
                TapProcessDevices(pid: 300, devices: nil, isRunningOutput: nil),
            ]
        )
        #expect(
            line == "tap devices: aggregate-main=AA-BB-CC(AirPods) default-output=BuiltInSpeakerDevice(MacBook Proのスピーカー) process[100]=[AA-BB-CC(AirPods),BuiltInSpeakerDevice(MacBook Proのスピーカー)] running-output=true process[200]=[BuiltInSpeakerDevice(MacBook Proのスピーカー)] running-output=false process[300]=? running-output=?"
        )
    }

    @Test("機器の一覧が空のときは []")
    func emptyDeviceList() {
        let line = tapDevicesLine(
            aggregateMain: airPods,
            defaultOutput: airPods,
            processes: [TapProcessDevices(pid: 9, devices: [], isRunningOutput: false)]
        )
        #expect(line.hasSuffix("process[9]=[] running-output=false"))
    }

    @Test("フレームが届かないと判定する時間は 10 秒")
    func judgementDelay() {
        #expect(tapSilentJudgementDelay == .seconds(10))
    }
}
