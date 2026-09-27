import Foundation
import Testing

@Suite("Handshake")
struct HandshakeTests {
    @Test("parses a well-formed handshake line")
    func parsesValid() {
        #expect(Handshake.parse(line: "EVERWATCH_READY 8123") == 8123)
        #expect(Handshake.parse(line: "EVERWATCH_READY 1") == 1)
        #expect(Handshake.parse(line: "EVERWATCH_READY 65535") == 65535)
    }

    @Test("tolerates CRLF, trailing newline and extra spacing")
    func toleratesWhitespace() {
        #expect(Handshake.parse(line: "EVERWATCH_READY 8123\r") == 8123)
        #expect(Handshake.parse(line: "EVERWATCH_READY 8123\n") == 8123)
        #expect(Handshake.parse(line: "  EVERWATCH_READY\t 8123  ") == 8123)
    }

    @Test("rejects garbage", arguments: [
        "", "EVERWATCH_READY", "EVERWATCH_READY ", "EVERWATCH_READY abc", "EVERWATCH_READY 0",
        "EVERWATCH_READY 65536", "EVERWATCH_READY 123456", "EVERWATCH_READY -1", "EVERWATCH_READY 80 extra",
        "everwatch_ready 8123", "READY 8123", "EVERWATCH_READY 8o80", "EVERWATCH_READY +80", "EVERWATCH_READY ８０",
    ])
    func rejectsGarbage(line: String) {
        #expect(Handshake.parse(line: line) == nil)
    }

    @Test("reader handles a line split across chunks")
    func readerSplitChunks() {
        var reader = HandshakeReader()
        #expect(reader.feed(Data("EVERWATCH_RE".utf8)) == nil)
        #expect(reader.feed(Data("ADY 49".utf8)) == nil)
        #expect(reader.feed(Data("152\n".utf8)) == 49152)
        #expect(reader.port == 49152)
        // Once found, later output doesn't change it.
        #expect(reader.feed(Data("EVERWATCH_READY 1\n".utf8)) == 49152)
    }

    @Test("reader skips noise lines and records them")
    func readerSkipsNoise() {
        var reader = HandshakeReader(maxOtherLines: 2)
        let port = reader.feed(Data("warming up\nstill\nmore\nEVERWATCH_READY 5000\r\n".utf8))
        #expect(port == 5000)
        #expect(reader.otherLines == ["warming up", "still"])
    }

    @Test("reader drops an oversized partial line")
    func readerOverflow() {
        var reader = HandshakeReader(maxBuffer: 8)
        #expect(reader.feed(Data("0123456789".utf8)) == nil)
        #expect(reader.overflowed)
        #expect(reader.feed(Data("\nEVERWATCH_READY 7000\n".utf8)) == 7000)
    }

    @Test("reader copes with invalid UTF-8")
    func readerInvalidUTF8() {
        var reader = HandshakeReader()
        var bytes: [UInt8] = [0xFF, 0xFE, 0x0A]
        bytes += Array("EVERWATCH_READY 6000\n".utf8)
        #expect(reader.feed(Data(bytes)) == 6000)
        #expect(reader.otherLines.count == 1)
    }

    @Test("tail buffer keeps only the last bytes")
    func tailBuffer() {
        var tail = TailBuffer(capacity: 5)
        tail.append(Data("abc".utf8))
        #expect(tail.text == "abc")
        tail.append(Data("defg".utf8))
        #expect(tail.text == "cdefg")
        tail.clear()
        #expect(tail.text == "")
        let tiny = TailBuffer(capacity: 0)
        #expect(tiny.capacity == 1)
    }
}
