import Foundation
import Testing

/// Reads shell/Info.plist from the source tree (located via #filePath).
@Suite("Info.plist")
struct InfoPlistTests {
    static func plist() throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()      // Tests
            .deletingLastPathComponent()      // shell
            .appendingPathComponent("Info.plist")
        let data = try Data(contentsOf: url)
        let object = try PropertyListSerialization.propertyList(from: data, format: nil)
        return try #require(object as? [String: Any])
    }

    // # parity: P-77
    @Test("P-77 bundle id and version match ShellInfo")
    func identity() throws {
        let p = try Self.plist()
        #expect(p["CFBundleIdentifier"] as? String == ShellInfo.bundleIdentifier)
        #expect(p["CFBundleIdentifier"] as? String == "io.github.burnsbert.everwatch")
        #expect(p["CFBundleShortVersionString"] as? String == ShellInfo.version)
        #expect(p["CFBundleExecutable"] as? String == "Everwatch")
        #expect(p["CFBundlePackageType"] as? String == "APPL")
        #expect(p["CFBundleIconFile"] as? String == "AppIcon")
    }

    @Test("TCC, ATS, minimum OS and Dock presence")
    func policyKeys() throws {
        let p = try Self.plist()
        let usage = try #require(p["NSAppleEventsUsageDescription"] as? String)
        #expect(usage.contains("iTerm2"))
        #expect(usage.count > 40)
        let ats = try #require(p["NSAppTransportSecurity"] as? [String: Any])
        #expect(ats["NSAllowsLocalNetworking"] as? Bool == true)
        #expect(ats["NSAllowsArbitraryLoads"] == nil)
        #expect(p["LSMinimumSystemVersion"] as? String == "13.0")
        // Regular Dock app: the Dock badge and bounce need a Dock tile.
        #expect(p["LSUIElement"] as? Bool == false)
    }
}
