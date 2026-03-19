/**
 * Bridge manager — testable module for NDJSON communication
 * with the Python lxcf_bridge child process.
 *
 * Extracted from main.js so it can be tested without Electron.
 */

/**
 * Create a bridge manager instance.
 *
 * @param {object} opts
 * @param {function} opts.send - Function to send IPC events to the renderer: send(channel, data)
 * @param {function} opts.getBookmarks - Function returning current bookmarks array
 * @returns {object} Bridge manager API
 */
export function createBridgeManager({ send }) {
    let reqCounter = 0;
    const pending = {};
    let stdinWrite = null;  // function to write to bridge stdin

    function bridgeRequest(action, data) {
        return new Promise((resolve, reject) => {
            const id = String(++reqCounter);
            const cmd = { action, id, ...data };

            const timer = setTimeout(() => {
                delete pending[id];
                reject(new Error(`Bridge request "${action}" timed out (id=${id})`));
            }, 10000);

            pending[id] = { resolve, reject, timer };

            if(stdinWrite){
                stdinWrite(JSON.stringify(cmd) + "\n");
            } else {
                clearTimeout(timer);
                delete pending[id];
                reject(new Error("Bridge process not running"));
            }
        });
    }

    function bridgeSend(action, data) {
        if(stdinWrite){
            const cmd = { action, ...data };
            stdinWrite(JSON.stringify(cmd) + "\n");
        }
    }

    function handleBridgeEvent(msg) {
        switch(msg.event){
            case "ready":
                send("lxcf:init", {
                    nick: msg.nick,
                    address: msg.address,
                    suffix: msg.suffix,
                    hubs: msg.hubs || { hubs: {} },
                });
                break;
            case "message":
                send("lxcf:message", msg);
                break;
            case "join":
                send("lxcf:join", msg);
                break;
            case "leave":
                send("lxcf:leave", msg);
                break;
            case "nick":
                send("lxcf:nick", {
                    oldNick: msg.old_nick,
                    newNick: msg.new_nick,
                });
                break;
            case "emote":
                send("lxcf:emote", msg);
                break;
            case "topic":
                send("lxcf:topic", msg);
                break;
            case "privmsg":
                send("lxcf:privmsg", msg);
                break;
            case "members":
                send("lxcf:members", msg);
                break;
        }
    }

    function handleLine(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        } catch(e) {
            // Invalid JSON — log and discard
            return { type: "invalid", raw: line };
        }

        if(msg.response !== undefined){
            const entry = pending[msg.response];
            if(entry){
                clearTimeout(entry.timer);
                delete pending[msg.response];
                entry.resolve(msg);
            }
            return { type: "response", msg };
        } else if(msg.event !== undefined){
            handleBridgeEvent(msg);
            return { type: "event", msg };
        }
        return { type: "unknown", msg };
    }

    function setStdinWrite(fn) {
        stdinWrite = fn;
    }

    return {
        bridgeRequest,
        bridgeSend,
        handleBridgeEvent,
        handleLine,
        setStdinWrite,
        // Expose for testing
        get pending() { return pending; },
        get reqCounter() { return reqCounter; },
    };
}
