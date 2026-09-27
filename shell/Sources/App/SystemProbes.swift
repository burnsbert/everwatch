import Foundation

/// Runs a short-lived helper process and returns its stdout, or nil on
/// failure/timeout. Used only for `python3 -c …` and `xcode-select -p`.
enum ProcessRunner {
    static func output(of executable: String, _ arguments: [String], timeout: TimeInterval) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"]
        let stdout = Pipe()
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice

        let done = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in done.signal() }
        do { try process.run() } catch { return nil }

        var data = Data()
        let reader = DispatchQueue.global(qos: .userInitiated)
        let readDone = DispatchSemaphore(value: 0)
        reader.async {
            data = stdout.fileHandleForReading.readDataToEndOfFile()
            readDone.signal()
        }
        if done.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            _ = done.wait(timeout: .now() + 1)
            return nil
        }
        _ = readDone.wait(timeout: .now() + 1)
        guard process.terminationStatus == 0 else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

/// Real implementation of PythonProbing.
struct SystemPythonProbe: PythonProbing {
    func isExecutableFile(atPath path: String) -> Bool {
        FileManager.default.isExecutableFile(atPath: path)
    }

    func version(ofPythonAt path: String) -> PythonVersion? {
        let script = "import sys; print('%d.%d.%d' % tuple(sys.version_info[:3]))"
        guard let out = ProcessRunner.output(of: path, ["-I", "-c", script], timeout: 15) else { return nil }
        return PythonVersion(string: out)
    }

    func developerDirectory() -> String? {
        let tool = "/usr/bin/xcode-select"
        guard FileManager.default.isExecutableFile(atPath: tool),
              let out = ProcessRunner.output(of: tool, ["-p"], timeout: 5)
        else { return nil }
        let path = out.trimmingCharacters(in: .whitespacesAndNewlines)
        return path.isEmpty ? nil : path
    }
}
