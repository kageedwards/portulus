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

// Resolve lxcf_bridge.py from the installed npm package
const LXCF_PKG_DIR = path.dirname(require.resolve("lxcf/package.json"));
const BRIDGE_SCRIPT = path.join(LXCF_PKG_DIR, "lxcf_bridge.py");
const VENV_DIR = path.join(LXCF_PKG_DIR, ".venv");
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
let bridge = null;       // child_process handle
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
// Python bridge manager
// ------------------------------------------------------------------

const mgr = createBridgeManager({
    send,
});
const { bridgeRequest, bridgeSend } = mgr;

function ensureVenv() {
    if(fs.existsSync(VENV_PYTHON)) return;
    console.log("[bridge] venv missing — bootstrapping…");
    if(fs.existsSync(SETUP_VENV)){
        execFileSync("python3", [SETUP_VENV], { stdio: "inherit" });
    } else {
        // setup_venv.py not shipped yet — inline bootstrap
        execFileSync("python3", ["-m", "venv", VENV_DIR], { stdio: "inherit" });
        const pip = process.platform === "win32"
            ? path.join(VENV_DIR, "Scripts", "pip")
            : path.join(VENV_DIR, "bin", "pip");
        execFileSync(pip, ["install", "--quiet", LXCF_PKG_DIR], { stdio: "inherit" });
    }
}

function spawnBridge() {
    ensureVenv();

    bridge = spawn(VENV_PYTHON, [BRIDGE_SCRIPT], {
        stdio: ["pipe", "pipe", "pipe"],
    });

    mgr.setStdinWrite((data) => {
        if(bridge && bridge.stdin.writable) bridge.stdin.write(data);
    });

    // Parse NDJSON lines from stdout
    const rl = createInterface({ input: bridge.stdout });
    rl.on("line", (line) => mgr.handleLine(line));

    // Forward stderr to console
    bridge.stderr.on("data", (chunk) => {
        process.stderr.write(chunk);
    });

    // Log exit
    bridge.on("exit", (code) => {
        if(code !== 0 && code !== null){
            console.log(`[bridge] exited with code ${code}`);
        }
        bridge = null;
        mgr.setStdinWrite(null);
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
        app.quit();
    });
}

// ------------------------------------------------------------------
// Window creation
// ------------------------------------------------------------------

function createWindow() {
    win = new BrowserWindow({
        width: 1100,
        height: 720,
        minWidth: 640,
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
});

app.on("window-all-closed", () => {
    if(bridge) bridge.kill("SIGTERM");
    app.quit();
});

app.on("quit", () => {
    if(bridge) bridge.kill("SIGKILL");
});
