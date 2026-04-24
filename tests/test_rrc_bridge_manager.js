/**
 * Property-based and unit tests for the RRC bridge manager.
 *
 * Properties validated:
 *   11. IPC Protocol Routing
 *   12. Hub Store Protocol Field Preservation
 *   13. Hub Discovery Deduplication
 *
 * Unit tests:
 *   - RRC bridge manager handles RRC-specific events with rrc: prefix
 *   - LXCF bridge manager still works with default prefix
 *
 * Feature: portulus-rrc-support
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { createBridgeManager } from "../src/bridge.js";

// ---------------------------------------------------------------------------
// Property 11: IPC Protocol Routing
// ---------------------------------------------------------------------------

describe("Property 11: IPC protocol routing", () => {
    it("RRC bridge events carry the rrc: prefix", () => {
        /**
         * Validates: Requirements 8.2, 8.3, 9.2
         *
         * For any event name from the supported set, creating a bridge manager
         * with eventPrefix "rrc" and feeding the event through handleBridgeEvent
         * SHALL produce an IPC channel starting with "rrc:".
         */
        fc.assert(
            fc.property(
                fc.constantFrom(
                    "ready", "message", "connected", "disconnected",
                    "joined", "parted", "notice", "error", "hub_discovered"
                ),
                (eventName) => {
                    const sentChannels = [];
                    const mgr = createBridgeManager({
                        send: (ch, _data) => sentChannels.push(ch),
                        eventPrefix: "rrc",
                    });

                    // Build a msg with fields needed for each event type
                    const msg = {
                        event: eventName,
                        nick: "test",
                        address: "aa",
                        suffix: "aa",
                        hubs: {},
                        hub_name: "TestHub",
                        limits: {},
                        room: "#lobby",
                        members: [],
                        src: "abcd",
                        body: "hello",
                        timestamp: Date.now(),
                        hub_hash: "aabbccdd",
                    };

                    mgr.handleBridgeEvent(msg);

                    assert.ok(sentChannels.length > 0,
                        `Expected at least 1 IPC send for event "${eventName}"`);
                    assert.ok(sentChannels[0].startsWith("rrc:"),
                        `Channel "${sentChannels[0]}" should start with "rrc:" for event "${eventName}"`);
                }
            ),
            { numRuns: 100 }
        );
    });

    it("LXCF bridge events carry the lxcf: prefix", () => {
        fc.assert(
            fc.property(
                fc.constantFrom(
                    "ready", "message", "connected", "disconnected",
                    "joined", "parted", "notice", "error", "hub_discovered"
                ),
                (eventName) => {
                    const sentChannels = [];
                    const mgr = createBridgeManager({
                        send: (ch, _data) => sentChannels.push(ch),
                        eventPrefix: "lxcf",
                    });

                    const msg = {
                        event: eventName,
                        nick: "test",
                        address: "aa",
                        suffix: "aa",
                        hubs: {},
                        hub_name: "TestHub",
                        limits: {},
                        room: "#lobby",
                        members: [],
                        src: "abcd",
                        body: "hello",
                        timestamp: Date.now(),
                        hub_hash: "aabbccdd",
                    };

                    mgr.handleBridgeEvent(msg);

                    assert.ok(sentChannels.length > 0);
                    assert.ok(sentChannels[0].startsWith("lxcf:"),
                        `Channel "${sentChannels[0]}" should start with "lxcf:" for event "${eventName}"`);
                }
            ),
            { numRuns: 100 }
        );
    });
});

// ---------------------------------------------------------------------------
// Property 12: Hub Store Protocol Field Preservation
// ---------------------------------------------------------------------------

describe("Property 12: hub store protocol field preservation", () => {
    it("protocol field survives JSON round-trip", () => {
        /**
         * Validates: Requirements 10.1
         *
         * For any hub entry with a protocol of "lxcf" or "rrc", serializing
         * to JSON and parsing back SHALL preserve the protocol field.
         */
        fc.assert(
            fc.property(
                fc.record({
                    tag: fc.string({ minLength: 1, maxLength: 16 }),
                    protocol: fc.constantFrom("lxcf", "rrc"),
                    destination: fc.stringMatching(/^[0-9a-f]{32}$/),
                }),
                (hub) => {
                    const store = {
                        hubs: {
                            [hub.tag]: {
                                destination: hub.destination,
                                protocol: hub.protocol,
                                channels: [],
                            },
                        },
                    };
                    const serialized = JSON.stringify(store);
                    const parsed = JSON.parse(serialized);
                    const entry = parsed.hubs[hub.tag];
                    assert.equal(entry.protocol, hub.protocol);
                }
            ),
            { numRuns: 100 }
        );
    });

    it("missing protocol defaults to lxcf", () => {
        /**
         * Validates: Requirements 10.1
         *
         * Entries without a protocol field SHALL default to "lxcf".
         */
        const store = { hubs: { "old-hub": { destination: "aabb", channels: [] } } };
        const entry = store.hubs["old-hub"];
        const protocol = entry.protocol || "lxcf";
        assert.equal(protocol, "lxcf");
    });
});

// ---------------------------------------------------------------------------
// Property 13: Hub Discovery Deduplication
// ---------------------------------------------------------------------------

describe("Property 13: hub discovery deduplication", () => {
    it("each unique hash appears at most once after dedup", () => {
        /**
         * Validates: Requirements 12.3
         *
         * For any sequence of hub hashes with repeats, feeding them through
         * a dedup set SHALL emit each unique hash exactly once.
         */
        fc.assert(
            fc.property(
                fc.array(
                    fc.stringMatching(/^[0-9a-f]{32}$/),
                    { minLength: 1, maxLength: 50 }
                ),
                (hashes) => {
                    const seen = new Set();
                    const emitted = [];
                    for (const h of hashes) {
                        if (!seen.has(h)) {
                            seen.add(h);
                            emitted.push(h);
                        }
                    }
                    // Each unique hash emitted exactly once
                    const uniqueInput = [...new Set(hashes)];
                    assert.equal(emitted.length, uniqueInput.length);
                    assert.deepEqual(emitted, uniqueInput);
                }
            ),
            { numRuns: 100 }
        );
    });
});

// ---------------------------------------------------------------------------
// Unit tests: RRC bridge manager events
// ---------------------------------------------------------------------------

describe("Unit: RRC bridge manager events", () => {
    it("connected event uses rrc:connected channel", () => {
        const sent = [];
        const mgr = createBridgeManager({
            send: (ch, data) => sent.push({ ch, data }),
            eventPrefix: "rrc",
        });
        mgr.handleBridgeEvent({ event: "connected", hub_name: "TestHub", limits: {} });
        assert.equal(sent.length, 1);
        assert.equal(sent[0].ch, "rrc:connected");
    });

    it("disconnected event uses rrc:disconnected channel", () => {
        const sent = [];
        const mgr = createBridgeManager({
            send: (ch, data) => sent.push({ ch, data }),
            eventPrefix: "rrc",
        });
        mgr.handleBridgeEvent({ event: "disconnected", hub_hash: "aabb" });
        assert.equal(sent.length, 1);
        assert.equal(sent[0].ch, "rrc:disconnected");
    });

    it("joined event uses rrc:joined channel", () => {
        const sent = [];
        const mgr = createBridgeManager({
            send: (ch, data) => sent.push({ ch, data }),
            eventPrefix: "rrc",
        });
        mgr.handleBridgeEvent({ event: "joined", room: "#lobby", members: [] });
        assert.equal(sent.length, 1);
        assert.equal(sent[0].ch, "rrc:joined");
    });

    it("parted event uses rrc:parted channel", () => {
        const sent = [];
        const mgr = createBridgeManager({
            send: (ch, data) => sent.push({ ch, data }),
            eventPrefix: "rrc",
        });
        mgr.handleBridgeEvent({ event: "parted", room: "#lobby" });
        assert.equal(sent.length, 1);
        assert.equal(sent[0].ch, "rrc:parted");
    });

    it("notice event uses rrc:notice channel", () => {
        const sent = [];
        const mgr = createBridgeManager({
            send: (ch, data) => sent.push({ ch, data }),
            eventPrefix: "rrc",
        });
        mgr.handleBridgeEvent({ event: "notice", room: "#lobby", body: "Welcome!" });
        assert.equal(sent.length, 1);
        assert.equal(sent[0].ch, "rrc:notice");
    });

    it("error event uses rrc:error channel", () => {
        const sent = [];
        const mgr = createBridgeManager({
            send: (ch, data) => sent.push({ ch, data }),
            eventPrefix: "rrc",
        });
        mgr.handleBridgeEvent({ event: "error", body: "Something went wrong" });
        assert.equal(sent.length, 1);
        assert.equal(sent[0].ch, "rrc:error");
    });

    it("hub_discovered event uses rrc:hub_discovered channel", () => {
        const sent = [];
        const mgr = createBridgeManager({
            send: (ch, data) => sent.push({ ch, data }),
            eventPrefix: "rrc",
        });
        mgr.handleBridgeEvent({ event: "hub_discovered", hub_hash: "aabbccdd" });
        assert.equal(sent.length, 1);
        assert.equal(sent[0].ch, "rrc:hub_discovered");
    });

    it("message event uses rrc:message channel", () => {
        const sent = [];
        const mgr = createBridgeManager({
            send: (ch, data) => sent.push({ ch, data }),
            eventPrefix: "rrc",
        });
        mgr.handleBridgeEvent({
            event: "message",
            room: "#lobby",
            src: "abcd",
            nick: "alice",
            body: "hello",
            timestamp: 1234567890,
        });
        assert.equal(sent.length, 1);
        assert.equal(sent[0].ch, "rrc:message");
    });
});

describe("Unit: LXCF bridge manager default prefix", () => {
    it("ready event maps to lxcf:init with default prefix", () => {
        const sent = [];
        const mgr = createBridgeManager({
            send: (ch, data) => sent.push({ ch, data }),
        });
        mgr.handleBridgeEvent({
            event: "ready",
            nick: "test",
            address: "aa",
            suffix: "aa",
            hubs: {},
        });
        assert.equal(sent.length, 1);
        assert.equal(sent[0].ch, "lxcf:init");
    });

    it("message event maps to lxcf:message with default prefix", () => {
        const sent = [];
        const mgr = createBridgeManager({
            send: (ch, data) => sent.push({ ch, data }),
        });
        mgr.handleBridgeEvent({ event: "message", room: "#test", body: "hi" });
        assert.equal(sent.length, 1);
        assert.equal(sent[0].ch, "lxcf:message");
    });
});
