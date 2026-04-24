/**
 * Portulus preload — exposes a safe IPC bridge to the renderer.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("portulus", {

    // commands
    join: (channelName, hub, key) => ipcRenderer.invoke("join", channelName, hub, key),
    leave: (cid) => ipcRenderer.invoke("leave", cid),
    send: (cid, body) => ipcRenderer.invoke("send", cid, body),
    emote: (cid, body) => ipcRenderer.invoke("emote", cid, body),
    setTopic: (cid, topic) => ipcRenderer.invoke("set-topic", cid, topic),
    changeNick: (newNick) => ipcRenderer.invoke("change-nick", newNick),
    privmsg: (destHash, body) => ipcRenderer.invoke("privmsg", destHash, body),
    getHubs: () => ipcRenderer.invoke("get-hubs"),
    saveHub: (tag, dest) => ipcRenderer.invoke("save-hub", tag, dest),
    deleteHub: (tag) => ipcRenderer.invoke("delete-hub", tag),
    toggleBookmark: (name, hub, key) => ipcRenderer.invoke("toggle-bookmark", name, hub, key),
    getSettings: () => ipcRenderer.invoke("get-settings"),
    saveSettings: (s) => ipcRenderer.invoke("save-settings", s),
    quit: () => ipcRenderer.invoke("quit"),

    // RRC commands
    rrcConnectHub: (hubHash) => ipcRenderer.invoke("rrc-connect-hub", hubHash),
    rrcDisconnectHub: (hubHash) => ipcRenderer.invoke("rrc-disconnect-hub", hubHash),
    rrcJoin: (room) => ipcRenderer.invoke("rrc-join", room),
    rrcLeave: (room) => ipcRenderer.invoke("rrc-leave", room),
    rrcSend: (room, body) => ipcRenderer.invoke("rrc-send", room, body),
    rrcChangeNick: (nick) => ipcRenderer.invoke("rrc-change-nick", nick),
    rrcDiscoverHubs: () => ipcRenderer.invoke("rrc-discover-hubs"),
    rrcSaveHub: (tag, dest) => ipcRenderer.invoke("rrc-save-hub", tag, dest),
    rrcDeleteHub: (tag) => ipcRenderer.invoke("rrc-delete-hub", tag),

    // events from main
    on: (channel, callback) => {
        const listener = (event, ...args) => callback(...args);
        ipcRenderer.on(channel, listener);
        return () => ipcRenderer.removeListener(channel, listener);
    },

});
