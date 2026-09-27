import Foundation
import Testing

/// Fake filesystem + interpreter. Records every path it was asked to run.
final class FakePythonProbe: PythonProbing {
    var executables: Set<String>
    var versions: [String: PythonVersion]
    var devDir: String?
    private(set) var versionQueries: [String] = []
    private(set) var executableQueries: [String] = []
    private(set) var developerDirQueries = 0

    init(executables: Set<String> = [], versions: [String: PythonVersion] = [:], devDir: String? = nil) {
        self.executables = executables
        self.versions = versions
        self.devDir = devDir
    }

    func isExecutableFile(atPath path: String) -> Bool {
        executableQueries.append(path)
        return executables.contains(path)
    }

    func version(ofPythonAt path: String) -> PythonVersion? {
        versionQueries.append(path)
        return versions[path]
    }

    func developerDirectory() -> String? {
        developerDirQueries += 1
        return devDir
    }
}

@Suite("PythonLocator")
struct PythonLocatorTests {
    let home = "/Users/t/Library/Application Support/Everwatch"
    let brew = "/opt/homebrew/bin/python3"
    let intelBrew = "/usr/local/bin/python3"
    let pyOrg = "/Library/Frameworks/Python.framework/Versions/Current/bin/python3"
    let system = "/usr/bin/python3"
    let clt = "/Library/Developer/CommandLineTools"

    func locator(_ probe: FakePythonProbe, env: [String: String] = [:]) -> PythonLocator {
        PythonLocator(environment: env, everwatchHome: home, probe: probe)
    }

    @Test("candidate order: override, venv, homebrew, python.org, system")
    func candidateOrder() {
        let probe = FakePythonProbe()
        let paths = locator(probe, env: ["EVERWATCH_PYTHON": "/x/python3"]).candidates().map(\.path)
        #expect(paths == ["/x/python3", home + "/venv/bin/python3", brew, intelBrew, pyOrg, system])
        let sources = locator(probe, env: ["EVERWATCH_PYTHON": "/x/python3"]).candidates().map(\.source)
        #expect(sources == [.override, .venv, .homebrew, .homebrew, .pythonOrg, .commandLineTools])
    }

    @Test("empty override is ignored and duplicates are removed")
    func overrideEdgeCases() {
        let probe = FakePythonProbe()
        #expect(locator(probe, env: ["EVERWATCH_PYTHON": ""]).candidates().first?.source == .venv)
        let dup = locator(probe, env: ["EVERWATCH_PYTHON": brew]).candidates()
        #expect(dup.filter { $0.path == brew }.count == 1)
        #expect(dup.first == PythonCandidate(path: brew, source: .override))
    }

    @Test("prefers Homebrew when present and new enough")
    func prefersHomebrew() {
        let probe = FakePythonProbe(executables: [brew, system], versions: [brew: PythonVersion(3, 13, 1), system: PythonVersion(3, 9, 6)],
                                    devDir: clt)
        #expect(locator(probe).locate() == .found(PythonCandidate(path: brew, source: .homebrew), PythonVersion(3, 13, 1)))
        #expect(probe.versionQueries == [brew])
        #expect(probe.developerDirQueries == 0)
    }

    @Test("venv python wins over Homebrew (tab colors)")
    func venvFirst() {
        let venv = home + "/venv/bin/python3"
        let probe = FakePythonProbe(executables: [venv, brew], versions: [venv: PythonVersion(3, 12), brew: PythonVersion(3, 13)])
        #expect(locator(probe).locate() == .found(PythonCandidate(path: venv, source: .venv), PythonVersion(3, 12)))
    }

    @Test("override that works is used first")
    func overrideUsed() {
        let probe = FakePythonProbe(executables: ["/x/py", brew], versions: ["/x/py": PythonVersion(3, 11), brew: PythonVersion(3, 13)])
        #expect(locator(probe, env: ["EVERWATCH_PYTHON": "/x/py"]).locate()
                == .found(PythonCandidate(path: "/x/py", source: .override), PythonVersion(3, 11)))
    }

    @Test("never touches /usr/bin/python3 without developer tools")
    func noCLTNoSystemPython() {
        // Even if the stub exists on disk, it must not be probed or run.
        let probe = FakePythonProbe(executables: [system], versions: [system: PythonVersion(3, 9, 6)], devDir: nil)
        let result = locator(probe).locate()
        guard case .notFound(let rejections) = result else {
            Issue.record("expected notFound, got \(result)")
            return
        }
        #expect(rejections.last == PythonRejection(candidate: PythonCandidate(path: system, source: .commandLineTools),
                                                   reason: .developerToolsMissing))
        #expect(!probe.versionQueries.contains(system))
        #expect(!probe.executableQueries.contains(system))
        #expect(probe.developerDirQueries == 1)
    }

    @Test("developer dir without python3 also skips the system stub")
    func devDirWithoutPython() {
        let probe = FakePythonProbe(executables: [system], versions: [system: PythonVersion(3, 9, 6)], devDir: clt)
        guard case .notFound(let rejections) = locator(probe).locate() else {
            Issue.record("expected notFound")
            return
        }
        #expect(rejections.last?.reason == .developerToolsMissing)
        #expect(!probe.versionQueries.contains(system))
    }

    @Test("empty developer dir string counts as missing")
    func emptyDevDir() {
        let probe = FakePythonProbe(executables: [system], versions: [system: PythonVersion(3, 9, 6)], devDir: "")
        guard case .notFound = locator(probe).locate() else {
            Issue.record("expected notFound")
            return
        }
        #expect(probe.versionQueries.isEmpty)
    }

    @Test("uses /usr/bin/python3 when CLT is installed")
    func systemPythonWithCLT() {
        let probe = FakePythonProbe(executables: [system, clt + "/usr/bin/python3"], versions: [system: PythonVersion(3, 9, 6)],
                                    devDir: clt)
        #expect(locator(probe).locate() == .found(PythonCandidate(path: system, source: .commandLineTools), PythonVersion(3, 9, 6)))
    }

    @Test("rejects too-old and unreadable interpreters, reporting each")
    func rejectsOldAndUnknown() {
        let probe = FakePythonProbe(executables: [brew, intelBrew], versions: [brew: PythonVersion(3, 8, 18)])
        guard case .notFound(let rejections) = locator(probe).locate() else {
            Issue.record("expected notFound")
            return
        }
        #expect(rejections.map(\.reason) == [.missing, .tooOld(PythonVersion(3, 8, 18)), .versionUnknown, .missing, .developerToolsMissing])
        let lines = PythonLocator.describe(rejections)
        #expect(lines.count == 5)
        #expect(lines[0].hasSuffix("not found"))
        #expect(lines[1] == "\(brew): Python 3.8.18 is older than 3.9")
        #expect(lines[2] == "\(intelBrew): could not read its version")
        #expect(lines[4] == "\(system): skipped (Command Line Tools not installed)")
    }

    @Test("3.9.0 is exactly the minimum")
    func minimumBoundary() {
        let probe = FakePythonProbe(executables: [brew], versions: [brew: PythonVersion(3, 9, 0)])
        #expect(locator(probe).locate() == .found(PythonCandidate(path: brew, source: .homebrew), PythonVersion(3, 9, 0)))
    }

    @Test("version string parsing")
    func versionParsing() {
        #expect(PythonVersion(string: "3.9.6") == PythonVersion(3, 9, 6))
        #expect(PythonVersion(string: "Python 3.13.15\n") == PythonVersion(3, 13, 15))
        #expect(PythonVersion(string: "3.12") == PythonVersion(3, 12, 0))
        #expect(PythonVersion(string: "3.14.0rc1") == PythonVersion(3, 14, 0))
        #expect(PythonVersion(string: "") == nil)
        #expect(PythonVersion(string: "3") == nil)
        #expect(PythonVersion(string: "3.x.1") == nil)
        #expect(PythonVersion(string: "3.9.6.1") == nil)
        #expect(PythonVersion(string: "3..6") == nil)
        #expect(PythonVersion(3, 9, 6).description == "3.9.6")
        #expect(PythonVersion(3, 10) > PythonVersion(3, 9, 99))
        #expect(PythonVersion(4, 0) > PythonVersion(3, 99))
    }
}
