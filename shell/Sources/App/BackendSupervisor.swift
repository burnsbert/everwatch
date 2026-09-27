import Foundation

/// Spawns and babysits `python3 -m everwatch serve --port 0 --parent-pipe`
/// (§3.1). The backend's stdin is a pipe we never write to; when this
/// process exits the pipe closes and the backend exits too (no orphans).
/// All state is confined to the main thread.
@MainActor
final class BackendSupervisor {
    enum Event {
        case starting
        case ready(port: Int)
        case failed(ErrorPage.Kind)
    }

    var onEvent: ((Event) -> Void)?
    /// Observers used only by the headless self-test (nil in normal use):
    /// a backend process was spawned (pid), and one exited with the raw
    /// status and what `RestartPolicy` decided.
    var onSpawn: ((Int32) -> Void)?
    var onExit: ((Int32, RestartPolicy.Decision) -> Void)?

    private let token: String
    private let environment: [String: String]
    private let everwatchHome: String
    private let runtimeDirectory: String
    private let handshakeTimeout: TimeInterval = 20
    private let extraArguments: [String]

    private var process: Process?
    private var stdinPipe: Pipe?
    private var generation = 0
    private var reader = HandshakeReader()
    private var stderrTail = TailBuffer(capacity: 8 * 1024)
    private var policy = RestartPolicy()
    private var stopping = false
    private var pendingRestart: DispatchWorkItem?
    private var handshakeTimer: DispatchWorkItem?
    private(set) var port: Int?

    /// The running backend's pid, if any.
    var pid: Int32? { process?.processIdentifier }
    /// Crashes currently inside the restart policy's window.
    var crashCount: Int { policy.crashTimes.count }

    /// `extraArguments` go after `BackendLaunch.arguments`; only the
    /// self-test passes any (`SelfTestConfig.backendArguments`).
    init(token: String, environment: [String: String] = ProcessInfo.processInfo.environment,
         extraArguments: [String] = []) {
        self.token = token
        self.environment = environment
        self.extraArguments = extraArguments
        self.everwatchHome = ShellPaths.everwatchHome(environment: environment, userHome: NSHomeDirectory())
        self.runtimeDirectory = ShellPaths.runtimeDirectory(environment: environment, everwatchHome: everwatchHome)
    }

    func start() {
        stopping = false
        pendingRestart?.cancel()
        pendingRestart = nil
        onEvent?(.starting)
        let env = environment
        let home = everwatchHome
        let runtime = runtimeDirectory
        DispatchQueue.global(qos: .userInitiated).async {
            let location = PythonLocator(environment: env, everwatchHome: home, probe: SystemPythonProbe()).locate()
            let runtimeOK = ShellPaths.runtimeLooksValid(runtime) { FileManager.default.fileExists(atPath: $0) }
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self.launch(location: location, runtimeOK: runtimeOK) }
            }
        }
    }

    /// Manual "Try again" from the error page or menu.
    func retry() {
        policy.reset()
        terminateCurrent()
        start()
    }

    func stop() {
        stopping = true
        pendingRestart?.cancel()
        terminateCurrent()
    }

    private func launch(location: PythonLocation, runtimeOK: Bool) {
        guard !stopping else { return }
        let python: String
        switch location {
        case .notFound(let rejections):
            onEvent?(.failed(.pythonMissing(tried: PythonLocator.describe(rejections))))
            return
        case .found(let candidate, _):
            python = candidate.path
        }
        guard runtimeOK else {
            onEvent?(.failed(.runtimeMissing(path: runtimeDirectory)))
            return
        }

        let spec = BackendLaunch.make(python: python, runtimeDirectory: runtimeDirectory,
                                      everwatchHome: everwatchHome, token: token, baseEnvironment: environment,
                                      extraArguments: extraArguments)
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: spec.executable)
        proc.arguments = spec.arguments
        proc.environment = spec.environment
        proc.currentDirectoryURL = URL(fileURLWithPath: spec.workingDirectory)
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        proc.standardInput = stdin
        proc.standardOutput = stdout
        proc.standardError = stderr

        generation += 1
        let gen = generation
        reader = HandshakeReader()
        stderrTail.clear()
        port = nil

        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.didReadStdout(data, generation: gen) }
            }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.didReadStderr(data, generation: gen) }
            }
        }
        proc.terminationHandler = { [weak self] p in
            let status = p.terminationStatus
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.didTerminate(status: status, generation: gen) }
            }
        }

        do {
            try proc.run()
        } catch {
            stderrTail.append(Data("Could not start \(python): \(error.localizedDescription)".utf8))
            process = nil
            handleExit(status: 0, generation: gen)
            return
        }
        process = proc
        stdinPipe = stdin   // held open for the backend's lifetime
        onSpawn?(proc.processIdentifier)

        let timer = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.handshakeTimedOut(generation: gen) }
        }
        handshakeTimer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + handshakeTimeout, execute: timer)
    }

    private func didReadStdout(_ data: Data, generation gen: Int) {
        guard gen == generation, port == nil else { return }
        if let found = reader.feed(data) {
            handshakeTimer?.cancel()
            port = found
            onEvent?(.ready(port: found))
        }
    }

    private func didReadStderr(_ data: Data, generation gen: Int) {
        guard gen == generation else { return }
        stderrTail.append(data)
    }

    private func handshakeTimedOut(generation gen: Int) {
        guard gen == generation, port == nil, !stopping else { return }
        stderrTail.append(Data("\n[Everwatch] no EVERWATCH_READY line within \(Int(handshakeTimeout)) s\n".utf8))
        // Terminating triggers didTerminate, which counts the crash.
        process?.terminate()
    }

    private func didTerminate(status: Int32, generation gen: Int) {
        guard gen == generation else { return }
        process = nil
        stdinPipe = nil
        port = nil
        handshakeTimer?.cancel()
        guard !stopping else { return }
        handleExit(status: status, generation: gen)
    }

    /// `status` is the raw exit status `Process.terminationHandler`
    /// reported; `RestartPolicy.decide` treats `BackendExitCode.tempFail`
    /// (a requested restart -- e.g. the tab-colors installer finishing)
    /// as never counting toward the crash window/backoff, and restarts
    /// on it immediately. `launch()`'s own `proc.run()` failure path has
    /// no real exit status, so it passes 0 -- still a crash.
    private func handleExit(status: Int32, generation gen: Int) {
        let decision = policy.decide(exitStatus: status, at: ProcessInfo.processInfo.systemUptime)
        onExit?(status, decision)
        switch decision {
        case .giveUp:
            var detail = stderrTail.text
            if detail.isEmpty { detail = reader.otherLines.joined(separator: "\n") }
            onEvent?(.failed(.backendFailed(detail: detail.trimmingCharacters(in: .whitespacesAndNewlines))))
        case .restart(let delay):
            onEvent?(.starting)
            let work = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, gen == self.generation, !self.stopping else { return }
                    self.start()
                }
            }
            pendingRestart = work
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
        }
    }

    private func terminateCurrent() {
        generation += 1   // ignore callbacks from the old process
        handshakeTimer?.cancel()
        port = nil
        guard let proc = process else { return }
        process = nil
        // Closing stdin is the polite signal (--parent-pipe); SIGTERM backs it up.
        try? stdinPipe?.fileHandleForWriting.close()
        stdinPipe = nil
        let pid = proc.processIdentifier
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
            if proc.isRunning { kill(pid, SIGTERM) }
        }
    }
}
