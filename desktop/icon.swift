import AppKit
import Foundation

let folder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let image = NSImage(size: NSSize(width: pixels, height: pixels))
        image.lockFocus()
        let rect = NSRect(x: Double(pixels) * 0.06, y: Double(pixels) * 0.06, width: Double(pixels) * 0.88, height: Double(pixels) * 0.88)
        NSColor(calibratedRed: 0.33, green: 0.43, blue: 0.32, alpha: 1).setFill()
        NSBezierPath(roundedRect: rect, xRadius: Double(pixels) * 0.2, yRadius: Double(pixels) * 0.2).fill()
        let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: Double(pixels) * 0.61, weight: .medium), .foregroundColor: NSColor.white]
        let letter = NSAttributedString(string: "N", attributes: attributes)
        letter.draw(at: NSPoint(x: (Double(pixels) - letter.size().width) / 2, y: (Double(pixels) - letter.size().height) / 2))
        image.unlockFocus()
        let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
        let name = "icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"
        try bitmap.representation(using: .png, properties: [:])!.write(to: folder.appendingPathComponent(name))
    }
}
