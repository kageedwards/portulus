/**
 * Portulus preload — exposes a safe IPC bridge to the renderer.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("portulus", {

    // commands
    join: (channelName, subnet) => ipcRenderer.invoke("join", channelName, subnet),
    leave: (cid) => ipcRenderer.invoke("leave", cid),
    send: (cid, body) => ipcRenderer.invoke("send", cid, body),
    emote: (cid, body) => ipcRenderer.invoke("emote", cid, body),
    setTopic: (cid, topic) => ipcRenderer.invoke("set-topic", cid, topic),
    changeNick: (newNick) => ipcRenderer.invoke("change-nick", newNick),
    privmsg: (destHash, body) => ipcRenderer.invoke("privmsg", destHash, body),
    getBookmarks: () => ipcRenderer.invoke("get-bookmarks"),
    toggleBookmark: (name, subnet) => ipcRenderer.invoke("toggle-bookmark", name, subnet),
    getSettings: () => ipcRenderer.invoke("get-settings"),
    saveSettings: (s) => ipcRenderer.invoke("save-settings", s),
    quit: () => ipcRenderer.invoke("quit"),

    // events from main
    on: (channel, callback) => {
        const listener = (event, ...args) => callback(...args);
        ipcRenderer.on(channel, listener);
        return () => ipcRenderer.removeListener(channel, listener);
    },

});
