/**
 * Portulus — Electron main process.
 *
 * Spawns a Python LXCF bridge child process and communicates
 * with it via NDJSON over stdin/stdout.  The renderer talks to
 * this main process via Electron IPC — unchanged from before.
 */

import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import os from "os";
import { spawn, execFileSync } from "child_process";
import { createInterface } from "readline";

import ini from "ini";
import { createRequire } from "module";
import { createBridgeManager } from "./bridge.js";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve lxcf package — from extraResources when packaged, node_modules in dev
const LXCF_PKG_DIR = app.isPackaged
    ? path.join(process.resourcesPath, "lxcf")
    : path.dirname(require.resolve("lxcf/package.json"));
const BRIDGE_SCRIPT = path.join(LXCF_PKG_DIR, "lxcf_bridge.py");
// Packaged app bundle is read-only on macOS — put venv in user data dir
const VENV_DIR = app.isPackaged
    ? path.join(os.homedir(), ".lxcf", "venv")
    : path.join(LXCF_PKG_DIR, ".venv");
const VENV_PYTHON = process.platform === "win32"
    ? path.join(VENV_DIR, "Scripts", "python.exe")
    : path.join(VENV_DIR, "bin", "python3");
const SETUP_VENV = path.join(LXCF_PKG_DIR, "setup_venv.py");

const STORE_PATH = path.join(os.homedir(), ".lxcf");
const SETTINGS_PATH = path.join(STORE_PATH, "portulus.json");
const CONFIG_PATH = path.join(STORE_PATH, "config");

// ------------------------------------------------------------------
// Shared config (~/.lxcf/config, INI format, shared with TUI)
// ------------------------------------------------------------------

const CONFIG_DEFAULTS = {
    lxcf: {
        nick: "anon",
        announce_joins: "True",
        use_local_rnsd: "True",
    },
};

function loadConfig() {
    try {
        if(fs.existsSync(CONFIG_PATH)){
            const parsed = ini.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
            const section = parsed.lxcf ?? {};
            return {
                nick: (section.nick ?? "anon").trim() || "anon",
                announceJoins: String(section.announce_joins ?? "True").toLowerCase() !== "false",
                useLocalRnsd: String(section.use_local_rnsd ?? "True").toLowerCase() !== "false",
            };
        }
    } catch(e) { /* use defaults */ }
    return { nick: "anon", announceJoins: true, useLocalRnsd: true };
}

function saveConfig(values) {
    fs.mkdirSync(STORE_PATH, { recursive: true });

    let parsed = {};
    try {
        if(fs.existsSync(CONFIG_PATH)){
            parsed = ini.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        }
    } catch(e) { /* start fresh */ }

    parsed.lxcf = {
        ...(CONFIG_DEFAULTS.lxcf),
        ...(parsed.lxcf ?? {}),
        nick: values.nick ?? parsed.lxcf?.nick ?? "anon",
        announce_joins: values.announceJoins != null
            ? (values.announceJoins ? "True" : "False")
            : (parsed.lxcf?.announce_joins ?? "True"),
        use_local_rnsd: values.useLocalRnsd != null
            ? (values.useLocalRnsd ? "True" : "False")
            : (parsed.lxcf?.use_local_rnsd ?? "True"),
    };

    fs.writeFileSync(CONFIG_PATH, ini.stringify(parsed));
}

// ------------------------------------------------------------------
// Settings
// ------------------------------------------------------------------

const DEFAULT_SETTINGS = {
    nick: null,
    theme: "midnight",
    interfaces: [
        { name: "RMAP.World", host: "rmap.world", port: 4242 },
    ],
};

function loadSettings() {
    try {
        if(fs.existsSync(SETTINGS_PATH)){
            return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8")) };
        }
    } catch(e) { /* use defaults */ }
    return { ...DEFAULT_SETTINGS };
}

function saveSettings(s) {
    fs.mkdirSync(STORE_PATH, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

// ------------------------------------------------------------------
// App state
// ------------------------------------------------------------------

let win = null;
let bridge = null;       // child_process handle (LXCF)
let rrcBridge = null;    // child_process handle (RRC)
let settings = loadSettings();
let config = loadConfig();
const resolvedNick = settings.nick || config.nick || "anon";

const rnsConfigOverride = app.commandLine.getSwitchValue("rns-config");
const RNS_CONFIG_PATH = rnsConfigOverride || path.join(os.homedir(), ".reticulum");

function send(channel, ...args) {
    if(win && !win.isDestroyed()){
        win.webContents.send(channel, ...args);
    }
}

// ------------------------------------------------------------------
// Python bridge managers
// ------------------------------------------------------------------

const RRC_BRIDGE_SCRIPT = path.join(__dirname, "rrc_bridge.py");

const lxcfMgr = createBridgeManager({ send, eventPrefix: "lxcf" });
const { bridgeRequest, bridgeSend } = lxcfMgr;

const rrcMgr = createBridgeManager({ send, eventPrefix: "rrc" });
const { bridgeRequest: rrcBridgeRequest, bridgeSend: rrcBridgeSend } = rrcMgr;

function findSystemPython() {
    const candidates = [
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python3",
    ];
    for(const p of candidates){
        if(fs.existsSync(p)) return p;
    }
    return "python3"; // fall back to PATH lookup
}

// Pinned dependency versions — bump these to trigger a venv rebuild.
// The version stamp is a composite of all three; if any changes, the
// venv is torn down and rebuilt from scratch on next launch.
const RRC_TUI_GIT = "git+https://github.com/kc1awv/rrc-tui.git";
const RRC_TUI_PIN = "0.1.0";   // bump when upstream releases
const CBOR2_PIN   = "cbor2>=5.6.0";

function ensureVenv() {
    const venvVersionFile = path.join(VENV_DIR, ".portulus-deps");

    // Build a composite stamp: lxcf version + rrc-tui pin + cbor2 pin
    let lxcfVersion = "unknown";
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(LXCF_PKG_DIR, "package.json"), "utf-8"));
        lxcfVersion = pkg.version || "unknown";
    } catch(e) { /* use unknown */ }

    const currentStamp = `lxcf=${lxcfVersion};rrc-tui=${RRC_TUI_PIN};cbor2=${CBOR2_PIN}`;

    if(fs.existsSync(VENV_PYTHON)){
        try {
            const installed = fs.readFileSync(venvVersionFile, "utf-8").trim();
            if(installed === currentStamp) return;
            console.log(`[bridge] deps changed, rebuilding venv…`);
            console.log(`[bridge]   was: ${installed}`);
            console.log(`[bridge]   now: ${currentStamp}`);
        } catch(e) {
            console.log("[bridge] venv version unknown, rebuilding…");
        }
        fs.rmSync(VENV_DIR, { recursive: true, force: true });
    } else {
        console.log("[bridge] venv missing — bootstrapping…");
    }

    const sysPython = findSystemPython();
    try {
        execFileSync(sysPython, ["-m", "venv", VENV_DIR], { stdio: "inherit" });
        const pip = process.platform === "win32"
            ? path.join(VENV_DIR, "Scripts", "pip")
            : path.join(VENV_DIR, "bin", "pip");
        const pipOpts = { stdio: ["pipe", "pipe", "pipe"] };

        // 1. LXCF (bundled package — pulls rns, lxmf, msgpack)
        execFileSync(pip, ["install", "--quiet", LXCF_PKG_DIR], pipOpts);

        // 2. cbor2 first (so rrc-tui's dep check finds it)
        execFileSync(pip, ["install", "--quiet", CBOR2_PIN], pipOpts);

        // 3. rrc-tui (MIT, by S. Miller KC1AWV) — --no-deps skips textual.
        //    The pip resolver may warn about missing textual; this is expected
        //    and harmless since our bridge never imports it.
        execFileSync(pip, [
            "install", "--quiet", "--no-deps", RRC_TUI_GIT,
        ], pipOpts);

        fs.writeFileSync(venvVersionFile, currentStamp);
    } catch(err) {
        console.error("[bridge] failed to bootstrap venv:", err.message);
    }
}

function spawnBridge() {
    ensureVenv();

    bridge = spawn(VENV_PYTHON, [BRIDGE_SCRIPT], {
        stdio: ["pipe", "pipe", "pipe"],
    });

    lxcfMgr.setStdinWrite((data) => {
        if(bridge && bridge.stdin.writable) bridge.stdin.write(data);
    });

    // Parse NDJSON lines from stdout
    const rl = createInterface({ input: bridge.stdout });
    rl.on("line", (line) => lxcfMgr.handleLine(line));

    // Forward stderr to console
    bridge.stderr.on("data", (chunk) => {
        process.stderr.write(chunk);
    });

    // Log exit
    bridge.on("exit", (code) => {
        if(code !== 0 && code !== null){
            console.log(`[lxcf-bridge] exited with code ${code}`);
        }
        bridge = null;
        lxcfMgr.setStdinWrite(null);
    });
}

function spawnRrcBridge() {
    ensureVenv();

    rrcBridge = spawn(VENV_PYTHON, [RRC_BRIDGE_SCRIPT], {
        stdio: ["pipe", "pipe", "pipe"],
    });

    rrcMgr.setStdinWrite((data) => {
        if(rrcBridge && rrcBridge.stdin.writable) rrcBridge.stdin.write(data);
    });

    // Parse NDJSON lines from stdout
    const rl = createInterface({ input: rrcBridge.stdout });
    rl.on("line", (line) => rrcMgr.handleLine(line));

    // Forward stderr to console
    rrcBridge.stderr.on("data", (chunk) => {
        process.stderr.write(chunk);
    });

    // Log exit
    rrcBridge.on("exit", (code) => {
        if(code !== 0 && code !== null){
            console.log(`[rrc-bridge] exited with code ${code}`);
        }
        rrcBridge = null;
        rrcMgr.setStdinWrite(null);
    });
}

// ------------------------------------------------------------------
// IPC handlers
// ------------------------------------------------------------------

function setupIPC() {

    ipcMain.handle("join", (_, channelName, hubTag, key) =>
        bridgeRequest("join", { channel: channelName, hub: hubTag || null, key: key || null }));

    ipcMain.handle("leave", (_, cid) =>
        bridgeRequest("leave", { cid }));

    ipcMain.handle("send", (_, cid, body) =>
        bridgeRequest("send", { cid, body }));

    ipcMain.handle("emote", (_, cid, body) =>
        bridgeRequest("emote", { cid, body }));

    ipcMain.handle("set-topic", (_, cid, topic) =>
        bridgeRequest("set_topic", { cid, topic }));

    ipcMain.handle("change-nick", (_, newNick) =>
        bridgeRequest("change_nick", { nick: newNick }));

    ipcMain.handle("privmsg", (_, destHash, body) =>
        bridgeRequest("privmsg", { dest_hash: destHash, body }));

    // Hub management — delegated to Python bridge
    ipcMain.handle("get-hubs", () =>
        bridgeRequest("get_hubs", {}));

    ipcMain.handle("save-hub", (_, tag, destination) =>
        bridgeRequest("save_hub", { tag, destination }));

    ipcMain.handle("delete-hub", (_, tag) =>
        bridgeRequest("delete_hub", { tag }));

    ipcMain.handle("toggle-bookmark", (_, channelName, hubTag, key) =>
        bridgeRequest("toggle_bookmark", { channel: channelName, hub: hubTag || null, key: key || null }));

    // JS-only handlers — no Python involvement
    ipcMain.handle("get-settings", () => settings);

    ipcMain.handle("save-settings", (_, newSettings) => {
        settings = { ...settings, ...newSettings };
        saveSettings(settings);
        return settings;
    });

    ipcMain.handle("quit", async () => {
        try { await bridgeRequest("quit", {}); } catch(e) { /* ignore */ }
        try { await rrcBridgeRequest("quit", {}); } catch(e) { /* ignore */ }
        app.quit();
    });

    // ------------------------------------------------------------------
    // RRC IPC handlers
    // ------------------------------------------------------------------

    ipcMain.handle("rrc-connect-hub", (_, hubHash, destName) =>
        rrcBridgeRequest("connect_hub", { hub_hash: hubHash, dest_name: destName || null }));

    ipcMain.handle("rrc-disconnect-hub", (_, hubHash) =>
        rrcBridgeRequest("disconnect_hub", { hub_hash: hubHash }));

    ipcMain.handle("rrc-join", (_, room) =>
        rrcBridgeRequest("join", { room }));

    ipcMain.handle("rrc-leave", (_, room) =>
        rrcBridgeRequest("leave", { room }));

    ipcMain.handle("rrc-send", (_, room, body) =>
        rrcBridgeRequest("send", { room, body }));

    ipcMain.handle("rrc-change-nick", (_, nick) =>
        rrcBridgeRequest("change_nick", { nick }));

    ipcMain.handle("rrc-discover-hubs", () =>
        rrcBridgeRequest("discover_hubs", {}));

    ipcMain.handle("rrc-save-hub", (_, tag, destination, destName) =>
        rrcBridgeRequest("save_hub", { tag, destination, dest_name: destName || null }));

    ipcMain.handle("rrc-delete-hub", (_, tag) =>
        rrcBridgeRequest("delete_hub", { tag }));
}

// ------------------------------------------------------------------
// Window creation
// ------------------------------------------------------------------

function createWindow() {
    win = new BrowserWindow({
        width: 1100,
        height: 720,
        minWidth: 240,
        minHeight: 480,
        backgroundColor: "#000000",
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 16, y: 16 },
        webPreferences: {
            preload: path.join(__dirname, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    win.loadFile(path.join(__dirname, "renderer", "index.html"));
    // win.webContents.openDevTools({ mode: "bottom" });
}

// ------------------------------------------------------------------
// App lifecycle
// ------------------------------------------------------------------

app.whenReady().then(() => {
    setupIPC();
    createWindow();
    spawnBridge();
    bridgeSend("init", {
        nick: resolvedNick,
        use_local_rnsd: config.useLocalRnsd,
        rns_config_dir: RNS_CONFIG_PATH,
    });
    spawnRrcBridge();
    rrcBridgeSend("init", {
        nick: resolvedNick,
        rns_config_dir: RNS_CONFIG_PATH,
    });
});

app.on("window-all-closed", () => {
    if(bridge) bridge.kill("SIGTERM");
    if(rrcBridge) rrcBridge.kill("SIGTERM");
    app.quit();
});

app.on("quit", () => {
    if(bridge) bridge.kill("SIGKILL");
    if(rrcBridge) rrcBridge.kill("SIGKILL");
});
