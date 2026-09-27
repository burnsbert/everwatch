import Foundation

struct PythonVersion: Comparable, Equatable, CustomStringConvertible {
    let major: Int
    let minor: Int
    let patch: Int

    init(_ major: Int, _ minor: Int, _ patch: Int = 0) {
        self.major = major
        self.minor = minor
        self.patch = patch
    }

    /// Accepts "3.9.6", "3.13", or "Python 3.9.6" (surrounding whitespace ok).
    init?(string: String) {
        var text = string.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("Python ") { text = String(text.dropFirst("Python ".count)) }
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard (2...3).contains(parts.count) else { return nil }
        var numbers: [Int] = []
        for part in parts {
            // Allow a trailing qualifier on the last field, e.g. "0rc1" or "6+".
            let digits = part.prefix(while: { $0.isASCII && $0.isNumber })
            guard !digits.isEmpty, let value = Int(digits) else { return nil }
            numbers.append(value)
        }
        self.init(numbers[0], numbers[1], numbers.count == 3 ? numbers[2] : 0)
    }

    var description: String { "\(major).\(minor).\(patch)" }

    static func < (lhs: PythonVersion, rhs: PythonVersion) -> Bool {
        (lhs.major, lhs.minor, lhs.patch) < (rhs.major, rhs.minor, rhs.patch)
    }
}

/// Everything PythonLocator needs from the outside world, injected so tests
/// never touch the real filesystem or run an interpreter.
protocol PythonProbing {
    func isExecutableFile(atPath path: String) -> Bool
    /// Runs the interpreter to read its version. Never called for a path
    /// that failed `isExecutableFile`, and never for `/usr/bin/python3`
    /// unless a developer directory (CLT or Xcode) with python3 exists.
    func version(ofPythonAt path: String) -> PythonVersion?
    /// Output of `xcode-select -p`, or nil when no developer tools are installed.
    func developerDirectory() -> String?
}

enum PythonSource: String, Equatable {
    case override      // EVERWATCH_PYTHON
    case venv          // <EVERWATCH_HOME>/venv (tab colors)
    case homebrew
    case pythonOrg
    case commandLineTools
}

struct PythonCandidate: Equatable {
    let path: String
    let source: PythonSource
}

enum PythonRejectionReason: Equatable {
    case missing
    case versionUnknown
    case tooOld(PythonVersion)
    /// /usr/bin/python3 is a stub that opens the "install developer tools"
    /// dialog when there is no CLT; we never run it in that case.
    case developerToolsMissing
}

struct PythonRejection: Equatable {
    let candidate: PythonCandidate
    let reason: PythonRejectionReason
}

enum PythonLocation: Equatable {
    case found(PythonCandidate, PythonVersion)
    case notFound([PythonRejection])
}

struct PythonLocator {
    static let minimumVersion = PythonVersion(3, 9, 0)
    static let systemPython = "/usr/bin/python3"
    static let fixedCandidates: [PythonCandidate] = [
        PythonCandidate(path: "/opt/homebrew/bin/python3", source: .homebrew),
        PythonCandidate(path: "/usr/local/bin/python3", source: .homebrew),
        PythonCandidate(path: "/Library/Frameworks/Python.framework/Versions/Current/bin/python3", source: .pythonOrg),
        PythonCandidate(path: systemPython, source: .commandLineTools),
    ]

    let environment: [String: String]
    let everwatchHome: String
    let probe: PythonProbing

    /// Search order: EVERWATCH_PYTHON, the private venv, Homebrew (arm64 then
    /// Intel), python.org, then /usr/bin/python3 (only with developer tools).
    func candidates() -> [PythonCandidate] {
        var list: [PythonCandidate] = []
        if let override = environment["EVERWATCH_PYTHON"], !override.isEmpty {
            list.append(PythonCandidate(path: override, source: .override))
        }
        list.append(PythonCandidate(path: everwatchHome + "/venv/bin/python3", source: .venv))
        list.append(contentsOf: Self.fixedCandidates)
        var seen = Set<String>()
        return list.filter { seen.insert($0.path).inserted }
    }

    func locate() -> PythonLocation {
        var rejections: [PythonRejection] = []
        for candidate in candidates() {
            if candidate.path == Self.systemPython {
                guard let devDir = probe.developerDirectory(), !devDir.isEmpty,
                      probe.isExecutableFile(atPath: devDir + "/usr/bin/python3")
                else {
                    rejections.append(PythonRejection(candidate: candidate, reason: .developerToolsMissing))
                    continue
                }
            }
            guard probe.isExecutableFile(atPath: candidate.path) else {
                rejections.append(PythonRejection(candidate: candidate, reason: .missing))
                continue
            }
            guard let version = probe.version(ofPythonAt: candidate.path) else {
                rejections.append(PythonRejection(candidate: candidate, reason: .versionUnknown))
                continue
            }
            guard version >= Self.minimumVersion else {
                rejections.append(PythonRejection(candidate: candidate, reason: .tooOld(version)))
                continue
            }
            return .found(candidate, version)
        }
        return .notFound(rejections)
    }

    /// Human-readable lines for the error page.
    static func describe(_ rejections: [PythonRejection]) -> [String] {
        rejections.map { rejection in
            let path = rejection.candidate.path
            switch rejection.reason {
            case .missing: return "\(path): not found"
            case .versionUnknown: return "\(path): could not read its version"
            case .tooOld(let v): return "\(path): Python \(v) is older than \(minimumVersion.major).\(minimumVersion.minor)"
            case .developerToolsMissing: return "\(path): skipped (Command Line Tools not installed)"
            }
        }
    }
}
