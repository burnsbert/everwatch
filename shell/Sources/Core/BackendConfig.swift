import Foundation

/// Where Everwatch keeps its data and runtime payload (§3.7, §0 point 2).
enum ShellPaths {
    /// `EVERWATCH_HOME`, else `~/Library/Application Support/Everwatch`.
    static func everwatchHome(environment: [String: String], userHome: String) -> String {
        if let home = environment["EVERWATCH_HOME"], !home.isEmpty { return home }
        return userHome + "/Library/Application Support/Everwatch"
    }

    /// Directory placed on PYTHONPATH; it must contain the `everwatch/` package.
    /// `EVERWATCH_RUNTIME` (dev: point at a checkout), else `<home>/runtime/current`.
    static func runtimeDirectory(environment: [String: String], everwatchHome: String) -> String {
        if let runtime = environment["EVERWATCH_RUNTIME"], !runtime.isEmpty { return runtime }
        return everwatchHome + "/runtime/current"
    }

    /// True when `<runtime>/everwatch/__main__.py` exists.
    static func runtimeLooksValid(_ runtimeDirectory: String, fileExists: (String) -> Bool) -> Bool {
        fileExists(runtimeDirectory + "/everwatch/__main__.py")
    }
}

/// The exact process the supervisor spawns (§3.1).
struct BackendLaunch: Equatable {
    let executable: String
    let arguments: [String]
    let environment: [String: String]
    let workingDirectory: String

    static let arguments = ["-m", "everwatch", "serve", "--port", "0", "--parent-pipe"]

    static func make(python: String,
                     runtimeDirectory: String,
                     everwatchHome: String,
                     token: String,
                     baseEnvironment: [String: String],
                     extraArguments: [String] = []) -> BackendLaunch {
        var env = baseEnvironment
        if let existing = env["PYTHONPATH"], !existing.isEmpty {
            env["PYTHONPATH"] = runtimeDirectory + ":" + existing
        } else {
            env["PYTHONPATH"] = runtimeDirectory
        }
        env["EVERWATCH_TOKEN"] = token
        env["EVERWATCH_HOME"] = everwatchHome
        env["EVERWATCH_SHELL"] = "1"
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        return BackendLaunch(executable: python,
                             arguments: arguments + extraArguments,
                             environment: env,
                             workingDirectory: runtimeDirectory)
    }
}

/// Exit codes the backend uses to tell the supervisor *why* it exited
/// (§7 WP7's tab-colors installer flow). Must stay in sync with
/// `everwatch.cli.EX_TEMPFAIL` (Python).
enum BackendExitCode {
    /// sysexits.h `EX_TEMPFAIL`: a deliberate self-restart request (e.g.
    /// the tab-colors installer just finished and needs the freshly
    /// installed `iterm2` package on the venv's python at the next
    /// spawn) -- not a crash. `RestartPolicy.decide(exitStatus:at:)`
    /// restarts on this immediately and never counts it toward the crash
    /// window/backoff.
    static let tempFail: Int32 = 75
}

/// Restart schedule for a crashing backend: 1 s, 2 s, 4 s; more than three
/// crashes inside 60 s gives up and shows the error page (§3.1). A backend
/// that exits with `BackendExitCode.tempFail` is a requested restart, not
/// a crash, and always restarts immediately without touching this
/// schedule (`decide(exitStatus:at:)`).
struct RestartPolicy {
    enum Decision: Equatable {
        case restart(after: TimeInterval)
        case giveUp
    }

    let delays: [TimeInterval]
    let window: TimeInterval
    let maxCrashesInWindow: Int
    private(set) var crashTimes: [TimeInterval] = []

    init(delays: [TimeInterval] = [1, 2, 4], window: TimeInterval = 60, maxCrashesInWindow: Int = 3) {
        precondition(!delays.isEmpty)
        self.delays = delays
        self.window = window
        self.maxCrashesInWindow = maxCrashesInWindow
    }

    mutating func recordCrash(at time: TimeInterval) -> Decision {
        crashTimes.append(time)
        crashTimes.removeAll { time - $0 >= window }
        if crashTimes.count > maxCrashesInWindow { return .giveUp }
        let index = min(crashTimes.count - 1, delays.count - 1)
        return .restart(after: delays[index])
    }

    /// The single entry point `BackendSupervisor` should call whenever
    /// the backend process exits: `exitStatus == BackendExitCode.
    /// tempFail` restarts immediately and leaves the crash history
    /// untouched (so a colors-install restart never itself counts toward,
    /// or is delayed by, a real crash streak); anything else -- including
    /// a normal exit(0) from a parent-pipe EOF/SIGTERM -- is recorded as
    /// a crash via `recordCrash`, unchanged from before this existed.
    mutating func decide(exitStatus: Int32, at time: TimeInterval) -> Decision {
        if exitStatus == BackendExitCode.tempFail {
            return .restart(after: 0)
        }
        return recordCrash(at: time)
    }

    mutating func reset() { crashTimes.removeAll() }
}

/// Reconnect delay for the native SSE client: the server's `retry` (or 2 s),
/// doubled per consecutive failure, capped at 30 s.
enum SSEReconnect {
    static let defaultRetryMilliseconds = 2000
    static let maxDelay: TimeInterval = 30

    static func delay(consecutiveFailures: Int, serverRetryMilliseconds: Int?) -> TimeInterval {
        let base = Double(max(0, serverRetryMilliseconds ?? defaultRetryMilliseconds)) / 1000
        let exponent = min(max(0, consecutiveFailures), 16)
        return min(maxDelay, base * pow(2, Double(exponent)))
    }
}
