import AppKit
import Testing

@Suite("StatusGlyph (W-2 menu bar template image)")
struct StatusGlyphTests {
    @Test("default size is 18x18pt, marked as a template image")
    func sizeAndTemplate() {
        let image = StatusGlyph.templateImage()
        #expect(image.size == NSSize(width: 18, height: 18))
        #expect(image.isTemplate)
        #expect(image.accessibilityDescription == "Everwatch")
    }

    @Test("honors a custom point size")
    func customSize() {
        let image = StatusGlyph.templateImage(pointSize: 36)
        #expect(image.size == NSSize(width: 36, height: 36))
    }

    @Test("renders a non-empty bitmap: some pixels are opaque black, most of the canvas is transparent")
    func nonEmptyBitmap() throws {
        let image = StatusGlyph.templateImage(pointSize: 18)
        guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else {
            Issue.record("could not rasterize StatusGlyph.templateImage()")
            return
        }
        var opaquePixels = 0
        for y in 0..<rep.pixelsHigh {
            for x in 0..<rep.pixelsWide {
                guard let color = rep.colorAt(x: x, y: y) else { continue }
                if color.alphaComponent > 0.5 {
                    opaquePixels += 1
                    // Template images are black-on-transparent.
                    #expect(color.redComponent < 0.1)
                    #expect(color.greenComponent < 0.1)
                    #expect(color.blueComponent < 0.1)
                }
            }
        }
        let total = rep.pixelsWide * rep.pixelsHigh
        #expect(opaquePixels > 0, "expected some drawn (opaque) pixels")
        #expect(opaquePixels < total, "expected the glyph to leave most of the canvas transparent (open gap, thin arc)")
    }
}
