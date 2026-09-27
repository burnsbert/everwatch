import Foundation
import Testing

@Suite("Headless self-test mode")
struct SelfTestTests {
    @Test("only EVERWATCH_SELFTEST=1 exactly enters self-test mode")
    func requestedOnlyByExactValue() {
        #expect(SelfTestConfig.isRequested(environment: ["EVERWATCH_SELFTEST": "1"]))
        for value in ["", "0", "true", "yes", " 1", "1 ", "01"] {
            #expect(!SelfTestConfig.isRequested(environment: ["EVERWATCH_SELFTEST": value]), "value \(value)")
        }
        #expect(!SelfTestConfig.isRequested(environment: [:]))
        #expect(!SelfTestConfig.isRequested(environment: ["EVERWATCH_SELFTESTX": "1", "SELFTEST": "1"]))
    }

    @Test("requires a throwaway EVERWATCH_HOME, never the real data dir")
    func requiresTemporaryHome() {
        #expect(SelfTestConfig.make(environment: [:], userHome: "/Users/t") == .failure(.missingHome))
        #expect(SelfTestConfig.make(environment: ["EVERWATCH_HOME": ""], userHome: "/Users/t") == .failure(.missingHome))
        let real = "/Users/t/Library/Application Support/Everwatch"
        #expect(SelfTestConfig.make(environment: ["EVERWATCH_HOME": real], userHome: "/Users/t") == .failure(.realHome(real)))
        #expect(SelfTestConfig.make(environment: ["EVERWATCH_HOME": real + "/"], userHome: "/Users/t") == .failure(.realHome(real + "/")))
        #expect(SelfTestConfig.make(environment: ["EVERWATCH_HOME": "/Users/t/Library/Application Support/./Everwatch"],
                                    userHome: "/Users/t") == .failure(.realHome("/Users/t/Library/Application Support/./Everwatch")))
    }

    @Test("forces the sound kill switch and keeps the rest of the environment")
    func environmentAndDefaults() throws {
        let env = ["EVERWATCH_HOME": "/tmp/h", "EVERWATCH_RUNTIME": "/src", "EVERWATCH_NO_SOUND": "", "PATH": "/usr/bin"]
        let config = try SelfTestConfig.make(environment: env, userHome: "/Users/t").get()
        #expect(config.environment["EVERWATCH_NO_SOUND"] == "1")
        #expect(config.environment["EVERWATCH_HOME"] == "/tmp/h")
        #expect(config.environment["EVERWATCH_RUNTIME"] == "/src")
        #expect(config.environment["PATH"] == "/usr/bin")
        #expect(config.timeout == 30)
    }

    @Test("timeout: default 30 s, clamped to 5...120, junk ignored")
    func timeoutParsing() {
        #expect(SelfTestConfig.timeout(from: nil) == 30)
        #expect(SelfTestConfig.timeout(from: "12") == 12)
        #expect(SelfTestConfig.timeout(from: " 45.5 ") == 45.5)
        #expect(SelfTestConfig.timeout(from: "1") == 5)
        #expect(SelfTestConfig.timeout(from: "999") == 120)
        #expect(SelfTestConfig.timeout(from: "abc") == 30)
        #expect(SelfTestConfig.timeout(from: "nan") == 30)
        #expect(SelfTestConfig.timeout(from: "inf") == 30)
        let config = try? SelfTestConfig.make(environment: ["EVERWATCH_HOME": "/tmp/h", "EVERWATCH_SELFTEST_TIMEOUT": "20"],
                                              userHome: "/U").get()
        #expect(config?.timeout == 20)
    }

    @Test("backend runs as serve --demo --selftest, after the normal argv")
    func backendArguments() {
        #expect(SelfTestConfig.backendArguments == ["--demo", "--selftest"])
        let launch = BackendLaunch.make(python: "p", runtimeDirectory: "/rt", everwatchHome: "/h", token: "t",
                                        baseEnvironment: [:], extraArguments: SelfTestConfig.backendArguments)
        #expect(launch.arguments == ["-m", "everwatch", "serve", "--port", "0", "--parent-pipe", "--demo", "--selftest"])
        let normal = BackendLaunch.make(python: "p", runtimeDirectory: "/rt", everwatchHome: "/h", token: "t", baseEnvironment: [:])
        #expect(normal.arguments == BackendLaunch.arguments)
    }

    @Test("report passes only when every required check was recorded and passed")
    func reportVerdict() {
        var report = SelfTestReport()
        #expect(!report.passed)
        #expect(report.exitCode == 1)
        #expect(report.missing == SelfTestReport.requiredChecks)

        for name in SelfTestReport.requiredChecks { report.check(name, true) }
        #expect(report.missing.isEmpty)
        #expect(report.passed)
        #expect(report.exitCode == 0)

        var failed = report
        failed.check("extra", false, "boom")
        #expect(!failed.passed)
        #expect(failed.exitCode == 1)

        var aborted = report
        aborted.failure = "timeout"
        #expect(!aborted.passed)

        var partial = SelfTestReport()
        for name in SelfTestReport.requiredChecks.dropLast() { partial.check(name, true) }
        #expect(!partial.passed)
        #expect(partial.missing == [SelfTestReport.requiredChecks.last!])
    }

    @Test("report JSON is one parseable object with checks in order")
    func reportJSON() throws {
        var report = SelfTestReport()
        report.check("b_second", true, "fine")
        report.check("a_first", false, "✗ \"quoted\"\nline")
        report.note("port", 1234)
        let text = report.json(elapsed: 1.23456)
        #expect(!text.contains("\n"))
        let object = try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        #expect(object["ok"] as? Bool == false)
        #expect(object["failure"] is NSNull)
        #expect(object["elapsed_s"] as? Double == 1.235)
        let checks = try #require(object["checks"] as? [[String: Any]])
        #expect(checks.map { $0["name"] as? String } == ["b_second", "a_first"])
        #expect(checks[1]["detail"] as? String == "✗ \"quoted\"\nline")
        #expect((object["info"] as? [String: Any])?["port"] as? Int == 1234)
        #expect((object["missing"] as? [String])?.count == SelfTestReport.requiredChecks.count)

        report.failure = "timeout: step x"
        let failedObject = try #require(try JSONSerialization.jsonObject(with: Data(report.json(elapsed: 0).utf8)) as? [String: Any])
        #expect(failedObject["failure"] as? String == "timeout: step x")
    }
}
