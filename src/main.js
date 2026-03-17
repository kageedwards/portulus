/**
 * Portulus — Electron main process.
 *
 * Manages the LXCF client on the Node.js side and communicates
 * with the renderer via IPC.
 */

import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import fs from "fs";
import os from "os";

import { Reticulum, Identity, Destination, TCPClientInterface, LXMRouter } from "@liamcottle/rns.js";
import ini from "ini";
import { Client, channelId } from "lxcf";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STORE_PATH = path.join(os.homedir(), ".lxcf");
const IDENTITY_PATH = path.join(STORE_PATH, "identity");
const BOOKMARKS_PATH = path.join(STORE_PATH, "bookmarks.json");
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

    // load existing INI to preserve comments and extra keys
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
        { name: "RNS TestNet BetweenTheBorders", host: "betweentheborders.com", port: 4242 },
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

function saveSettings(settings) {
    fs.mkdirSync(STORE_PATH, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// ------------------------------------------------------------------
// Bookmarks (shared format with TUI)
// ------------------------------------------------------------------

function loadBookmarks() {
    try {
        if(fs.existsSync(BOOKMARKS_PATH)){
            const data = JSON.parse(fs.readFileSync(BOOKMARKS_PATH, "utf-8"));
            return Array.isArray(data) ? data : [];
        }
    } catch(e) { /* empty */ }
    return [];
}

function saveBookmarks(bookmarks) {
    fs.mkdirSync(STORE_PATH, { recursive: true });
    fs.writeFileSync(BOOKMARKS_PATH, JSON.stringify(bookmarks, null, 2));
}

// ------------------------------------------------------------------
// Identity (shared format with TUI)
// ------------------------------------------------------------------

function loadOrCreateIdentity() {
    fs.mkdirSync(STORE_PATH, { recursive: true });

    if(fs.existsSync(IDENTITY_PATH)){
        const keyBytes = fs.readFileSync(IDENTITY_PATH);
        return Identity.fromPrivateKey(keyBytes);
    }

    const identity = Identity.create();
    fs.writeFileSync(IDENTITY_PATH, identity.getPrivateKey());
    return identity;
}

// ------------------------------------------------------------------
// App state
// ------------------------------------------------------------------

let win = null;
let rns = null;
let client = null;
let settings = loadSettings();
let bookmarks = loadBookmarks();
let config = loadConfig();
const announce = config.announceJoins;
const resolvedNick = settings.nick || config.nick || "anon";

function send(channel, ...args) {
    if(win && !win.isDestroyed()){
        win.webContents.send(channel, ...args);
    }
}

// ------------------------------------------------------------------
// RNS config (~/.reticulum/config) — parse TCPClientInterface entries
// ------------------------------------------------------------------

const rnsConfigOverride = app.commandLine.getSwitchValue("rns-config");
const RNS_CONFIG_PATH = rnsConfigOverride || path.join(os.homedir(), ".reticulum", "config");

function loadRnsInterfaces() {
    const interfaces = [];
    try {
        if(!fs.existsSync(RNS_CONFIG_PATH)) return interfaces;
        const text = fs.readFileSync(RNS_CONFIG_PATH, "utf-8");

        // split into interface sections: [[Name]]
        const sectionRe = /^\s*\[\[(.+?)\]\]\s*$/gm;
        const sections = [];
        let match;
        while((match = sectionRe.exec(text)) !== null){
            sections.push({ name: match[1].trim(), start: match.index + match[0].length });
        }

        for(let i = 0; i < sections.length; i++){
            const end = i + 1 < sections.length ? sections[i + 1].start : text.length;
            const body = text.slice(sections[i].start, end);

            // parse key = value pairs
            const kv = {};
            for(const line of body.split("\n")){
                const m = line.match(/^\s*(\w+)\s*=\s*(.+?)\s*$/);
                if(m) kv[m[1]] = m[2];
            }

            const enabled = (kv.interface_enabled ?? kv.enabled ?? "no").toLowerCase();
            if(enabled !== "yes" && enabled !== "true") continue;

            if(kv.type === "TCPClientInterface" && kv.target_host && kv.target_port){
                interfaces.push({
                    name: sections[i].name,
                    host: kv.target_host,
                    port: parseInt(kv.target_port, 10),
                });
            }
        }
    } catch(e) {
        console.log("Failed to parse ~/.reticulum/config:", e.message);
    }
    return interfaces;
}

// ------------------------------------------------------------------
// LXCF client setup
// ------------------------------------------------------------------

function initClient() {
    const identity = loadOrCreateIdentity();

    rns = new Reticulum();

    // connect to local rnsd if enabled
    if(config.useLocalRnsd){
        try {
            const localIface = new TCPClientInterface("Local rnsd", "127.0.0.1", 37428);
            rns.addInterface(localIface);
            console.log("Added interface: Local rnsd (127.0.0.1:37428)");
        } catch(e) {
            console.log("Failed to connect to local rnsd:", e.message);
        }
    }

    // add interfaces from ~/.reticulum/config (TCPClientInterface only)
    const rnsInterfaces = loadRnsInterfaces();
    for(const iface of rnsInterfaces){
        try {
            const tcpIface = new TCPClientInterface(iface.name, iface.host, iface.port);
            rns.addInterface(tcpIface);
            console.log(`Added interface (RNS config): ${iface.name} (${iface.host}:${iface.port})`);
        } catch(e) {
            console.log(`Failed to add interface ${iface.name}:`, e.message);
        }
    }

    // add interfaces from portulus.json (fallback if no RNS config)
    if(rnsInterfaces.length === 0){
        for(const iface of settings.interfaces){
            try {
                const tcpIface = new TCPClientInterface(iface.name, iface.host, iface.port);
                rns.addInterface(tcpIface);
                console.log(`Added interface (portulus): ${iface.name} (${iface.host}:${iface.port})`);
            } catch(e) {
                console.log(`Failed to add interface ${iface.name}:`, e.message);
            }
        }
    }

    const router = new LXMRouter(rns, identity);

    // announce on each interface as it connects
    for(const iface of rns.interfaces){
        if(iface.socket){
            iface.socket.on("connect", () => {
                try {
                    router.announce(resolvedNick);
                    console.log(`Announced on ${iface.name}`);
                } catch(e) {
                    console.log(`Announce on ${iface.name} failed:`, e.message);
                }
            });
        }
    }

    client = new Client({
        rns,
        identity,
        destination: router.destination,
        router,
        nick: resolvedNick,
    });

    // wire events to renderer
    client.onMessage((channel, msg) => {
        // skip own messages — renderer shows them immediately (local echo)
        if(msg.nick === client.nick) return;
        const ch = channel;
        const hashes = ch ? ch.memberHashes : {};
        const sourceHash = hashes[msg.nick];
        const suffix = sourceHash ? sourceHash.toString("hex").slice(0, 8) : null;
        send("lxcf:message", {
            cid: ch?._cid,
            nick: msg.nick,
            body: msg.body,
            timestamp: msg.timestamp,
            suffix,
        });
    });

    client.onJoin((channel, nick) => {
        if(nick === client.nick) return;
        const h = channel?.memberHashes[nick];
        send("lxcf:join", {
            cid: channel?._cid,
            nick,
            suffix: h ? h.toString("hex").slice(0, 8) : null,
        });
        sendMembers(channel);
    });

    client.onLeave((channel, nick) => {
        send("lxcf:leave", { cid: channel?._cid, nick });
        sendMembers(channel);
    });

    client.events.on("nick", (oldNick, newNick) => {
        send("lxcf:nick", { oldNick, newNick });
        // refresh members on all channels
        for(const ch of Object.values(client.channels)){
            sendMembers(ch);
        }
    });

    client.events.on("emote", (channel, msg) => {
        const h = channel?.memberHashes[msg.nick];
        send("lxcf:emote", {
            cid: channel?._cid,
            nick: msg.nick,
            body: msg.body,
            timestamp: msg.timestamp,
            suffix: h ? h.toString("hex").slice(0, 8) : null,
        });
    });

    client.events.on("topic", (channel, msg) => {
        send("lxcf:topic", {
            cid: channel?._cid,
            nick: msg.nick,
            body: msg.body,
        });
    });

    client.onPrivmsg((sourceHash, msg) => {
        const suffix = sourceHash ? sourceHash.toString("hex").slice(0, 8) : "?";
        send("lxcf:privmsg", {
            nick: msg.nick,
            body: msg.body,
            timestamp: msg.timestamp,
            suffix,
        });
    });

    // send initial state to renderer
    setTimeout(() => {
        const addr = client.address;
        const suffix = addr ? addr.slice(0, 8) : "";
        send("lxcf:init", {
            nick: client.nick,
            address: addr,
            suffix,
            bookmarks,
        });
    }, 500);
}

function sendMembers(channel) {
    if(!channel) return;
    const members = [];
    for(const nick of Object.keys(channel.members)){
        const h = channel.memberHashes[nick];
        members.push({
            nick,
            suffix: h ? h.toString("hex").slice(0, 8) : null,
            isSelf: nick === client.nick,
        });
    }
    send("lxcf:members", { cid: channel._cid, members });
}

// ------------------------------------------------------------------
// IPC handlers
// ------------------------------------------------------------------

function setupIPC() {

    ipcMain.handle("join", (event, channelName, subnet) => {
        try {
            const key = subnet ? crypto.createHash("sha256").update(subnet).digest() : null;
            const ch = client.join(channelName, { key, announce });
            sendMembers(ch);
            const dest = ch.destination;
            return {
                cid: ch._cid,
                name: ch.name,
                subnet: subnet || null,
                destHash: dest ? dest.hash.toString("hex") : null,
            };
        } catch(e) {
            console.error("join failed:", e);
            throw e;
        }
    });

    ipcMain.handle("leave", (event, cid) => {
        client.leave(cid, announce);
        return { ok: true };
    });

    ipcMain.handle("send", (event, cid, body) => {
        const ch = client.channels[cid];
        if(!ch) return { ok: false };
        ch.send(body);
        return { ok: true };
    });

    ipcMain.handle("emote", (event, cid, body) => {
        const ch = client.channels[cid];
        if(!ch) return { ok: false };
        ch.emote(body);
        return { ok: true };
    });

    ipcMain.handle("set-topic", (event, cid, topic) => {
        const ch = client.channels[cid];
        if(!ch) return { ok: false };
        ch.setTopic(topic);
        return { ok: true };
    });

    ipcMain.handle("change-nick", (event, newNick) => {
        client.changeNick(newNick, announce);
        return { nick: client.nick };
    });

    ipcMain.handle("privmsg", (event, destHash, body) => {
        client.privmsg(destHash, body);
        return { ok: true };
    });

    ipcMain.handle("get-bookmarks", () => {
        return bookmarks;
    });

    ipcMain.handle("toggle-bookmark", (event, channelName, subnet) => {
        const idx = bookmarks.findIndex(b => b.name === channelName && (b.subnet ?? null) === (subnet ?? null));
        if(idx >= 0){
            bookmarks.splice(idx, 1);
        } else {
            const entry = { name: channelName };
            if(subnet) entry.subnet = subnet;
            bookmarks.push(entry);
        }
        saveBookmarks(bookmarks);
        return bookmarks;
    });

    ipcMain.handle("get-settings", () => {
        return settings;
    });

    ipcMain.handle("save-settings", (event, newSettings) => {
        settings = { ...settings, ...newSettings };
        saveSettings(settings);
        return settings;
    });

    ipcMain.handle("quit", () => {
        if(client){
            for(const cid of Object.keys(client.channels)){
                client.leave(cid, announce);
            }
        }
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
    initClient();
});

app.on("window-all-closed", () => {
    app.quit();
});
