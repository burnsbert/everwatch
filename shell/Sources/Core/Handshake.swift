import Foundation

/// Parses the backend's readiness line, `EVERWATCH_READY <port>`, printed on
/// stdout by `python3 -m everwatch serve --port 0 --parent-pipe`.
enum Handshake {
    static let prefix = "EVERWATCH_READY"

    /// Returns the port if `line` is a well-formed handshake, else nil.
    /// Leading/trailing whitespace (including a CR from CRLF) is ignored.
    static func parse(line: String) -> Int? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmed.split(whereSeparator: { $0 == " " || $0 == "\t" })
        guard parts.count == 2, parts[0] == prefix else { return nil }
        let digits = parts[1]
        guard (1...5).contains(digits.count),
              digits.allSatisfy({ $0.isASCII && $0.isNumber }),
              let port = Int(digits),
              (1...65535).contains(port)
        else { return nil }
        return port
    }
}

/// Accumulates stdout bytes (which may arrive split across reads) until a
/// handshake line appears. Lines that aren't the handshake are kept (up to a
/// small cap) for the error page.
struct HandshakeReader {
    private var buffer: [UInt8] = []
    private(set) var port: Int?
    private(set) var otherLines: [String] = []
    private(set) var overflowed = false
    let maxBuffer: Int
    let maxOtherLines: Int

    init(maxBuffer: Int = 64 * 1024, maxOtherLines: Int = 20) {
        self.maxBuffer = maxBuffer
        self.maxOtherLines = maxOtherLines
    }

    /// Feeds bytes; returns the port once the handshake has been seen.
    @discardableResult
    mutating func feed(_ data: Data) -> Int? {
        if let port { return port }
        buffer.append(contentsOf: data)
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = String(decoding: buffer[..<newline], as: UTF8.self)
            buffer.removeSubrange(...newline)
            if let found = Handshake.parse(line: line) {
                port = found
                buffer.removeAll()
                return found
            }
            if otherLines.count < maxOtherLines {
                otherLines.append(line)
            }
        }
        if buffer.count > maxBuffer {
            overflowed = true
            buffer.removeAll()
        }
        return nil
    }
}

/// Keeps the last `capacity` bytes of a stream (the backend's stderr) so a
/// crash can be explained on the error page.
struct TailBuffer {
    let capacity: Int
    private var bytes: [UInt8] = []

    init(capacity: Int = 8 * 1024) {
        self.capacity = max(1, capacity)
    }

    mutating func append(_ data: Data) {
        bytes.append(contentsOf: data)
        if bytes.count > capacity {
            bytes.removeFirst(bytes.count - capacity)
        }
    }

    mutating func clear() { bytes.removeAll() }

    var text: String { String(decoding: bytes, as: UTF8.self) }
}
