/**
 * main.swift – macOS menubar manager for my-pi.
 *
 * Build:
 *   swiftc -strict-concurrency=minimal \
 *          -o dist/my-pi-menubar menubar/main.swift -framework AppKit
 *
 * Run:
 *   ./dist/my-pi-menubar [/path/to/project-dir]
 *   (defaults to the nearest parent dir containing package.json)
 *
 * The menubar app controls a launchd user service (com.mypi) so the same
 * start/stop lifecycle can also be managed from shell scripts.
 */

import AppKit
import Darwin
import Foundation

private struct ToolResult {
    let status: Int32
    let stdout: String
    let stderr: String
}

// ─── Menubar controller ───────────────────────────────────────────────────────

final class PiMenuBar: NSObject, NSApplicationDelegate {

    // MARK: – State

    private let launchCtlPath = "/bin/launchctl"
    private let psPath = "/bin/ps"
    private let pgrepPath = "/usr/bin/pgrep"
    private let tailPath = "/usr/bin/tail"

    private var statusItem: NSStatusItem!
    private var logLines: [String] = []
    private let maxLogLines = 300
    private var rebuildDebounce: Timer?
    private var logFileHandle: FileHandle?

    private let projectDir: String
    private let launchAgentLabel = "com.mypi"

    private var bundledRuntimeDir: String? {
        guard let resourcePath = Bundle.main.resourcePath else { return nil }
        let candidate = resourcePath + "/runtime"
        return FileManager.default.fileExists(atPath: candidate + "/my-pi") ? candidate : nil
    }
    private var isBundledApp: Bool { bundledRuntimeDir != nil }
    private var runtimeDir: String { bundledRuntimeDir ?? "\(projectDir)/dist" }
    private var binaryPath: String { "\(runtimeDir)/my-pi" }
    private var workingDirectory: String { runtimeDir }
    private var envFilePath: String {
        isBundledApp ? "\(stateDir)/.env" : "\(projectDir)/.env"
    }
    private var bundledEnvExamplePath: String? {
        guard let resourcePath = Bundle.main.resourcePath else { return nil }
        let candidate = resourcePath + "/env.example"
        return FileManager.default.fileExists(atPath: candidate) ? candidate : nil
    }
    private var launchAgentsDir: String { "\(homeDir)/Library/LaunchAgents" }
    private var launchAgentPath: String { "\(launchAgentsDir)/\(launchAgentLabel).plist" }
    private var launchAgentTarget: String { "\(launchDomain)/\(launchAgentLabel)" }
    private var launchDomain: String { "gui/\(getuid())" }
    private var stateDir: String { "\(homeDir)/.my-pi" }
    private var controllerLogPath: String { "\(stateDir)/menubar.log" }
    private var serviceLogPath: String { "\(stateDir)/service.log" }
    private var homeDir: String {
        ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
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

        setIcon(running: isRunning())
        rebuildMenu()
        startPi()
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopPi()
        logFileHandle?.closeFile()
    }

    // MARK: – Service management

    private func isRunning() -> Bool {
        !currentServicePIDs().isEmpty
    }

    private func isLoaded() -> Bool {
        runTool(launchCtlPath, arguments: ["print", launchAgentTarget]).status == 0
    }

    private func ensureBinaryExists() -> Bool {
        guard FileManager.default.fileExists(atPath: binaryPath) else {
            appendLog("[menubar] ⚠️  Binary not found: \(binaryPath)\n         Run 'make build' or 'make app' first.")
            return false
        }
        return true
    }

    private func ensureDirectories() throws {
        try FileManager.default.createDirectory(
            at: URL(fileURLWithPath: stateDir),
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(
            at: URL(fileURLWithPath: launchAgentsDir),
            withIntermediateDirectories: true
        )
        try installBundledEnvExampleIfNeeded()
    }

    private func installLaunchAgentPlist() throws {
        let plist: [String: Any] = [
            "Label": launchAgentLabel,
            "ProgramArguments": [binaryPath],
            "WorkingDirectory": workingDirectory,
            "EnvironmentVariables": serviceEnvironment(),
            "RunAtLoad": true,
            "KeepAlive": true,
            "StandardOutPath": serviceLogPath,
            "StandardErrorPath": serviceLogPath,
        ]

        let data = try PropertyListSerialization.data(
            fromPropertyList: plist,
            format: .xml,
            options: 0
        )
        try data.write(to: URL(fileURLWithPath: launchAgentPath), options: .atomic)
        appendLog("[menubar] LaunchAgent ready: \(launchAgentPath)")
    }

    @objc func startPi() {
        guard ensureBinaryExists() else {
            setIcon(running: false)
            rebuildMenu()
            return
        }

        do {
            try ensureDirectories()
            try installLaunchAgentPlist()
        } catch {
            appendLog("[menubar] ❌ Failed to prepare LaunchAgent: \(error.localizedDescription)")
            setIcon(running: false)
            rebuildMenu()
            return
        }

        if isLoaded() {
            if isRunning() {
                appendLog("[menubar] Service already running.")
            } else {
                let result = runTool(launchCtlPath, arguments: ["kickstart", "-k", launchAgentTarget])
                if result.status == 0 {
                    appendLog("[menubar] Service started via kickstart.")
                } else {
                    appendLog("[menubar] ❌ Failed to start service: \(errorSummary(from: result))")
                }
            }
        } else {
            let result = runTool(launchCtlPath, arguments: ["bootstrap", launchDomain, launchAgentPath])
            if result.status == 0 {
                appendLog("[menubar] Service bootstrapped.")
            } else {
                appendLog("[menubar] ❌ Failed to bootstrap service: \(errorSummary(from: result))")
            }
        }

        _ = waitForRunningState(true, timeout: 3.0)
        let running = isRunning()
        setIcon(running: running)
        rebuildMenu()
    }

    @objc func stopPi() {
        let rootPIDs = currentServicePIDs()
        let trackedTrees = rootPIDs.map { (root: $0, descendants: descendantPIDs(of: $0)) }
        let loaded = isLoaded()

        guard loaded || !rootPIDs.isEmpty else {
            setIcon(running: false)
            rebuildMenu()
            return
        }

        if loaded {
            let result = runTool(launchCtlPath, arguments: ["bootout", launchDomain, launchAgentPath])
            if result.status == 0 {
                appendLog("[menubar] Service stopped via bootout.")
            } else {
                let fallback = runTool(launchCtlPath, arguments: ["bootout", launchAgentTarget])
                if fallback.status == 0 {
                    appendLog("[menubar] Service stopped via bootout.")
                } else {
                    appendLog("[menubar] ⚠️  launchctl bootout failed: \(errorSummary(from: fallback))")
                }
            }
        }

        _ = waitForRunningState(false, timeout: 3.0)

        if hasTrackedProcessesRunning(trackedTrees) {
            let runningCount = trackedProcessCount(trackedTrees)
            appendLog(
                runningCount == 1
                    ? "[menubar] 1 service or child process is still running – sending SIGTERM."
                    : "[menubar] \(runningCount) service/child processes are still running – sending SIGTERM."
            )
            terminateTrackedTrees(trackedTrees, signal: SIGTERM)
            _ = waitForTrackedTreesToExit(trackedTrees, timeout: 3.0)
        }

        if hasTrackedProcessesRunning(trackedTrees) {
            let runningCount = trackedProcessCount(trackedTrees)
            appendLog(
                runningCount == 1
                    ? "[menubar] 1 process did not exit in time – sending SIGKILL."
                    : "[menubar] \(runningCount) processes did not exit in time – sending SIGKILL."
            )
            terminateTrackedTrees(trackedTrees, signal: SIGKILL)
        }

        setIcon(running: false)
        rebuildMenu()
    }

    @objc func restartPi() {
        guard ensureBinaryExists() else {
            setIcon(running: false)
            rebuildMenu()
            return
        }

        do {
            try ensureDirectories()
            try installLaunchAgentPlist()
        } catch {
            appendLog("[menubar] ❌ Failed to prepare LaunchAgent: \(error.localizedDescription)")
            setIcon(running: false)
            rebuildMenu()
            return
        }

        if isLoaded() {
            let result = runTool(launchCtlPath, arguments: ["kickstart", "-k", launchAgentTarget])
            if result.status == 0 {
                appendLog("[menubar] Service restarted.")
            } else {
                appendLog("[menubar] ❌ Failed to restart service: \(errorSummary(from: result))")
            }
        } else {
            let result = runTool(launchCtlPath, arguments: ["bootstrap", launchDomain, launchAgentPath])
            if result.status == 0 {
                appendLog("[menubar] Service bootstrapped.")
            } else {
                appendLog("[menubar] ❌ Failed to bootstrap service: \(errorSummary(from: result))")
            }
        }

        _ = waitForRunningState(true, timeout: 3.0)
        let running = isRunning()
        setIcon(running: running)
        rebuildMenu()
    }

    private func waitForRunningState(_ desired: Bool, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if isRunning() == desired {
                return true
            }
            _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
        }
        return isRunning() == desired
    }

    private func currentServicePIDs() -> [Int32] {
        let result = runTool(psPath, arguments: ["-axo", "pid=,command="])
        guard result.status == 0 else {
            appendLog("[menubar] Failed to inspect processes: \(errorSummary(from: result))")
            return []
        }

        return result.stdout
            .split(whereSeparator: { $0.isNewline })
            .compactMap { line -> Int32? in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard !trimmed.isEmpty else { return nil }
                let parts = trimmed.split(maxSplits: 1, whereSeparator: { $0.isWhitespace })
                guard parts.count == 2, let pid = Int32(parts[0]) else { return nil }
                let command = String(parts[1])
                guard command == binaryPath || command.hasPrefix(binaryPath + " ") else {
                    return nil
                }
                return pid
            }
    }

    private func processExists(_ pid: Int32) -> Bool {
        guard pid > 0 else { return false }
        if kill(pid, 0) == 0 {
            return true
        }
        return errno == EPERM
    }

    private func trackedProcessCount(_ trees: [(root: Int32, descendants: [Int32])]) -> Int {
        trees.reduce(into: 0) { count, tree in
            if processExists(tree.root) {
                count += 1
            }
            count += tree.descendants.filter(processExists).count
        }
    }

    private func hasTrackedProcessesRunning(_ trees: [(root: Int32, descendants: [Int32])]) -> Bool {
        trees.contains { tree in
            processExists(tree.root) || tree.descendants.contains(where: processExists)
        }
    }

    private func terminateTrackedTrees(
        _ trees: [(root: Int32, descendants: [Int32])],
        signal: Int32
    ) {
        for tree in trees {
            let liveDescendants = tree.descendants.filter(processExists)
            guard processExists(tree.root) || !liveDescendants.isEmpty else { continue }
            signalProcessTree(rootPID: tree.root, descendants: liveDescendants, signal: signal)
        }
    }

    private func waitForTrackedTreesToExit(
        _ trees: [(root: Int32, descendants: [Int32])],
        timeout: TimeInterval
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !hasTrackedProcessesRunning(trees) {
                return true
            }
            _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
        }
        return !hasTrackedProcessesRunning(trees)
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
        let result = runTool(pgrepPath, arguments: ["-P", String(pid)])
        if result.status == 1 {
            return [] // no children
        }
        guard result.status == 0 else {
            appendLog("[menubar] pgrep failed for PID \(pid): \(errorSummary(from: result))")
            return []
        }

        return result.stdout
            .split(whereSeparator: { $0.isNewline })
            .compactMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }

    @objc func quitMenubar() {
        stopPi()
        NSApplication.shared.terminate(nil)
    }

    // MARK: – Menu

    func rebuildMenu() {
        let menu = NSMenu()
        menu.autoenablesItems = false

        let running = isRunning()
        let statusLabel = NSMenuItem(
            title: running ? "● Running" : "○ Stopped",
            action: nil,
            keyEquivalent: ""
        )
        statusLabel.isEnabled = false
        statusLabel.attributedTitle = makeStatusTitle(running: running)
        menu.addItem(statusLabel)

        let dirItem = NSMenuItem(
            title: "  \(runtimeDir)",
            action: nil,
            keyEquivalent: ""
        )
        dirItem.isEnabled = false
        dirItem.attributedTitle = makeSmallGrayTitle("  \(contractPath(runtimeDir))")
        menu.addItem(dirItem)

        menu.addItem(.separator())

        if running {
            let stop = NSMenuItem(title: "Stop", action: #selector(stopPi), keyEquivalent: "")
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

        let logsParent = NSMenuItem(title: "Recent Logs", action: nil, keyEquivalent: "")
        let logsSubmenu = NSMenu(title: "Recent Logs")
        let recentLines = recentVisibleLogLines()
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

        let openLog = NSMenuItem(title: "Open Service Log", action: #selector(openLogFile), keyEquivalent: "l")
        openLog.target = self
        menu.addItem(openLog)

        let openMenubarLog = NSMenuItem(title: "Open Controller Log", action: #selector(openControllerLogFile), keyEquivalent: "")
        openMenubarLog.target = self
        menu.addItem(openMenubarLog)

        menu.addItem(.separator())

        let quit = NSMenuItem(title: "Quit MyPi", action: #selector(quitMenubar), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        statusItem.menu = menu
    }

    private func recentVisibleLogLines() -> [String] {
        let serviceLines = tailLines(path: serviceLogPath, lines: 25)
        if !serviceLines.isEmpty {
            return serviceLines
        }
        return Array(logLines.suffix(25))
    }

    private func tailLines(path: String, lines: Int) -> [String] {
        guard FileManager.default.fileExists(atPath: path) else { return [] }
        let result = runTool(tailPath, arguments: ["-n", String(lines), path])
        guard result.status == 0 else { return [] }
        return result.stdout
            .components(separatedBy: .newlines)
            .filter { !$0.isEmpty }
    }

    @objc func openLogFile() {
        let url = URL(fileURLWithPath: serviceLogPath)
        NSWorkspace.shared.open(url)
    }

    @objc func openControllerLogFile() {
        let url = URL(fileURLWithPath: controllerLogPath)
        NSWorkspace.shared.open(url)
    }

    // MARK: – Icon

    private func setIcon(running: Bool) {
        guard let button = statusItem.button else { return }
        if let sym = NSImage(
            systemSymbolName: "dot.radiowaves.left.and.right",
            accessibilityDescription: running ? "Pi running" : "Pi stopped"
        ) {
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
            button.image = nil
            button.title = running ? "π●" : "π○"
        }
    }

    // MARK: – Logging

    private func appendLog(_ text: String) {
        if let data = text.data(using: .utf8) {
            logFileHandle?.write(data)
            if !text.hasSuffix("\n"), let nl = "\n".data(using: .utf8) {
                logFileHandle?.write(nl)
            }
        }

        let lines = text.components(separatedBy: .newlines).filter { !$0.isEmpty }
        logLines.append(contentsOf: lines)
        if logLines.count > maxLogLines {
            logLines.removeFirst(logLines.count - maxLogLines)
        }

        rebuildDebounce?.invalidate()
        rebuildDebounce = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: false) { [weak self] _ in
            self?.rebuildMenu()
        }
    }

    private func setupLogFile() {
        try? FileManager.default.createDirectory(
            at: URL(fileURLWithPath: stateDir),
            withIntermediateDirectories: true
        )
        FileManager.default.createFile(atPath: controllerLogPath, contents: nil)
        logFileHandle = FileHandle(forWritingAtPath: controllerLogPath)
        logFileHandle?.seekToEndOfFile()
        appendLog("[menubar] Log opened. Runtime: \(runtimeDir)")
        appendLog("[menubar] Config file: \(envFilePath)")
    }

    private func installBundledEnvExampleIfNeeded() throws {
        guard isBundledApp,
              let bundledEnvExamplePath,
              !FileManager.default.fileExists(atPath: stateDir + "/.env.example") else {
            return
        }

        try FileManager.default.copyItem(
            atPath: bundledEnvExamplePath,
            toPath: stateDir + "/.env.example"
        )
        appendLog("[menubar] Wrote example config: \(stateDir)/.env.example")
    }

    private func serviceEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["HOME"] = homeDir
        env["PATH"] = mergedPathValue()

        let fileEnv = loadEnvFile(path: envFilePath)
        for (key, value) in fileEnv {
            env[key] = value
        }

        if fileEnv.isEmpty && isBundledApp {
            appendLog(
                "[menubar] No config found at \(envFilePath). Copy ~/.my-pi/.env.example to ~/.my-pi/.env and restart."
            )
        }

        return env
    }

    private func loadEnvFile(path: String) -> [String: String] {
        guard let raw = try? String(contentsOfFile: path, encoding: .utf8) else {
            return [:]
        }

        var env: [String: String] = [:]
        for rawLine in raw.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty, !line.hasPrefix("#") else { continue }
            let parts = line.split(separator: "=", maxSplits: 1)
            guard parts.count == 2 else { continue }

            let key = String(parts[0]).trimmingCharacters(in: .whitespaces)
            var value = String(parts[1]).trimmingCharacters(in: .whitespaces)
            if (value.hasPrefix("\"") && value.hasSuffix("\"")) ||
               (value.hasPrefix("'") && value.hasSuffix("'")) {
                value = String(value.dropFirst().dropLast())
            }
            env[key] = value
        }
        return env
    }

    private func mergedPathValue() -> String {
        let common = [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        let envParts = (ProcessInfo.processInfo.environment["PATH"] ?? "")
            .split(separator: ":")
            .map(String.init)

        var seen = Set<String>()
        var merged: [String] = []
        for value in common + envParts {
            guard !value.isEmpty, seen.insert(value).inserted else { continue }
            merged.append(value)
        }
        return merged.joined(separator: ":")
    }

    private func errorSummary(from result: ToolResult) -> String {
        let stderr = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        if !stderr.isEmpty {
            return stderr
        }
        let stdout = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        if !stdout.isEmpty {
            return stdout
        }
        return "exit code \(result.status)"
    }

    private func runTool(_ launchPath: String, arguments: [String]) -> ToolResult {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: launchPath)
        task.arguments = arguments

        let stdout = Pipe()
        let stderr = Pipe()
        task.standardOutput = stdout
        task.standardError = stderr

        do {
            try task.run()
            task.waitUntilExit()
        } catch {
            return ToolResult(status: 127, stdout: "", stderr: error.localizedDescription)
        }

        let stdoutData = stdout.fileHandleForReading.readDataToEndOfFile()
        let stderrData = stderr.fileHandleForReading.readDataToEndOfFile()
        return ToolResult(
            status: task.terminationStatus,
            stdout: String(data: stdoutData, encoding: .utf8) ?? "",
            stderr: String(data: stderrData, encoding: .utf8) ?? ""
        )
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
        homeDir.isEmpty ? path : path.replacingOccurrences(of: homeDir, with: "~")
    }
}

// ─── Entry point helpers ─────────────────────────────────────────────────────

private func resolveProjectDir(arguments: [String]) -> String {
    let fm = FileManager.default

    if arguments.count > 1 {
        return (arguments[1] as NSString).expandingTildeInPath
    }

    if let resourcePath = Bundle.main.path(forResource: "project-dir", ofType: "txt"),
       let configuredPath = try? String(contentsOfFile: resourcePath, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines),
       !configuredPath.isEmpty,
       fm.fileExists(atPath: configuredPath + "/package.json") {
        return configuredPath
    }

    let executableURL = URL(fileURLWithPath: arguments[0]).resolvingSymlinksInPath()
    var candidate = executableURL.deletingLastPathComponent()

    for _ in 0..<10 {
        let path = candidate.path
        if fm.fileExists(atPath: path + "/package.json") {
            return path
        }
        let parent = candidate.deletingLastPathComponent()
        if parent.path == candidate.path { break }
        candidate = parent
    }

    return URL(fileURLWithPath: FileManager.default.currentDirectoryPath).path
}

// ─── Entry point ─────────────────────────────────────────────────────────────

let args = CommandLine.arguments
let projectDir = resolveProjectDir(arguments: args)

let app = NSApplication.shared
let delegate = PiMenuBar(projectDir: projectDir)
app.delegate = delegate
app.setActivationPolicy(.accessory)   // hide from Dock, show only in menubar
app.run()
