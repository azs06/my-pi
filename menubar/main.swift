/**
 * main.swift – macOS menubar manager for my-pi.
 *
 * Build:
 *   swiftc -strict-concurrency=minimal \
 *          -o dist/my-pi-menubar menubar/main.swift -framework AppKit
 *
 * Run:
 *   ./dist/my-pi-menubar [/path/to/project-dir]
 *   (defaults to parent dir of the binary)
 */

import AppKit
import Darwin
import Foundation

// ─── Menubar controller ───────────────────────────────────────────────────────

final class PiMenuBar: NSObject, NSApplicationDelegate {

    // MARK: – State

    private var statusItem: NSStatusItem!
    private var piProcess: Process?
    private var logLines: [String] = []
    private let maxLogLines = 300
    private var rebuildDebounce: Timer?
    private var logFileHandle: FileHandle?

    private let projectDir: String
    private var binaryPath: String { "\(projectDir)/dist/my-pi" }
    private var logFilePath: String {
        let dir = (ProcessInfo.processInfo.environment["HOME"] ?? "/tmp") + "/.my-pi"
        return "\(dir)/menubar.log"
    }

    init(projectDir: String) {
        self.projectDir = projectDir
        super.init()
    }

    // MARK: – App lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupLogFile()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.target = self

        setIcon(running: false)
        rebuildMenu()
        startPi()
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopPi()
        logFileHandle?.closeFile()
    }

    // MARK: – Process management

    private func isRunning() -> Bool {
        piProcess?.isRunning == true
    }

    @objc func startPi() {
        guard !isRunning() else { return }

        guard FileManager.default.fileExists(atPath: binaryPath) else {
            appendLog("[menubar] ⚠️  Binary not found: \(binaryPath)\n         Run 'make build' first.")
            rebuildMenu()
            return
        }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: binaryPath)
        p.currentDirectoryURL = URL(fileURLWithPath: projectDir)
        p.environment = buildEnv()

        // Pipe stdout + stderr together
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError  = pipe

        pipe.fileHandleForReading.readabilityHandler = { [weak self] fh in
            let data = fh.availableData
            guard !data.isEmpty else {
                fh.readabilityHandler = nil
                return
            }
            guard let str = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.appendLog(str) }
        }

        p.terminationHandler = { [weak self, weak pipe] proc in
            pipe?.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async {
                self?.appendLog("[menubar] Process exited (code \(proc.terminationStatus)).")
                self?.piProcess = nil
                self?.setIcon(running: false)
                self?.rebuildMenu()
            }
        }

        do {
            try p.run()
            piProcess = p
            appendLog("[menubar] Started PID \(p.processIdentifier).")
            setIcon(running: true)
        } catch {
            appendLog("[menubar] ❌ Failed to start: \(error.localizedDescription)")
        }
        rebuildMenu()
    }

    @objc func stopPi() {
        guard let p = piProcess, p.isRunning else {
            piProcess = nil
            return
        }

        let pid = p.processIdentifier
        let descendants = descendantPIDs(of: pid)
        appendLog(
            descendants.isEmpty
                ? "[menubar] Sending SIGTERM to PID \(pid)."
                : "[menubar] Sending SIGTERM to PID \(pid) and \(descendants.count) child process(es)."
        )
        signalProcessTree(rootPID: pid, descendants: descendants, signal: SIGTERM)

        let deadline = Date().addingTimeInterval(3.0)
        while p.isRunning && Date() < deadline {
            _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }

        if p.isRunning {
            let remaining = Array(Set(descendants + descendantPIDs(of: pid))).sorted()
            appendLog(
                remaining.isEmpty
                    ? "[menubar] PID \(pid) didn't exit in time – sending SIGKILL."
                    : "[menubar] PID \(pid) and \(remaining.count) child process(es) didn't exit in time – sending SIGKILL."
            )
            signalProcessTree(rootPID: pid, descendants: remaining, signal: SIGKILL)
            p.waitUntilExit()
        }

        piProcess = nil
        setIcon(running: false)
        rebuildMenu()
    }

    private func signalProcessTree(rootPID: Int32, descendants: [Int32], signal: Int32) {
        for childPID in descendants.reversed() {
            sendSignal(signal, to: childPID)
        }
        sendSignal(signal, to: rootPID)
    }

    private func sendSignal(_ signal: Int32, to pid: Int32) {
        if kill(pid, signal) == 0 { return }

        let err = errno
        guard err != ESRCH else { return }
        appendLog(
            "[menubar] Failed to send \(signalName(signal)) to PID \(pid): \(String(cString: strerror(err)))"
        )
    }

    private func signalName(_ signal: Int32) -> String {
        switch signal {
        case SIGTERM:
            return "SIGTERM"
        case SIGKILL:
            return "SIGKILL"
        default:
            return "signal \(signal)"
        }
    }

    private func descendantPIDs(of pid: Int32) -> [Int32] {
        var seen = Set<Int32>()
        var ordered: [Int32] = []
        var stack = childPIDs(of: pid)

        while let current = stack.popLast() {
            guard seen.insert(current).inserted else { continue }
            ordered.append(current)
            stack.append(contentsOf: childPIDs(of: current))
        }

        return ordered
    }

    private func childPIDs(of pid: Int32) -> [Int32] {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        task.arguments = ["-P", String(pid)]

        let stdout = Pipe()
        let stderr = Pipe()
        task.standardOutput = stdout
        task.standardError = stderr

        do {
            try task.run()
            task.waitUntilExit()
        } catch {
            appendLog("[menubar] Failed to inspect child processes for PID \(pid): \(error.localizedDescription)")
            return []
        }

        let outputData = stdout.fileHandleForReading.readDataToEndOfFile()
        let errorData = stderr.fileHandleForReading.readDataToEndOfFile()

        if task.terminationStatus != 0 {
            if task.terminationStatus == 1 { return [] } // no children

            let errorText = String(data: errorData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if let errorText, !errorText.isEmpty {
                appendLog("[menubar] pgrep failed for PID \(pid): \(errorText)")
            } else {
                appendLog("[menubar] pgrep failed for PID \(pid) with exit code \(task.terminationStatus).")
            }
            return []
        }

        guard let output = String(data: outputData, encoding: .utf8) else { return [] }
        return output
            .split(whereSeparator: { $0.isNewline })
            .compactMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }

    @objc func restartPi() {
        stopPi()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            self?.startPi()
        }
    }

    @objc func quitMenubar() {
        stopPi()
        NSApplication.shared.terminate(nil)
    }

    // MARK: – Menu

    func rebuildMenu() {
        let menu = NSMenu()
        menu.autoenablesItems = false

        // ── Status label ──────────────────────────────────────────────────────
        let running = isRunning()
        let statusLabel = NSMenuItem(
            title: running ? "● Running" : "○ Stopped",
            action: nil, keyEquivalent: ""
        )
        statusLabel.isEnabled = false
        statusLabel.attributedTitle = makeStatusTitle(running: running)
        menu.addItem(statusLabel)

        // ── Working dir ───────────────────────────────────────────────────────
        let dirItem = NSMenuItem(
            title: "  \(projectDir)",
            action: nil, keyEquivalent: ""
        )
        dirItem.isEnabled = false
        dirItem.attributedTitle = makeSmallGrayTitle("  \(contractPath(projectDir))")
        menu.addItem(dirItem)

        menu.addItem(.separator())

        // ── Actions ───────────────────────────────────────────────────────────
        if running {
            let stop = NSMenuItem(title: "Stop",    action: #selector(stopPi),    keyEquivalent: "")
            let restart = NSMenuItem(title: "Restart", action: #selector(restartPi), keyEquivalent: "r")
            stop.target = self
            restart.target = self
            menu.addItem(stop)
            menu.addItem(restart)
        } else {
            let start = NSMenuItem(title: "Start", action: #selector(startPi), keyEquivalent: "s")
            start.target = self
            menu.addItem(start)
        }

        menu.addItem(.separator())

        // ── Recent logs submenu ────────────────────────────────────────────────
        let logsParent = NSMenuItem(title: "Recent Logs", action: nil, keyEquivalent: "")
        let logsSubmenu = NSMenu(title: "Recent Logs")
        let recentLines = logLines.suffix(25)
        if recentLines.isEmpty {
            let empty = NSMenuItem(title: "(no output yet)", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            logsSubmenu.addItem(empty)
        } else {
            for line in recentLines {
                let trimmed = String(line.prefix(100))
                let item = NSMenuItem(title: trimmed, action: nil, keyEquivalent: "")
                item.isEnabled = false
                item.attributedTitle = makeMonoTitle(trimmed)
                logsSubmenu.addItem(item)
            }
        }
        logsParent.submenu = logsSubmenu
        menu.addItem(logsParent)

        // ── Open log file ─────────────────────────────────────────────────────
        let openLog = NSMenuItem(title: "Open Full Log", action: #selector(openLogFile), keyEquivalent: "l")
        openLog.target = self
        menu.addItem(openLog)

        menu.addItem(.separator())

        // ── Quit ──────────────────────────────────────────────────────────────
        let quit = NSMenuItem(title: "Quit MyPi", action: #selector(quitMenubar), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        statusItem.menu = menu
    }

    @objc func openLogFile() {
        let url = URL(fileURLWithPath: logFilePath)
        NSWorkspace.shared.open(url)
    }

    // MARK: – Icon

    private func setIcon(running: Bool) {
        guard let button = statusItem.button else { return }
        if let sym = NSImage(
            systemSymbolName: running
                ? "dot.radiowaves.left.and.right"
                : "dot.radiowaves.left.and.right",
            accessibilityDescription: running ? "Pi running" : "Pi stopped"
        ) {
            // Use palette rendering to tint the icon
            if running {
                let config = NSImage.SymbolConfiguration(paletteColors: [.systemGreen])
                button.image = sym.withSymbolConfiguration(config)
            } else {
                let config = NSImage.SymbolConfiguration(paletteColors: [.tertiaryLabelColor])
                button.image = sym.withSymbolConfiguration(config)
            }
            button.image?.isTemplate = false
            button.title = ""
        } else {
            // Fallback text
            button.image = nil
            button.title = running ? "π●" : "π○"
        }
    }

    // MARK: – Logging

    private func appendLog(_ text: String) {
        // Write to log file
        if let data = text.data(using: .utf8) {
            logFileHandle?.write(data)
            if !text.hasSuffix("\n"), let nl = "\n".data(using: .utf8) {
                logFileHandle?.write(nl)
            }
        }

        // Keep in-memory ring buffer
        let lines = text.components(separatedBy: .newlines).filter { !$0.isEmpty }
        logLines.append(contentsOf: lines)
        if logLines.count > maxLogLines {
            logLines.removeFirst(logLines.count - maxLogLines)
        }

        // Debounce menu rebuild (don't hammer during rapid log output)
        rebuildDebounce?.invalidate()
        rebuildDebounce = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: false) { [weak self] _ in
            self?.rebuildMenu()
        }
    }

    private func setupLogFile() {
        let dir = (ProcessInfo.processInfo.environment["HOME"] ?? "/tmp") + "/.my-pi"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: logFilePath, contents: nil)
        logFileHandle = FileHandle(forWritingAtPath: logFilePath)
        logFileHandle?.seekToEndOfFile()
        appendLog("[menubar] Log opened. Project: \(projectDir)")
    }

    // MARK: – Environment

    private func buildEnv() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let envPath = "\(projectDir)/.env"
        guard let raw = try? String(contentsOfFile: envPath, encoding: .utf8) else { return env }
        for rawLine in raw.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty, !line.hasPrefix("#") else { continue }
            let parts = line.split(separator: "=", maxSplits: 1)
            guard parts.count == 2 else { continue }
            let key   = String(parts[0]).trimmingCharacters(in: .whitespaces)
            var value = String(parts[1]).trimmingCharacters(in: .whitespaces)
            if (value.hasPrefix("\"") && value.hasSuffix("\"")) ||
               (value.hasPrefix("'")  && value.hasSuffix("'")) {
                value = String(value.dropFirst().dropLast())
            }
            env[key] = value
        }
        return env
    }

    // MARK: – Attributed string helpers

    private func makeStatusTitle(running: Bool) -> NSAttributedString {
        let color: NSColor = running ? .systemGreen : .secondaryLabelColor
        return NSAttributedString(string: running ? "● Running" : "○ Stopped", attributes: [
            .foregroundColor: color,
            .font: NSFont.menuFont(ofSize: 13),
        ])
    }

    private func makeSmallGrayTitle(_ s: String) -> NSAttributedString {
        NSAttributedString(string: s, attributes: [
            .foregroundColor: NSColor.tertiaryLabelColor,
            .font: NSFont.menuFont(ofSize: 11),
        ])
    }

    private func makeMonoTitle(_ s: String) -> NSAttributedString {
        NSAttributedString(string: s, attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
            .foregroundColor: NSColor.labelColor,
        ])
    }

    private func contractPath(_ path: String) -> String {
        let home = ProcessInfo.processInfo.environment["HOME"] ?? ""
        return home.isEmpty ? path : path.replacingOccurrences(of: home, with: "~")
    }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

let args = CommandLine.arguments

// Resolve project directory:
//   1. Explicit first argument
//   2. Two levels up from binary (dist/my-pi-menubar → dist/ → project/)
let projectDir: String
if args.count > 1 {
    projectDir = (args[1] as NSString).expandingTildeInPath
} else {
    let binDir = URL(fileURLWithPath: args[0]).deletingLastPathComponent()
    projectDir = binDir.deletingLastPathComponent().path
}

let app = NSApplication.shared
let delegate = PiMenuBar(projectDir: projectDir)
app.delegate = delegate
app.setActivationPolicy(.accessory)   // hide from Dock, show only in menubar
app.run()
