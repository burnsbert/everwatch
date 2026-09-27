import Foundation
import Testing

@Suite("Backend launch configuration")
struct BackendConfigTests {
    @Test("home and runtime default locations")
    func defaults() {
        let home = ShellPaths.everwatchHome(environment: [:], userHome: "/Users/t")
        #expect(home == "/Users/t/Library/Application Support/Everwatch")
        #expect(ShellPaths.runtimeDirectory(environment: [:], everwatchHome: home) == home + "/runtime/current")
    }

    @Test("EVERWATCH_HOME and EVERWATCH_RUNTIME override; empty values are ignored")
    func overrides() {
        #expect(ShellPaths.everwatchHome(environment: ["EVERWATCH_HOME": "/tmp/h"], userHome: "/Users/t") == "/tmp/h")
        #expect(ShellPaths.everwatchHome(environment: ["EVERWATCH_HOME": ""], userHome: "/U") == "/U/Library/Application Support/Everwatch")
        #expect(ShellPaths.runtimeDirectory(environment: ["EVERWATCH_RUNTIME": "/src/everwatch"], everwatchHome: "/h") == "/src/everwatch")
        #expect(ShellPaths.runtimeDirectory(environment: ["EVERWATCH_RUNTIME": ""], everwatchHome: "/h") == "/h/runtime/current")
    }

    @Test("runtime validity checks for the package entry point")
    func runtimeValid() {
        var asked: [String] = []
        let ok = ShellPaths.runtimeLooksValid("/r") { asked.append($0); return true }
        #expect(ok)
        #expect(asked == ["/r/everwatch/__main__.py"])
        #expect(!ShellPaths.runtimeLooksValid("/r") { _ in false })
    }

    @Test("launch: exact argv, env and working directory (§3.1)")
    func launch() {
        let launch = BackendLaunch.make(python: "/opt/homebrew/bin/python3", runtimeDirectory: "/rt", everwatchHome: "/h",
                                        token: "tok", baseEnvironment: ["PATH": "/usr/bin", "EVERWATCH_NO_SOUND": "1"])
        #expect(launch.executable == "/opt/homebrew/bin/python3")
        #expect(launch.arguments == ["-m", "everwatch", "serve", "--port", "0", "--parent-pipe"])
        #expect(launch.workingDirectory == "/rt")
        #expect(launch.environment["PYTHONPATH"] == "/rt")
        #expect(launch.environment["EVERWATCH_TOKEN"] == "tok")
        #expect(launch.environment["EVERWATCH_HOME"] == "/h")
        #expect(launch.environment["EVERWATCH_SHELL"] == "1")
        #expect(launch.environment["PYTHONUNBUFFERED"] == "1")
        #expect(launch.environment["PYTHONIOENCODING"] == "utf-8")
        #expect(launch.environment["PATH"] == "/usr/bin")
        #expect(launch.environment["EVERWATCH_NO_SOUND"] == "1")
    }

    @Test("launch prepends the runtime to an existing PYTHONPATH")
    func pythonPath() {
        let launch = BackendLaunch.make(python: "p", runtimeDirectory: "/rt", everwatchHome: "/h", token: "t",
                                        baseEnvironment: ["PYTHONPATH": "/other", "EVERWATCH_TOKEN": "stale"])
        #expect(launch.environment["PYTHONPATH"] == "/rt:/other")
        #expect(launch.environment["EVERWATCH_TOKEN"] == "t")
        let empty = BackendLaunch.make(python: "p", runtimeDirectory: "/rt", everwatchHome: "/h", token: "t", baseEnvironment: ["PYTHONPATH": ""])
        #expect(empty.environment["PYTHONPATH"] == "/rt")
    }
}

@Suite("Restart and reconnect backoff")
struct BackoffTests {
    @Test("1s, 2s, 4s, then give up after more than 3 crashes in 60s")
    func schedule() {
        var policy = RestartPolicy()
        #expect(policy.recordCrash(at: 0) == .restart(after: 1))
        #expect(policy.recordCrash(at: 5) == .restart(after: 2))
        #expect(policy.recordCrash(at: 10) == .restart(after: 4))
        #expect(policy.recordCrash(at: 20) == .giveUp)
    }

    @Test("old crashes age out of the 60s window")
    func window() {
        var policy = RestartPolicy()
        #expect(policy.recordCrash(at: 0) == .restart(after: 1))
        #expect(policy.recordCrash(at: 1) == .restart(after: 2))
        #expect(policy.recordCrash(at: 2) == .restart(after: 4))
        #expect(policy.recordCrash(at: 60.5) == .restart(after: 4)) // t=0 dropped (>= 60 s old), 3 in window
        #expect(policy.crashTimes == [1, 2, 60.5])
        #expect(policy.recordCrash(at: 200) == .restart(after: 1))  // quiet period resets the schedule
    }

    @Test("reset clears history (manual retry)")
    func reset() {
        var policy = RestartPolicy()
        for t in 0..<4 { _ = policy.recordCrash(at: TimeInterval(t)) }
        policy.reset()
        #expect(policy.crashTimes.isEmpty)
        #expect(policy.recordCrash(at: 5) == .restart(after: 1))
    }

    @Test("delay index clamps to the last configured delay")
    func clamp() {
        var policy = RestartPolicy(delays: [3], window: 60, maxCrashesInWindow: 5)
        #expect(policy.recordCrash(at: 0) == .restart(after: 3))
        #expect(policy.recordCrash(at: 1) == .restart(after: 3))
    }

    @Test("decide: BackendExitCode.tempFail restarts immediately and never counts as a crash")
    func decideTempFail() {
        var policy = RestartPolicy()
        #expect(policy.decide(exitStatus: BackendExitCode.tempFail, at: 0) == .restart(after: 0))
        #expect(policy.crashTimes.isEmpty)
        // Even after the crash limit would otherwise be exhausted, a
        // tempFail exit still restarts immediately and still doesn't count.
        for t in 0..<5 { _ = policy.recordCrash(at: TimeInterval(t)) }
        #expect(policy.decide(exitStatus: BackendExitCode.tempFail, at: 5) == .restart(after: 0))
        #expect(policy.crashTimes.count == 5)
    }

    @Test("decide: any other exit status -- including a normal 0 -- is recorded as a crash")
    func decideOtherStatuses() {
        var policy = RestartPolicy()
        #expect(policy.decide(exitStatus: 0, at: 0) == .restart(after: 1))
        #expect(policy.decide(exitStatus: 1, at: 5) == .restart(after: 2))
        #expect(policy.crashTimes == [0, 5])
    }

    @Test("BackendExitCode.tempFail is sysexits.h EX_TEMPFAIL (75), matching everwatch.cli.EX_TEMPFAIL")
    func tempFailValue() {
        #expect(BackendExitCode.tempFail == 75)
    }

    @Test("SSE reconnect doubles from the server retry and caps at 30s")
    func sseReconnect() {
        #expect(SSEReconnect.delay(consecutiveFailures: 0, serverRetryMilliseconds: nil) == 2)
        #expect(SSEReconnect.delay(consecutiveFailures: 1, serverRetryMilliseconds: nil) == 4)
        #expect(SSEReconnect.delay(consecutiveFailures: 0, serverRetryMilliseconds: 500) == 0.5)
        #expect(SSEReconnect.delay(consecutiveFailures: 3, serverRetryMilliseconds: 500) == 4)
        #expect(SSEReconnect.delay(consecutiveFailures: 10, serverRetryMilliseconds: nil) == 30)
        #expect(SSEReconnect.delay(consecutiveFailures: 1000, serverRetryMilliseconds: nil) == 30)
        #expect(SSEReconnect.delay(consecutiveFailures: -3, serverRetryMilliseconds: -10) == 0)
    }
}

@Suite("WebPolicy and native script (§3.8)")
struct WebPolicyTests {
    let policy = WebPolicy(port: 50123)

    @Test("allows only the backend origin and blank pages")
    func allow() {
        #expect(policy.decide(URL(string: "http://127.0.0.1:50123/"), isMainFrame: true) == .allow)
        #expect(policy.decide(URL(string: "http://localhost:50123/?mode=compact"), isMainFrame: true) == .allow)
        #expect(policy.decide(URL(string: "http://LOCALHOST:50123/x"), isMainFrame: false) == .allow)
        #expect(policy.decide(URL(string: "about:blank"), isMainFrame: true) == .allow)
        #expect(policy.decide(URL(string: "about:srcdoc"), isMainFrame: false) == .allow)
    }

    @Test("other origins open externally from the main frame, else cancel")
    func external() {
        #expect(policy.decide(URL(string: "https://github.com/burnsbert"), isMainFrame: true) == .openExternally)
        #expect(policy.decide(URL(string: "http://127.0.0.1:9999/"), isMainFrame: true) == .openExternally)
        #expect(policy.decide(URL(string: "mailto:a@b.c"), isMainFrame: true) == .openExternally)
        #expect(policy.decide(URL(string: "https://evil.example/"), isMainFrame: false) == .cancel)
        #expect(policy.decide(URL(string: "file:///etc/passwd"), isMainFrame: true) == .cancel)
        #expect(policy.decide(URL(string: "x-apple.systempreferences:com.apple.preference.security"), isMainFrame: true) == .cancel)
        #expect(policy.decide(URL(string: "javascript:alert(1)"), isMainFrame: true) == .cancel)
        #expect(policy.decide(nil, isMainFrame: true) == .cancel)
        #expect(policy.decide(URL(string: "relative/path"), isMainFrame: true) == .cancel)
    }

    @Test("everwatch://retry triggers a backend retry from the main frame only")
    func retry() {
        #expect(policy.decide(WebPolicy.retryURL, isMainFrame: true) == .retryBackend)
        #expect(policy.decide(WebPolicy.retryURL, isMainFrame: false) == .cancel)
        #expect(policy.decide(URL(string: "everwatch://other"), isMainFrame: true) == .cancel)
    }

    @Test("before the handshake nothing http is the backend")
    func noPort() {
        let early = WebPolicy(port: nil)
        #expect(early.decide(URL(string: "http://127.0.0.1:50123/"), isMainFrame: true) == .openExternally)
        #expect(!early.acceptsBridgeMessage(scheme: "http", host: "127.0.0.1", port: 50123))
    }

    @Test("bridge accepts messages only from the backend origin")
    func bridgeOrigin() {
        #expect(policy.acceptsBridgeMessage(scheme: "http", host: "127.0.0.1", port: 50123))
        #expect(policy.acceptsBridgeMessage(scheme: "HTTP", host: "localhost", port: 50123))
        #expect(!policy.acceptsBridgeMessage(scheme: "https", host: "127.0.0.1", port: 50123))
        #expect(!policy.acceptsBridgeMessage(scheme: "http", host: "127.0.0.2", port: 50123))
        #expect(!policy.acceptsBridgeMessage(scheme: "http", host: "127.0.0.1", port: 50124))
        #expect(!policy.acceptsBridgeMessage(scheme: "about", host: "", port: 0))
        #expect(!policy.acceptsBridgeMessage(scheme: nil, host: nil, port: nil))
    }

    @Test("page, events and goto URLs")
    func urls() {
        #expect(WebPolicy.pageURL(port: 5, compact: false).absoluteString == "http://127.0.0.1:5/")
        #expect(WebPolicy.pageURL(port: 5, compact: true).absoluteString == "http://127.0.0.1:5/?mode=compact")
        #expect(WebPolicy.eventsURL(port: 5, token: "a+b/c=").absoluteString == "http://127.0.0.1:5/api/events?token=a+b/c%3D"
                || WebPolicy.eventsURL(port: 5, token: "a+b/c=").absoluteString == "http://127.0.0.1:5/api/events?token=a%2Bb/c%3D")
        #expect(WebPolicy.eventsURL(port: 5, token: "Ab-_9").absoluteString == "http://127.0.0.1:5/api/events?token=Ab-_9")
        #expect(WebPolicy.gotoURL(port: 5, uid: "C2F1-AB:9")?.absoluteString == "http://127.0.0.1:5/api/sessions/C2F1-AB:9/goto")
        #expect(WebPolicy.gotoURL(port: 5, uid: "../x y")?.absoluteString == "http://127.0.0.1:5/api/sessions/..%2Fx%20y/goto")
        #expect(WebPolicy.gotoURL(port: 5, uid: "") == nil)
    }

    @Test("token is base64url without padding")
    func base64url() {
        #expect(NativeScript.base64url([0xfb, 0xff, 0xfe]) == "-__-")
        #expect(NativeScript.base64url([0x00]) == "AA")
        #expect(NativeScript.base64url(Array(repeating: 0xAB, count: 32)).count == 43)
        #expect(NativeScript.base64url([]) == "")
    }

    @Test("bootstrap script sets the token without putting it in a URL")
    func bootstrap() {
        let js = NativeScript.bootstrap(token: "tok\"</script>", shellVersion: "0.1.0")
        #expect(js.contains(#"n.token="tok\"<\/script>";"#))
        #expect(js.contains(#"n.shellVersion="0.1.0";"#))
        #expect(js.contains("n.shell=true;"))
        #expect(js.contains("window.everwatchNative=n;"))
        #expect(js.contains("n.queue.push(m)"))
        #expect(!js.contains("\n"))
    }
}

@Suite("ErrorPage (§4.2 check 1)")
struct ErrorPageTests {
    @Test("escapes HTML")
    func escape() {
        #expect(ErrorPage.escape(#"<a href="x">'&'</a>"#) == "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;")
        #expect(ErrorPage.escape("plain ◉") == "plain ◉")
    }

    @Test("python missing page offers copyable install commands and retry")
    func pythonMissing() {
        let html = ErrorPage.html(.pythonMissing(tried: ["/opt/homebrew/bin/python3: not found", "<b>"]))
        #expect(html.contains("Python 3.9 or newer"))
        #expect(html.contains("<pre>brew install python</pre>"))
        #expect(html.contains("<pre>xcode-select --install</pre>"))
        #expect(html.contains("/opt/homebrew/bin/python3: not found"))
        #expect(html.contains("&lt;b&gt;"))
        #expect(!html.contains("<b>"))
        #expect(html.contains("href=\"everwatch://retry\""))
        #expect(!html.contains("<script"))
    }

    @Test("python missing without tried list omits details")
    func pythonMissingNoDetails() {
        #expect(!ErrorPage.html(.pythonMissing(tried: [])).contains("<details>"))
    }

    @Test("runtime missing, backend failed and starting pages")
    func otherKinds() {
        let runtime = ErrorPage.html(.runtimeMissing(path: "/x/<rt>"))
        #expect(runtime.contains("/x/&lt;rt&gt;"))
        #expect(runtime.contains("install.sh"))
        let failed = ErrorPage.html(.backendFailed(detail: "Traceback <boom>"))
        #expect(failed.contains("Traceback &lt;boom&gt;"))
        #expect(failed.contains("everwatch://retry"))
        #expect(ErrorPage.html(.backendFailed(detail: "")).contains("(no output)"))
        let starting = ErrorPage.html(.starting)
        #expect(starting.contains("Starting Everwatch"))
        #expect(!starting.contains("everwatch://retry"))
    }
}
