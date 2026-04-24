/**
 * Bridge manager — testable module for NDJSON communication
 * with a Python bridge child process (LXCF or RRC).
 *
 * Extracted from main.js so it can be tested without Electron.
 */

/**
 * Create a bridge manager instance.
 *
 * @param {object} opts
 * @param {function} opts.send - Function to send IPC events to the renderer: send(channel, data)
 * @param {string} [opts.eventPrefix="lxcf"] - Protocol prefix for IPC event channels
 * @returns {object} Bridge manager API
 */
export function createBridgeManager({ send, eventPrefix = "lxcf" }) {
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
                send(`${eventPrefix}:init`, {
                    nick: msg.nick,
                    address: msg.address,
                    suffix: msg.suffix,
                    hubs: msg.hubs || { hubs: {} },
                });
                break;
            case "message":
                send(`${eventPrefix}:message`, msg);
                break;
            case "join":
                send(`${eventPrefix}:join`, msg);
                break;
            case "leave":
                send(`${eventPrefix}:leave`, msg);
                break;
            case "nick":
                send(`${eventPrefix}:nick`, {
                    oldNick: msg.old_nick,
                    newNick: msg.new_nick,
                });
                break;
            case "emote":
                send(`${eventPrefix}:emote`, msg);
                break;
            case "topic":
                send(`${eventPrefix}:topic`, msg);
                break;
            case "privmsg":
                send(`${eventPrefix}:privmsg`, msg);
                break;
            case "members":
                send(`${eventPrefix}:members`, msg);
                break;
            // RRC-specific events
            case "connected":
                send(`${eventPrefix}:connected`, msg);
                break;
            case "disconnected":
                send(`${eventPrefix}:disconnected`, msg);
                break;
            case "joined":
                send(`${eventPrefix}:joined`, msg);
                break;
            case "parted":
                send(`${eventPrefix}:parted`, msg);
                break;
            case "notice":
                send(`${eventPrefix}:notice`, msg);
                break;
            case "error":
                send(`${eventPrefix}:error`, msg);
                break;
            case "hub_discovered":
                send(`${eventPrefix}:hub_discovered`, msg);
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
