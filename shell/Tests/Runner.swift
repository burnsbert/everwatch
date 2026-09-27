import Foundation
import Testing

/// Entry point for the swiftc-built Swift Testing runner (no SwiftPM, §5.4).
/// EVERWATCH_NO_SOUND is forced on before any test runs; Core has no real
/// player anyway, so this is belt and braces.
@main
struct ShellTestRunner {
    static func main() async {
        setenv("EVERWATCH_NO_SOUND", "1", 1)
        await Testing.__swiftPMEntryPoint() as Never
    }
}
