#!/usr/bin/env python3
"""
rrc_bridge — NDJSON stdio bridge for Portulus (RRC protocol).

Reads commands from stdin, drives an rrc_tui.Client,
writes events/responses to stdout.
Stderr is reserved for logging.

RRC hub bookmarks are stored in ~/.portulus/bookmarks.json,
separate from LXCF's bookmarks.

Protocol:
    - Commands arrive on stdin as single-line JSON with an "action" field.
    - Responses go to stdout as single-line JSON with a "response" field.
    - Events go to stdout as single-line JSON with an "event" field.
    - All stdout lines are compact JSON (no embedded newlines).
    - stderr is used for Python logging output only.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
import traceback

from rrc_tui.client import Client, ClientConfig, MessageTooLargeError

log = logging.getLogger("rrc_bridge")

PORTULUS_DIR = os.path.expanduser("~/.portulus")
BOOKMARKS_PATH = os.path.join(PORTULUS_DIR, "bookmarks.json")


# ------------------------------------------------------------------
# Self-contained bookmark I/O (no lxcf.hub_config dependency)
# ------------------------------------------------------------------

def _load_bookmarks() -> dict:
    """Load ~/.portulus/bookmarks.json. Returns {"hubs": {}} on missing/corrupt."""
    try:
        if os.path.isfile(BOOKMARKS_PATH):
            with open(BOOKMARKS_PATH, "r") as f:
                data = json.load(f)
            if isinstance(data, dict) and "hubs" in data:
                return data
    except Exception:
        pass
    return {"hubs": {}}


def _save_bookmarks(data: dict) -> None:
    """Write ~/.portulus/bookmarks.json."""
    os.makedirs(PORTULUS_DIR, exist_ok=True)
    with open(BOOKMARKS_PATH, "w") as f:
        json.dump(data, f, indent=2)


class RrcBridge:
    """
    NDJSON stdio bridge for Portulus (RRC protocol).

    Reads commands from stdin, drives an rrc_tui.Client,
    writes events/responses to stdout.
    Stderr is reserved for logging.
    """

    def __init__(self):
        self.client: Client | None = None
        self._lock = threading.Lock()
        self._hubs_data: dict = {"hubs": {}}
        self._session_state: str = "disconnected"
        self._hub_limits: dict = {}
        self._nickname: str | None = None
        self._discovered_hubs: set = set()

    # ------------------------------------------------------------------
    # Thread-safe stdout writers
    # ------------------------------------------------------------------

    def write_event(self, obj: dict) -> None:
        line = json.dumps(obj, separators=(",", ":"))
        with self._lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def write_response(self, req_id: str, data: dict) -> None:
        data["response"] = req_id
        line = json.dumps(data, separators=(",", ":"))
        with self._lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    # ------------------------------------------------------------------
    # Action handlers
    # ------------------------------------------------------------------

    def handle_init(self, msg: dict) -> None:
        import RNS

        nick = msg.get("nick", "anon")
        rns_config_dir = msg.get("rns_config_dir")
        if rns_config_dir:
            rns_config_dir = os.path.expanduser(rns_config_dir)

        # Identity lives in ~/.lxcf/ (shared with LXCF bridge)
        identity_dir = os.path.expanduser("~/.lxcf")
        identity_path = os.path.join(identity_dir, "identity")

        RNS.Reticulum(configdir=rns_config_dir)

        os.makedirs(identity_dir, exist_ok=True)
        if os.path.exists(identity_path):
            identity = RNS.Identity.from_file(identity_path)
            if identity is None:
                identity = RNS.Identity()
                identity.to_file(identity_path)
        else:
            identity = RNS.Identity()
            identity.to_file(identity_path)

        self._nickname = nick
        self.client = Client(identity, config=None, nickname=nick)

        self.client.on_welcome = self._on_welcome
        self.client.on_message = self._on_message
        self.client.on_notice = self._on_notice
        self.client.on_error = self._on_error
        self.client.on_joined = self._on_joined
        self.client.on_parted = self._on_parted
        self.client.on_close = self._on_close
        self.client.on_pong = self._on_pong

        self._hubs_data = _load_bookmarks()

        address = identity.hash.hex()
        self.write_event({
            "event": "ready",
            "nick": nick,
            "address": address,
            "suffix": address[:8],
            "hubs": self._hubs_data,
        })

    def handle_connect_hub(self, msg: dict) -> dict:
        hub_hash_hex = msg.get("hub_hash", "")
        dest_name = msg.get("dest_name") or None
        try:
            hub_hash_bytes = bytes.fromhex(hub_hash_hex)
        except ValueError:
            return {"ok": False, "error": f"Invalid hub hash: {hub_hash_hex}"}

        if self.client is None:
            return {"ok": False, "error": "Bridge not initialized"}

        if dest_name:
            self.client.config = ClientConfig(dest_name=dest_name)

        self._session_state = "connecting"
        try:
            self.client.connect(hub_hash_bytes, timeout_s=20.0)
        except TimeoutError as exc:
            self.write_event({"event": "error", "body": str(exc)})
            self._session_state = "disconnected"
            return {"ok": False, "error": str(exc)}

        self.client.start_ping_thread()
        return {"ok": True}

    def handle_disconnect_hub(self, msg: dict) -> dict:
        if self.client is not None:
            self.client.close()
        self._session_state = "disconnected"
        self._hub_limits = {}
        self.write_event({"event": "disconnected"})
        return {"ok": True}

    def handle_join(self, msg: dict) -> dict:
        if self._session_state != "active":
            return {"ok": False, "error": "Not connected to hub"}
        room = msg["room"].strip().lower()
        room_bytes = len(room.encode("utf-8"))
        if room_bytes > self.client.max_room_name_bytes:
            return {"ok": False, "error": f"Room name too long: {room_bytes} bytes exceeds limit of {self.client.max_room_name_bytes} bytes"}
        if len(self.client.rooms) >= self.client.max_rooms_per_session:
            return {"ok": False, "error": f"Cannot join more rooms: already in {len(self.client.rooms)} rooms (limit: {self.client.max_rooms_per_session})"}
        self.client.join(room)
        return {"ok": True, "room": room}

    def handle_leave(self, msg: dict) -> dict:
        if self._session_state != "active":
            return {"ok": False, "error": "Not connected to hub"}
        room = msg["room"].strip().lower()
        self.client.part(room)
        return {"ok": True, "room": room}

    def handle_send(self, msg: dict) -> dict:
        if self._session_state != "active":
            return {"ok": False, "error": "Not connected to hub"}
        room = msg["room"].strip().lower()
        body = msg["body"]
        body_bytes = len(body.encode("utf-8"))
        if body_bytes > self.client.max_msg_body_bytes:
            return {"ok": False, "error": f"Message too long: {body_bytes} bytes exceeds limit of {self.client.max_msg_body_bytes} bytes"}
        try:
            self.client.msg(room, body)
        except MessageTooLargeError:
            return {"ok": False, "error": "Message is too large to send (exceeds link MDU)"}
        return {"ok": True, "room": room}

    def handle_change_nick(self, msg: dict) -> dict:
        try:
            self.client.set_nickname(msg["nick"])
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        self._nickname = msg["nick"]
        return {"ok": True, "nick": msg["nick"]}

    def handle_discover_hubs(self, msg: dict) -> dict:
        import RNS
        self._discovered_hubs = set()

        class _RrcAnnounceHandler:
            aspect_filter = "rrc.hub"
            def __init__(self, bridge):
                self._bridge = bridge
            def received_announce(self, destination_hash, announced_identity, app_data):
                hex_hash = destination_hash.hex()
                if hex_hash not in self._bridge._discovered_hubs:
                    self._bridge._discovered_hubs.add(hex_hash)
                    name = None
                    if app_data:
                        try:
                            name = app_data.decode("utf-8")
                        except Exception:
                            name = None
                    self._bridge.write_event({
                        "event": "hub_discovered",
                        "hub_hash": hex_hash,
                        "name": name,
                    })

        RNS.Transport.register_announce_handler(_RrcAnnounceHandler(self))
        return {"ok": True}

    def handle_get_hubs(self, msg: dict) -> dict:
        return {"ok": True, "hubs": self._hubs_data}

    def handle_save_hub(self, msg: dict) -> dict:
        tag = msg["tag"]
        destination = msg.get("destination")
        dest_name = msg.get("dest_name") or None
        hubs = self._hubs_data.setdefault("hubs", {})

        # Remove any existing entry with the same destination hash
        # (handles renames — hash is the source of truth, not the tag)
        if destination:
            old_tags = [t for t, h in hubs.items() if h.get("destination") == destination and t != tag]
            for old_tag in old_tags:
                # Preserve channels from the old entry
                old_channels = hubs[old_tag].get("channels", [])
                hubs.pop(old_tag)
                if tag not in hubs:
                    hubs[tag] = {"destination": destination, "channels": old_channels}

        if tag in hubs:
            hubs[tag]["destination"] = destination
            if dest_name:
                hubs[tag]["dest_name"] = dest_name
        else:
            entry = {"destination": destination, "channels": []}
            if dest_name:
                entry["dest_name"] = dest_name
            hubs[tag] = entry

        _save_bookmarks(self._hubs_data)
        return {"ok": True, "hubs": self._hubs_data}

    def handle_delete_hub(self, msg: dict) -> dict:
        self._hubs_data.get("hubs", {}).pop(msg["tag"], None)
        _save_bookmarks(self._hubs_data)
        return {"ok": True, "hubs": self._hubs_data}

    def handle_toggle_bookmark(self, msg: dict) -> dict:
        channel_name = msg["channel"]
        hub_tag = msg.get("hub")
        if not hub_tag:
            return {"ok": False, "error": "No hub tag specified"}

        hubs = self._hubs_data.setdefault("hubs", {})
        hub = hubs.get(hub_tag)
        if hub is None:
            return {"ok": False, "error": f"Unknown hub: {hub_tag}"}

        channels = hub.setdefault("channels", [])
        existing = [i for i, ch in enumerate(channels) if ch["name"] == channel_name]
        if existing:
            for i in reversed(existing):
                channels.pop(i)
        else:
            channels.append({"name": channel_name})

        _save_bookmarks(self._hubs_data)
        return {"ok": True, "hubs": self._hubs_data}

    def handle_quit(self, msg: dict, req_id: str | None = None) -> None:
        if self.client is not None:
            self.client.close()
        if req_id:
            self.write_response(req_id, {"ok": True})
        sys.exit(0)


    # ------------------------------------------------------------------
    # RRC client callbacks
    # ------------------------------------------------------------------

    def _on_welcome(self, env: dict) -> None:
        from rrc_tui.constants import (
            B_WELCOME_HUB, B_WELCOME_LIMITS, K_BODY,
            L_MAX_MSG_BODY_BYTES, L_MAX_NICK_BYTES,
            L_MAX_ROOM_NAME_BYTES, L_MAX_ROOMS_PER_SESSION,
            L_RATE_LIMIT_MSGS_PER_MINUTE,
        )
        body = env.get(K_BODY)
        limits_out: dict = {}
        if isinstance(body, dict) and B_WELCOME_LIMITS in body:
            limits = body[B_WELCOME_LIMITS]
            if isinstance(limits, dict):
                self._hub_limits = dict(limits)
                if self.client is not None:
                    if L_MAX_NICK_BYTES in limits:
                        self.client.max_nick_bytes = int(limits[L_MAX_NICK_BYTES])
                    if L_MAX_ROOM_NAME_BYTES in limits:
                        self.client.max_room_name_bytes = int(limits[L_MAX_ROOM_NAME_BYTES])
                    if L_MAX_MSG_BODY_BYTES in limits:
                        self.client.max_msg_body_bytes = int(limits[L_MAX_MSG_BODY_BYTES])
                    if L_MAX_ROOMS_PER_SESSION in limits:
                        self.client.max_rooms_per_session = int(limits[L_MAX_ROOMS_PER_SESSION])
                    if L_RATE_LIMIT_MSGS_PER_MINUTE in limits:
                        self.client.rate_limit_msgs_per_minute = int(limits[L_RATE_LIMIT_MSGS_PER_MINUTE])
                limits_out = {
                    "maxNickBytes": self.client.max_nick_bytes,
                    "maxRoomNameBytes": self.client.max_room_name_bytes,
                    "maxMsgBodyBytes": self.client.max_msg_body_bytes,
                    "maxRoomsPerSession": self.client.max_rooms_per_session,
                    "rateLimitMsgsPerMinute": self.client.rate_limit_msgs_per_minute,
                }
        hub_name = ""
        if isinstance(body, dict):
            hub_name = body.get(B_WELCOME_HUB, "")
        self._session_state = "active"
        self.write_event({"event": "connected", "hub_name": hub_name, "limits": limits_out})

    def _on_message(self, env: dict) -> None:
        from rrc_tui.constants import K_BODY, K_NICK, K_ROOM, K_SRC, K_TS
        room = env.get(K_ROOM, "")
        src_raw = env.get(K_SRC, b"")
        # Skip messages from ourselves (renderer already shows them locally)
        if self.client and isinstance(src_raw, (bytes, bytearray)) and src_raw == self.client.identity.hash:
            return
        src_hex = src_raw.hex() if isinstance(src_raw, (bytes, bytearray)) else str(src_raw)
        nick = env.get(K_NICK, "")
        body = env.get(K_BODY, "")
        ts_ms = env.get(K_TS, 0)
        self.write_event({
            "event": "message", "room": room, "src": src_hex,
            "nick": nick, "suffix": src_hex[:8], "body": body,
            "timestamp": ts_ms / 1000.0,
        })

    def _on_notice(self, env: dict) -> None:
        from rrc_tui.constants import K_BODY, K_ROOM
        self.write_event({"event": "notice", "room": env.get(K_ROOM, ""), "body": env.get(K_BODY, "")})

    def _on_error(self, env: dict) -> None:
        from rrc_tui.constants import K_BODY
        body = env.get(K_BODY, "")
        self.write_event({"event": "error", "body": str(body) if not isinstance(body, str) else body})

    def _on_joined(self, room: str, env: dict) -> None:
        from rrc_tui.constants import B_JOINED_USERS, K_BODY
        body = env.get(K_BODY)
        members_raw = body.get(B_JOINED_USERS, []) if isinstance(body, dict) else []
        members = [m.hex() if isinstance(m, (bytes, bytearray)) else str(m) for m in members_raw]
        self.write_event({"event": "joined", "room": room, "members": members})

    def _on_parted(self, room: str, env: dict) -> None:
        self.write_event({"event": "parted", "room": room})

    def _on_close(self) -> None:
        self._session_state = "disconnected"
        self._hub_limits = {}
        self.write_event({"event": "disconnected"})

    def _on_pong(self, env: dict) -> None:
        pass

    # ------------------------------------------------------------------
    # Action dispatch
    # ------------------------------------------------------------------

    HANDLERS = {
        "connect_hub": "handle_connect_hub",
        "disconnect_hub": "handle_disconnect_hub",
        "join": "handle_join",
        "leave": "handle_leave",
        "send": "handle_send",
        "change_nick": "handle_change_nick",
        "discover_hubs": "handle_discover_hubs",
        "get_hubs": "handle_get_hubs",
        "save_hub": "handle_save_hub",
        "delete_hub": "handle_delete_hub",
        "toggle_bookmark": "handle_toggle_bookmark",
    }

    def _dispatch(self, msg: dict) -> None:
        action = msg.get("action")
        req_id = msg.get("id")
        if action == "init":
            try:
                self.handle_init(msg)
            except Exception as exc:
                log.error("init failed: %s", exc)
                traceback.print_exc(file=sys.stderr)
                if req_id:
                    self.write_response(req_id, {"ok": False, "error": str(exc)})
            return
        if action == "quit":
            self.handle_quit(msg, req_id=req_id)
            return
        handler_name = self.HANDLERS.get(action)
        if handler_name is None:
            if req_id:
                self.write_response(req_id, {"ok": False, "error": f"unknown action: {action}"})
            return
        try:
            result = getattr(self, handler_name)(msg)
            if req_id:
                self.write_response(req_id, result)
        except Exception as exc:
            log.error("%s failed: %s", action, exc)
            traceback.print_exc(file=sys.stderr)
            if req_id:
                self.write_response(req_id, {"ok": False, "error": str(exc)})

    def run(self) -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                log.warning("Bad JSON on stdin: %s", line)
                continue
            self._dispatch(msg)


def main():
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.INFO,
        format="[rrc_bridge] %(levelname)s %(message)s",
    )
    RrcBridge().run()


if __name__ == "__main__":
    main()
