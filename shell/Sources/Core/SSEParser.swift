import Foundation

struct SSEEvent: Equatable {
    /// Event type; "message" when the stream gave none.
    let type: String
    let data: String
    /// The stream's last event ID at dispatch time ("" if none yet).
    let lastEventID: String
}

/// Incremental parser for `text/event-stream` following the WHATWG
/// "event stream interpretation" rules: CRLF, LF, or CR line endings (split
/// across chunks is fine), a leading BOM, `:` comments, multi-line `data`,
/// `id` (ignored if it contains NUL), and digits-only `retry`.
struct SSEParser {
    private(set) var lastEventID = ""
    /// Reconnection time in milliseconds from the most recent valid `retry`.
    private(set) var retryMilliseconds: Int?
    /// Number of comment lines seen (servers use them as keep-alives).
    private(set) var commentCount = 0

    private var line: [UInt8] = []
    private var previousWasCR = false
    private var atStreamStart = true
    private var bomBytesMatched = 0
    private var eventType = ""
    private var dataBuffer = ""
    private var hasData = false

    private static let bom: [UInt8] = [0xEF, 0xBB, 0xBF]

    mutating func feed(_ data: Data) -> [SSEEvent] {
        feed(bytes: [UInt8](data))
    }

    mutating func feed(_ text: String) -> [SSEEvent] {
        feed(bytes: Array(text.utf8))
    }

    mutating func feed(bytes: [UInt8]) -> [SSEEvent] {
        var events: [SSEEvent] = []
        for byte in bytes {
            if atStreamStart {
                if byte == Self.bom[bomBytesMatched] {
                    bomBytesMatched += 1
                    if bomBytesMatched == Self.bom.count {
                        atStreamStart = false
                    }
                    continue
                }
                // Not a BOM after all: replay what we swallowed.
                atStreamStart = false
                let swallowed = Array(Self.bom[0..<bomBytesMatched])
                bomBytesMatched = 0
                for b in swallowed { consume(b, into: &events) }
            }
            consume(byte, into: &events)
        }
        return events
    }

    /// End of stream. Per spec an unterminated event is discarded.
    /// Keeps `lastEventID` and `retryMilliseconds` for the reconnect.
    mutating func reset() {
        line.removeAll()
        previousWasCR = false
        atStreamStart = true
        bomBytesMatched = 0
        eventType = ""
        dataBuffer = ""
        hasData = false
    }

    private mutating func consume(_ byte: UInt8, into events: inout [SSEEvent]) {
        switch byte {
        case 0x0D:
            previousWasCR = true
            processLine(into: &events)
        case 0x0A:
            if previousWasCR {
                previousWasCR = false
                return
            }
            processLine(into: &events)
        default:
            previousWasCR = false
            line.append(byte)
        }
    }

    private mutating func processLine(into events: inout [SSEEvent]) {
        let text = String(decoding: line, as: UTF8.self)
        line.removeAll(keepingCapacity: true)

        if text.isEmpty {
            dispatch(into: &events)
            return
        }
        if text.hasPrefix(":") {
            commentCount += 1
            return
        }
        let field: Substring
        var value: Substring
        if let colon = text.firstIndex(of: ":") {
            field = text[..<colon]
            value = text[text.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(text)
            value = ""
        }
        switch field {
        case "event":
            eventType = String(value)
        case "data":
            dataBuffer += value
            dataBuffer += "\n"
            hasData = true
        case "id":
            if !value.contains("\u{0}") { lastEventID = String(value) }
        case "retry":
            if !value.isEmpty, value.allSatisfy({ $0.isASCII && $0.isNumber }), let ms = Int(value) {
                retryMilliseconds = ms
            }
        default:
            break
        }
    }

    private mutating func dispatch(into events: inout [SSEEvent]) {
        defer {
            eventType = ""
            dataBuffer = ""
            hasData = false
        }
        guard hasData else { return }
        var data = dataBuffer
        if data.hasSuffix("\n") { data.removeLast() }
        events.append(SSEEvent(type: eventType.isEmpty ? "message" : eventType,
                               data: data,
                               lastEventID: lastEventID))
    }
}
