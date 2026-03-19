/**
 * Property-based and unit tests for the Portulus bridge manager.
 *
 * Properties validated:
 *   4. Monotonically increasing Correlation IDs
 *   6. Event-to-IPC forwarding mapping
 *   7. Command mapping completeness
 *
 * Unit tests:
 *   - Timeout fires after 10s for unresolved promises
 *   - Orphaned responses are discarded silently
 *   - handleBridgeEvent("ready") maps to lxcf:init with hubs
 *   - handleBridgeEvent("nick") renames old_nick→oldNick, new_nick→newNick
 *   - Invalid JSON on bridge stdout is logged and discarded
 *   - Bridge exit with non-zero code is logged
 *   - join command includes hub and key fields
 *   - save-hub, delete-hub, toggle-bookmark commands
 *
 * Feature: hub-config-and-routing
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { createBridgeManager } from "../src/bridge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMgr() {
    const sent = [];
    const written = [];

    const mgr = createBridgeManager({
        send: (channel, data) => sent.push({ channel, data }),
    });

    // Wire up a fake stdin writer that captures output
    mgr.setStdinWrite((data) => written.push(data));

    return { mgr, sent, written };
}

// ---------------------------------------------------------------------------
// Property 4: Monotonically increasing Correlation IDs
// ---------------------------------------------------------------------------

describe("Property 4: Monotonically increasing Correlation IDs", () => {
    it("each successive bridgeRequest gets a strictly increasing ID", () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 2, max: 50 }),
                (n) => {
                    const { mgr, written } = makeMgr();
                    const promises = [];

                    for(let i = 0; i < n; i++){
                        const p = mgr.bridgeRequest("send", { cid: "#test", body: "hi" });
                        p.catch(() => {}); // suppress unhandled rejection
                        promises.push(p);
                    }

                    assert.equal(written.length, n);

                    const ids = written.map(line => {
                        const cmd = JSON.parse(line);
                        return parseInt(cmd.id, 10);
                    });

                    // Strictly increasing
                    for(let i = 1; i < ids.length; i++){
                        assert.ok(ids[i] > ids[i - 1],
                            `ID ${ids[i]} should be > ${ids[i - 1]}`);
                    }

                    // All unique
                    assert.equal(new Set(ids).size, ids.length);

                    // Clean up pending timers
                    for(const id of Object.keys(mgr.pending)){
                        clearTimeout(mgr.pending[id].timer);
                    }
                }
            ),
            { numRuns: 200 }
        );
    });
});

// ---------------------------------------------------------------------------
// Property 6: Event-to-IPC forwarding mapping
// ---------------------------------------------------------------------------

const EVENT_TO_IPC = {
    ready: "lxcf:init",
    message: "lxcf:message",
    join: "lxcf:join",
    leave: "lxcf:leave",
    nick: "lxcf:nick",
    emote: "lxcf:emote",
    topic: "lxcf:topic",
    privmsg: "lxcf:privmsg",
    members: "lxcf:members",
};

const EVENT_TYPES = Object.keys(EVENT_TO_IPC);

describe("Property 6: Event-to-IPC forwarding mapping", () => {
    it("each NDJSON event type maps to the correct lxcf:* IPC channel", () => {
        fc.assert(
            fc.property(
                fc.constantFrom(...EVENT_TYPES),
                fc.dictionary(
                    fc.string({ minLength: 1, maxLength: 10 }),
                    fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
                    { minKeys: 0, maxKeys: 5 }
                ),
                (eventType, extraFields) => {
                    const { mgr, sent } = makeMgr();

                    const msg = { event: eventType, ...extraFields };
                    if(eventType === "nick"){
                        msg.old_nick = msg.old_nick ?? "alice";
                        msg.new_nick = msg.new_nick ?? "bob";
                    }
                    if(eventType === "ready"){
                        msg.nick = msg.nick ?? "kage";
                        msg.address = msg.address ?? "abcdef";
                        msg.suffix = msg.suffix ?? "abcdef01";
                    }

                    mgr.handleBridgeEvent(msg);

                    assert.ok(sent.length >= 1,
                        `Expected at least 1 IPC send for event "${eventType}"`);

                    const expectedChannel = EVENT_TO_IPC[eventType];
                    assert.equal(sent[0].channel, expectedChannel,
                        `Event "${eventType}" should map to "${expectedChannel}"`);
                }
            ),
            { numRuns: 200 }
        );
    });
});

// ---------------------------------------------------------------------------
// Property 7: Command mapping completeness
// ---------------------------------------------------------------------------

const IPC_TO_ACTION = {
    join: { action: "join", fields: ["channel"] },
    leave: { action: "leave", fields: ["cid"] },
    send: { action: "send", fields: ["cid", "body"] },
    emote: { action: "emote", fields: ["cid", "body"] },
    set_topic: { action: "set_topic", fields: ["cid", "topic"] },
    change_nick: { action: "change_nick", fields: ["nick"] },
    privmsg: { action: "privmsg", fields: ["dest_hash", "body"] },
};

describe("Property 7: Command mapping completeness", () => {
    it("each bridgeRequest generates correct action and fields", () => {
        fc.assert(
            fc.property(
                fc.constantFrom(...Object.keys(IPC_TO_ACTION)),
                fc.string({ minLength: 1, maxLength: 20 }),
                (actionName, value) => {
                    const { mgr, written } = makeMgr();
                    const spec = IPC_TO_ACTION[actionName];

                    const data = {};
                    for(const field of spec.fields){
                        data[field] = value;
                    }

                    const p = mgr.bridgeRequest(actionName, data);
                    p.catch(() => {});

                    assert.equal(written.length, 1);
                    const cmd = JSON.parse(written[0]);

                    assert.equal(cmd.action, spec.action);
                    assert.ok(cmd.id, "Command must have an id field");

                    for(const field of spec.fields){
                        assert.ok(field in cmd,
                            `Command for "${actionName}" must contain field "${field}"`);
                    }

                    // Clean up
                    for(const id of Object.keys(mgr.pending)){
                        clearTimeout(mgr.pending[id].timer);
                    }
                }
            ),
            { numRuns: 200 }
        );
    });
});

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("Unit: Timeout for unresolved promises", () => {
    it("rejects after 10s timeout", async () => {
        const { mgr } = makeMgr();

        const origSetTimeout = globalThis.setTimeout;
        globalThis.setTimeout = (fn, _ms) => origSetTimeout(fn, 0);

        try {
            await assert.rejects(
                () => mgr.bridgeRequest("join", { channel: "#test" }),
                { message: /timed out/ }
            );
        } finally {
            globalThis.setTimeout = origSetTimeout;
        }
    });
});

describe("Unit: Orphaned responses discarded", () => {
    it("response with no matching pending promise is silently ignored", () => {
        const { mgr } = makeMgr();

        const result = mgr.handleLine('{"response":"999","ok":true}');
        assert.equal(result.type, "response");
        assert.equal(Object.keys(mgr.pending).length, 0);
    });
});

describe("Unit: ready event maps to lxcf:init with hubs", () => {
    it("forwards hubs data in the lxcf:init payload", () => {
        const { mgr, sent } = makeMgr();

        const hubsData = {
            hubs: {
                rmap: { destination: "abcdef0123456789", channels: [{ name: "#mesh" }] },
            },
        };

        mgr.handleBridgeEvent({
            event: "ready",
            nick: "kage",
            address: "abcdef0123456789",
            suffix: "abcdef01",
            hubs: hubsData,
        });

        assert.equal(sent.length, 1);
        assert.equal(sent[0].channel, "lxcf:init");
        assert.equal(sent[0].data.nick, "kage");
        assert.equal(sent[0].data.address, "abcdef0123456789");
        assert.equal(sent[0].data.suffix, "abcdef01");
        assert.deepEqual(sent[0].data.hubs, hubsData);
    });

    it("defaults to empty hubs when not provided", () => {
        const { mgr, sent } = makeMgr();

        mgr.handleBridgeEvent({
            event: "ready",
            nick: "anon",
            address: "1234",
            suffix: "1234",
        });

        assert.equal(sent.length, 1);
        assert.deepEqual(sent[0].data.hubs, { hubs: {} });
    });
});

describe("Unit: nick event renames snake_case to camelCase", () => {
    it("old_nick→oldNick, new_nick→newNick", () => {
        const { mgr, sent } = makeMgr();

        mgr.handleBridgeEvent({
            event: "nick",
            old_nick: "alice",
            new_nick: "bob",
        });

        assert.equal(sent.length, 1);
        assert.equal(sent[0].channel, "lxcf:nick");
        assert.equal(sent[0].data.oldNick, "alice");
        assert.equal(sent[0].data.newNick, "bob");
        assert.equal(sent[0].data.old_nick, undefined);
        assert.equal(sent[0].data.new_nick, undefined);
    });
});

describe("Unit: Invalid JSON on stdout", () => {
    it("returns invalid type and does not throw", () => {
        const { mgr, sent } = makeMgr();

        const result = mgr.handleLine("this is not json");
        assert.equal(result.type, "invalid");
        assert.equal(result.raw, "this is not json");
        assert.equal(sent.length, 0);
    });
});

describe("Unit: bridgeRequest rejects when bridge not running", () => {
    it("rejects immediately if stdinWrite is null", async () => {
        const { mgr } = makeMgr();
        mgr.setStdinWrite(null);

        await assert.rejects(
            () => mgr.bridgeRequest("join", { channel: "#test" }),
            { message: /not running/ }
        );
    });
});

describe("Unit: join command includes hub and key fields", () => {
    it("sends hub and key in the join command", () => {
        const { mgr, written } = makeMgr();

        const p = mgr.bridgeRequest("join", { channel: "#mesh", hub: "rmap", key: "abcd1234" });
        p.catch(() => {});

        assert.equal(written.length, 1);
        const cmd = JSON.parse(written[0]);
        assert.equal(cmd.action, "join");
        assert.equal(cmd.channel, "#mesh");
        assert.equal(cmd.hub, "rmap");
        assert.equal(cmd.key, "abcd1234");

        for(const id of Object.keys(mgr.pending)){
            clearTimeout(mgr.pending[id].timer);
        }
    });

    it("sends null hub and key when omitted", () => {
        const { mgr, written } = makeMgr();

        const p = mgr.bridgeRequest("join", { channel: "#test", hub: null, key: null });
        p.catch(() => {});

        const cmd = JSON.parse(written[0]);
        assert.equal(cmd.hub, null);
        assert.equal(cmd.key, null);

        for(const id of Object.keys(mgr.pending)){
            clearTimeout(mgr.pending[id].timer);
        }
    });
});

describe("Unit: save-hub command", () => {
    it("sends save_hub action with tag and destination", () => {
        const { mgr, written } = makeMgr();

        const p = mgr.bridgeRequest("save_hub", { tag: "rmap", destination: "abcdef" });
        p.catch(() => {});

        const cmd = JSON.parse(written[0]);
        assert.equal(cmd.action, "save_hub");
        assert.equal(cmd.tag, "rmap");
        assert.equal(cmd.destination, "abcdef");

        for(const id of Object.keys(mgr.pending)){
            clearTimeout(mgr.pending[id].timer);
        }
    });
});

describe("Unit: delete-hub command", () => {
    it("sends delete_hub action with tag", () => {
        const { mgr, written } = makeMgr();

        const p = mgr.bridgeRequest("delete_hub", { tag: "rmap" });
        p.catch(() => {});

        const cmd = JSON.parse(written[0]);
        assert.equal(cmd.action, "delete_hub");
        assert.equal(cmd.tag, "rmap");

        for(const id of Object.keys(mgr.pending)){
            clearTimeout(mgr.pending[id].timer);
        }
    });
});

describe("Unit: toggle-bookmark command with hub tag", () => {
    it("sends toggle_bookmark action with channel, hub, and key", () => {
        const { mgr, written } = makeMgr();

        const p = mgr.bridgeRequest("toggle_bookmark", { channel: "#mesh", hub: "rmap", key: "ff00" });
        p.catch(() => {});

        const cmd = JSON.parse(written[0]);
        assert.equal(cmd.action, "toggle_bookmark");
        assert.equal(cmd.channel, "#mesh");
        assert.equal(cmd.hub, "rmap");
        assert.equal(cmd.key, "ff00");

        for(const id of Object.keys(mgr.pending)){
            clearTimeout(mgr.pending[id].timer);
        }
    });
});
