import Foundation

/// Headless runtime self-test of the whole shell (`scripts/shell_selftest.sh`,
/// `make test-shell-integration`). It's entered only when the environment has
/// exactly `EVERWATCH_SELFTEST=1`. In that mode the app never shows a window,
/// never creates a status item, never registers hotkeys, never asks for any
/// permission, and runs the backend with `--demo --selftest`, which fakes
/// every probe and installer (no osascript, keychain, venv, or pip).
struct SelfTestConfig: Equatable {
    static let variable = "EVERWATCH_SELFTEST"
    static let timeoutVariable = "EVERWATCH_SELFTEST_TIMEOUT"
    static let defaultTimeout: TimeInterval = 30
    static let timeoutRange: ClosedRange<TimeInterval> = 5...120
    /// Appended to `BackendLaunch.arguments`.
    static let backendArguments = ["--demo", "--selftest"]

    enum Problem: Error, Equatable {
        /// EVERWATCH_HOME must name a throwaway dir supplied by the test.
        case missingHome
        /// EVERWATCH_HOME must not be the real data dir.
        case realHome(String)
    }

    /// Overall hard deadline for the run.
    let timeout: TimeInterval
    /// Environment for `BackendSupervisor`: the caller's, with the sound kill
    /// switch forced on.
    let environment: [String: String]

    /// True only for the exact value "1", so nothing else (a stray "0",
    /// "true", or an empty value) can switch a production launch into it.
    static func isRequested(environment: [String: String]) -> Bool {
        environment[variable] == "1"
    }

    static func make(environment: [String: String], userHome: String) -> Result<SelfTestConfig, Problem> {
        guard let home = environment["EVERWATCH_HOME"], !home.isEmpty else { return .failure(.missingHome) }
        let realHome = ShellPaths.everwatchHome(environment: [:], userHome: userHome)
        if normalized(home) == normalized(realHome) { return .failure(.realHome(home)) }
        var env = environment
        env["EVERWATCH_NO_SOUND"] = "1"
        return .success(SelfTestConfig(timeout: timeout(from: environment[timeoutVariable]), environment: env))
    }

    static func timeout(from raw: String?) -> TimeInterval {
        guard let raw, let value = Double(raw.trimmingCharacters(in: .whitespaces)), value.isFinite else {
            return defaultTimeout
        }
        return min(max(value, timeoutRange.lowerBound), timeoutRange.upperBound)
    }

    private static func normalized(_ path: String) -> String {
        var p = (path as NSString).standardizingPath
        while p.count > 1, p.hasSuffix("/") { p.removeLast() }
        return p
    }
}

/// The machine-readable result the self-test prints to stdout (one JSON line).
struct SelfTestReport {
    struct Check: Equatable {
        let name: String
        let ok: Bool
        let detail: String
    }

    /// Every one of these must be recorded, and pass, for the run to pass.
    static let requiredChecks = [
        "activation_policy_prohibited",
        "handshake",
        "bridge_ready",
        "native_sse_hello",
        "status_title",
        "page_token_injected",
        "page_rendered_sessions",
        "page_api_token_auth",
        "page_sse_token_auth",
        "page_title_matches_native",
        "native_state_event",
        "bridge_web_to_shell",
        "bridge_shell_to_web",
        "bridge_rejects_foreign_origin",
        "restart_after_crash",
        "reconnect_after_crash",
        "restart_after_tempfail",
        "reconnect_after_tempfail",
        "clean_shutdown",
        "silent_responder_chain",
        "never_visible",
    ]

    private(set) var checks: [Check] = []
    /// Set when the run aborted (timeout, backend failure, thrown error).
    var failure: String?
    /// Free-form facts for the log (ports, pids, timings).
    private(set) var info: [String: Any] = [:]

    mutating func check(_ name: String, _ ok: Bool, _ detail: String = "") {
        checks.append(Check(name: name, ok: ok, detail: detail))
    }

    mutating func note(_ key: String, _ value: Any) {
        info[key] = value
    }

    /// Required checks that were never recorded.
    var missing: [String] {
        let seen = Set(checks.map(\.name))
        return Self.requiredChecks.filter { !seen.contains($0) }
    }

    var passed: Bool {
        failure == nil && missing.isEmpty && checks.allSatisfy(\.ok)
    }

    var exitCode: Int32 { passed ? 0 : 1 }

    func jsonObject(elapsed: TimeInterval) -> [String: Any] {
        var object: [String: Any] = [
            "ok": passed,
            "elapsed_s": (elapsed * 1000).rounded() / 1000,
            "checks": checks.map { ["name": $0.name, "ok": $0.ok, "detail": $0.detail] as [String: Any] },
            "missing": missing,
            "info": info,
        ]
        object["failure"] = failure ?? NSNull()
        return object
    }

    func json(elapsed: TimeInterval) -> String {
        JSONText.encode(jsonObject(elapsed: elapsed))
    }
}
