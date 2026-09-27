import Foundation
import Testing

@Suite("SSEParser")
struct SSEParserTests {
    @Test("single event with type, id and data")
    func singleEvent() {
        var p = SSEParser()
        let events = p.feed("id: 7\nevent: state\ndata: {\"rev\":7}\n\n")
        #expect(events == [SSEEvent(type: "state", data: "{\"rev\":7}", lastEventID: "7")])
        #expect(p.lastEventID == "7")
    }

    @Test("default type is message")
    func defaultType() {
        var p = SSEParser()
        #expect(p.feed("data: hi\n\n") == [SSEEvent(type: "message", data: "hi", lastEventID: "")])
    }

    @Test("multi-line data joins with newline")
    func multiLineData() {
        var p = SSEParser()
        let events = p.feed("data: line1\ndata: line2\ndata:\ndata:  indented\n\n")
        #expect(events.map(\.data) == ["line1\nline2\n\n indented"])
    }

    @Test("CRLF, lone CR and LF line endings")
    func lineEndings() {
        var p = SSEParser()
        #expect(p.feed("data: a\r\n\r\n").map(\.data) == ["a"])
        #expect(p.feed("data: b\r\r").map(\.data) == ["b"])
        #expect(p.feed("data: c\n\n").map(\.data) == ["c"])
    }

    @Test("CRLF split across chunks isn't a blank line")
    func crlfSplit() {
        var p = SSEParser()
        #expect(p.feed("data: x\r").isEmpty)
        #expect(p.feed("\ndata: y\r").isEmpty)
        #expect(p.feed("\n\r").map(\.data) == ["x\ny"])
        #expect(p.feed("\n").isEmpty)
    }

    @Test("byte-by-byte feeding with multibyte UTF-8")
    func byteByByte() {
        var p = SSEParser()
        let bytes = Array("event: transition\ndata: ◉ api — waiting\n\n".utf8)
        var events: [SSEEvent] = []
        for b in bytes { events += p.feed(bytes: [b]) }
        #expect(events == [SSEEvent(type: "transition", data: "◉ api — waiting", lastEventID: "")])
    }

    @Test("comments count as keep-alives and don't dispatch")
    func comments() {
        var p = SSEParser()
        #expect(p.feed(": ping\n\n:\n\n").isEmpty)
        #expect(p.commentCount == 2)
    }

    @Test("event: ping is a real event")
    func pingEvent() {
        var p = SSEParser()
        #expect(p.feed("event: ping\ndata: {\"now\":1}\n\n") == [SSEEvent(type: "ping", data: "{\"now\":1}", lastEventID: "")])
    }

    @Test("blank line without data resets type and dispatches nothing")
    func noDataNoDispatch() {
        var p = SSEParser()
        #expect(p.feed("event: state\n\n").isEmpty)
        #expect(p.feed("data: z\n\n") == [SSEEvent(type: "message", data: "z", lastEventID: "")])
    }

    @Test("empty data field still dispatches")
    func emptyData() {
        var p = SSEParser()
        #expect(p.feed("data\n\n") == [SSEEvent(type: "message", data: "", lastEventID: "")])
        #expect(p.feed("data:\n\n").map(\.data) == [""])
    }

    @Test("id persists across events and NUL ids are ignored")
    func idHandling() {
        var p = SSEParser()
        _ = p.feed("id: 5\ndata: a\n\n")
        #expect(p.feed("data: b\n\n").first?.lastEventID == "5")
        _ = p.feed("id: bad\u{0}id\ndata: c\n\n")
        #expect(p.lastEventID == "5")
        _ = p.feed("id\ndata: d\n\n")
        #expect(p.lastEventID == "")
    }

    @Test("retry accepts digits only")
    func retry() {
        var p = SSEParser()
        _ = p.feed("retry: 3000\n\n")
        #expect(p.retryMilliseconds == 3000)
        _ = p.feed("retry: 12a\nretry: -5\nretry:\nretry: 99999999999999999999999\n\n")
        #expect(p.retryMilliseconds == 3000)
    }

    @Test("unknown fields ignored; only one leading space stripped; colon in value kept")
    func fieldParsing() {
        var p = SSEParser()
        let events = p.feed("foo: bar\ndata:no-space\ndata:  two: colons\n\n")
        #expect(events.map(\.data) == ["no-space\n two: colons"])
    }

    @Test("leading BOM is stripped once")
    func bom() {
        var p = SSEParser()
        var bytes: [UInt8] = [0xEF, 0xBB, 0xBF]
        bytes += Array("data: a\n\n".utf8)
        #expect(p.feed(bytes: bytes).map(\.data) == ["a"])
    }

    @Test("BOM split across chunks")
    func bomSplit() {
        var p = SSEParser()
        #expect(p.feed(bytes: [0xEF]).isEmpty)
        #expect(p.feed(bytes: [0xBB, 0xBF] + Array("data: q\n\n".utf8)).map(\.data) == ["q"])
    }

    @Test("partial BOM prefix is replayed as content")
    func falseBom() {
        var p = SSEParser()
        let events = p.feed(bytes: [0xEF] + Array("\n".utf8) + Array("data: k\n\n".utf8))
        #expect(events.map(\.data) == ["k"])
    }

    @Test("reset drops a partial event but keeps id and retry")
    func reset() {
        var p = SSEParser()
        _ = p.feed("id: 9\nretry: 500\ndata: done\n\nevent: state\ndata: partial")
        p.reset()
        #expect(p.lastEventID == "9")
        #expect(p.retryMilliseconds == 500)
        #expect(p.feed("data: fresh\n\n") == [SSEEvent(type: "message", data: "fresh", lastEventID: "9")])
    }

    @Test("several events in one chunk")
    func manyEvents() {
        var p = SSEParser()
        let events = p.feed(Data("id: 1\nevent: hello\ndata: {}\n\nid: 2\nevent: state\ndata: {}\n\n: ping\n\nevent: notify\ndata: {}\n\n".utf8))
        #expect(events.map(\.type) == ["hello", "state", "notify"])
        #expect(events.map(\.lastEventID) == ["1", "2", "2"])
    }
}
