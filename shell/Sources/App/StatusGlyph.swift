import AppKit

/// The menu bar template glyph (W-2), drawn in code from
/// docs/design/logo-menubar-template.svg: a partial "watch ring" arc (the
/// in-app *busy* spinner) around a filled dot (the in-app *waiting* dot),
/// both plain black so AppKit can tint them per menu-bar appearance.
///
/// Drawn in code (not loaded from the SVG file) so there is no resource
/// bundle, and because it's unconfirmed whether NSImage loads SVG natively
/// on the macOS 13 baseline (VISUAL_SPEC.md §11.4.3).
enum StatusGlyph {
    /// pointSize x pointSize template image. isTemplate is already set;
    /// callers only need accessibilityDescription if they want to override
    /// the default ("Everwatch").
    static func templateImage(pointSize: CGFloat = 18) -> NSImage {
        let image = NSImage(size: NSSize(width: pointSize, height: pointSize), flipped: true) { rect in
            let scale = rect.width / 18
            let center = NSPoint(x: rect.midX, y: rect.midY)
            let radius: CGFloat = 6.3 * scale
            let circumference = 2 * .pi * radius
            let dashOn: CGFloat = 27.7 * scale
            let sweepDegrees = (dashOn / circumference) * 360
            // Screen angle -20 (20 degrees above 3 o'clock), sweeping
            // clockwise; `rect` is flipped (y-down), so increasing angle
            // here (measured the usual way, 0 = 3 o'clock) already reads
            // as clockwise on screen.
            let startDegrees: CGFloat = -20

            let path = NSBezierPath()
            let steps = 48
            for i in 0...steps {
                let degrees = startDegrees + sweepDegrees * CGFloat(i) / CGFloat(steps)
                let radians = degrees * .pi / 180
                let point = NSPoint(x: center.x + radius * cos(radians), y: center.y + radius * sin(radians))
                if i == 0 { path.move(to: point) } else { path.line(to: point) }
            }
            path.lineWidth = 2 * scale
            path.lineCapStyle = .round
            NSColor.black.setStroke()
            path.stroke()

            let dotRadius: CGFloat = 2.6 * scale
            let dotRect = NSRect(x: center.x - dotRadius, y: center.y - dotRadius, width: dotRadius * 2, height: dotRadius * 2)
            NSColor.black.setFill()
            NSBezierPath(ovalIn: dotRect).fill()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Everwatch"
        return image
    }
}
