// Renders the Everwatch app icon headlessly with CoreGraphics (no window
// server, no GUI) into an .iconset directory for `iconutil`.
//
//   swiftc scripts/make_icon.swift -o build/obj/make_icon && build/obj/make_icon <out.iconset>
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha)
}

let space = CGColorSpace(name: CGColorSpace.sRGB)!

/// Converts a "screen angle" (0 = 3 o'clock, increasing clockwise — the
/// convention used by the SVG sources in docs/design, whose canvas is
/// y-down) into the angle used by this file's canvas, which is plain
/// CoreGraphics (y-up, unflipped): phi = -theta.
func cgAngle(_ screenDegrees: CGFloat) -> CGFloat { -screenDegrees * .pi / 180 }

/// Draws the icon on a 1024-unit canvas scaled to `pixels`. Concept C2
/// "Watch ring" (docs/design/VISUAL_SPEC.md §11): a 3/4 arc (the in-app
/// *busy* spinner) around an amber core (the in-app *waiting* dot) on a
/// graphite tile. Ported from docs/design/logo-app-icon.svg (pixels > 32)
/// and docs/design/logo-app-icon-small.svg (pixels <= 32: thicker arc,
/// bigger core, no track/glow/shadow so it survives downsampling).
func render(pixels: Int) -> CGImage {
    let ctx = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
                        space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let s = CGFloat(pixels) / 1024
    ctx.scaleBy(x: s, y: s)
    ctx.setAllowsAntialiasing(true)
    ctx.interpolationQuality = .high

    let small = pixels <= 32
    let center = CGPoint(x: 512, y: 512)

    // 1. Tile: rounded square on the macOS icon grid (824 pt body, 100 pt margin).
    let body = CGRect(x: 100, y: 100, width: 824, height: 824)
    let bodyPath = CGPath(roundedRect: body, cornerWidth: 185, cornerHeight: 185, transform: nil)

    if !small {
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -14), blur: 16, color: rgb(0x000000, 0.32))
        ctx.addPath(bodyPath)
        ctx.setFillColor(rgb(0x131417))
        ctx.fillPath()
        ctx.restoreGState()
    }

    ctx.saveGState()
    ctx.addPath(bodyPath)
    ctx.clip()
    let tile = CGGradient(colorsSpace: space, colors: [rgb(0x383a42), rgb(0x131417)] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(tile, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])
    ctx.restoreGState()

    if !small {
        // Edge highlight: 3pt inset stroke, white 22% -> 4% -> 0, top to bottom.
        ctx.saveGState()
        let inset = body.insetBy(dx: 1.5, dy: 1.5)
        let edgePath = CGPath(roundedRect: inset, cornerWidth: 183.5, cornerHeight: 183.5, transform: nil)
        ctx.addPath(edgePath)
        ctx.setLineWidth(3)
        ctx.replacePathWithStrokedPath()
        ctx.clip()
        let edge = CGGradient(colorsSpace: space,
                              colors: [rgb(0xffffff, 0.22), rgb(0xffffff, 0.04), rgb(0xffffff, 0)] as CFArray,
                              locations: [0, 0.5, 1])!
        ctx.drawLinearGradient(edge, start: CGPoint(x: 512, y: 921), end: CGPoint(x: 512, y: 103), options: [])
        ctx.restoreGState()
    }

    // 2/3. Watch ring: a partial arc, open in the upper-left, echoing the
    // in-app busy spinner. Screen angle -20 (20 degrees above 3 o'clock),
    // sweeping clockwise on screen.
    let ringRadius: CGFloat = small ? 240 : 248
    let ringWidth: CGFloat = small ? 112 : 76
    let sweepDeg: CGFloat = small ? (1050 / (2 * .pi * 240)) * 360 : (1100 / (2 * .pi * 248)) * 360
    let phiStart = cgAngle(-20)
    let phiEnd = phiStart - sweepDeg * .pi / 180
    let arcPath = CGMutablePath()
    arcPath.addArc(center: center, radius: ringRadius, startAngle: phiStart, endAngle: phiEnd, clockwise: true)

    if !small {
        // Track underneath the arc.
        ctx.saveGState()
        ctx.addArc(center: center, radius: ringRadius, startAngle: 0, endAngle: 2 * .pi, clockwise: false)
        ctx.setStrokeColor(rgb(0xffffff, 0.10))
        ctx.setLineWidth(ringWidth)
        ctx.strokePath()
        ctx.restoreGState()

        // Solid pass so the arc casts a soft drop shadow (gradients don't).
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 12, color: rgb(0x000000, 0.45))
        ctx.addPath(arcPath)
        ctx.setLineWidth(ringWidth)
        ctx.setLineCap(.round)
        ctx.replacePathWithStrokedPath()
        ctx.setFillColor(rgb(0xffffff))
        ctx.fillPath()
        ctx.restoreGState()

        // Gradient pass: replacePathWithStrokedPath() + clip + drawLinearGradient.
        ctx.saveGState()
        ctx.addPath(arcPath)
        ctx.setLineWidth(ringWidth)
        ctx.setLineCap(.round)
        ctx.replacePathWithStrokedPath()
        ctx.clip()
        let arcGrad = CGGradient(colorsSpace: space, colors: [rgb(0xffffff), rgb(0xc4c8d2)] as CFArray, locations: [0, 1])!
        ctx.drawLinearGradient(arcGrad, start: CGPoint(x: 264, y: 760), end: CGPoint(x: 760, y: 264), options: [])
        ctx.restoreGState()

        // Amber glow behind the core.
        ctx.saveGState()
        let glow = CGGradient(colorsSpace: space, colors: [rgb(0xffaf00, 0.45), rgb(0xffaf00, 0)] as CFArray, locations: [0, 1])!
        ctx.drawRadialGradient(glow, startCenter: center, startRadius: 0, endCenter: center, endRadius: 200, options: [])
        ctx.restoreGState()
    } else {
        ctx.saveGState()
        ctx.addPath(arcPath)
        ctx.setStrokeColor(rgb(0xf4f5f8))
        ctx.setLineWidth(ringWidth)
        ctx.setLineCap(.round)
        ctx.strokePath()
        ctx.restoreGState()
    }

    // 4. Amber core (the in-app *waiting* dot).
    let coreRadius: CGFloat = small ? 128 : 118
    let coreRect = CGRect(x: center.x - coreRadius, y: center.y - coreRadius, width: coreRadius * 2, height: coreRadius * 2)
    if small {
        ctx.setFillColor(rgb(0xffaf00))
        ctx.fillEllipse(in: coreRect)
    } else {
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 12, color: rgb(0x000000, 0.45))
        ctx.setFillColor(rgb(0xffaf00))
        ctx.fillEllipse(in: coreRect)
        ctx.restoreGState()

        ctx.saveGState()
        ctx.addEllipse(in: coreRect)
        ctx.clip()
        let hotspot = CGPoint(x: center.x - 27, y: center.y + 38)
        let amber = CGGradient(colorsSpace: space, colors: [rgb(0xffd978), rgb(0xffaf00), rgb(0xea8a00)] as CFArray,
                               locations: [0, 0.55, 1])!
        ctx.drawRadialGradient(amber, startCenter: hotspot, startRadius: 0, endCenter: center, endRadius: coreRadius, options: [])
        ctx.restoreGState()
    }

    return ctx.makeImage()!
}

func writePNG(_ image: CGImage, to url: URL) {
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        fatalError("cannot create \(url.path)")
    }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { fatalError("cannot write \(url.path)") }
}

let args = CommandLine.arguments
guard args.count == 2 else {
    FileHandle.standardError.write(Data("usage: make_icon <out.iconset>\n".utf8))
    exit(2)
}
let out = URL(fileURLWithPath: args[1], isDirectory: true)
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
    writePNG(render(pixels: base), to: out.appendingPathComponent("icon_\(base)x\(base).png"))
    writePNG(render(pixels: base * 2), to: out.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
print("wrote \(out.path)")
