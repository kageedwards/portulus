#!/usr/bin/env python3
"""
rrc_bridge — NDJSON stdio bridge for Portulus (RRC protocol).

Reads commands from stdin, drives an rrc_tui.Client,
writes events/responses to stdout.
Stderr is reserved for logging.

Usage (spawned by Electron main.js)::

    python -m rrc_bridge

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

from rrc_tui.client import Client, ClientConfig

log = logging.getLogger("rrc_bridge")


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
        self._store_path: str = os.path.expanduser("~/.lxcf")
        self._session_state: str = "disconnected"  # disconnected | connecting | awaiting_welcome | active
        self._hub_limits: dict = {}
        self._nickname: str | None = None

    # ------------------------------------------------------------------
    # Thread-safe stdout writers
    # ------------------------------------------------------------------

    def write_event(self, obj: dict) -> None:
        """Write a JSON event to stdout (thread-safe)."""
        line = json.dumps(obj, separators=(",", ":"))
        with self._lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def write_response(self, req_id: str, data: dict) -> None:
        """Write a response correlated to a request ID."""
        data["response"] = req_id
        line = json.dumps(data, separators=(",", ":"))
        with self._lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    # ------------------------------------------------------------------
    # Action handlers (stubs — implemented in tasks 1.2–1.8)
    # ------------------------------------------------------------------

    def handle_init(self, msg: dict) -> None:
        """Initialize RNS, rrc_tui.Client, wire events, emit 'ready'.

        Implemented in task 1.2.
        """
        raise NotImplementedError("handle_init is implemented in task 1.2")

    def handle_connect_hub(self, msg: dict) -> dict:
        """Connect to an RRC hub by destination hash.

        Implemented in task 1.3.
        """
        raise NotImplementedError("handle_connect_hub is implemented in task 1.3")

    def handle_disconnect_hub(self, msg: dict) -> dict:
        """Disconnect from the current RRC hub.

        Implemented in task 1.3.
        """
        raise NotImplementedError("handle_disconnect_hub is implemented in task 1.3")

    def handle_join(self, msg: dict) -> dict:
        """Join an RRC room.

        Implemented in task 1.4.
        """
        raise NotImplementedError("handle_join is implemented in task 1.4")

    def handle_leave(self, msg: dict) -> dict:
        """Leave an RRC room.

        Implemented in task 1.4.
        """
        raise NotImplementedError("handle_leave is implemented in task 1.4")

    def handle_send(self, msg: dict) -> dict:
        """Send a message to an RRC room.

        Implemented in task 1.5.
        """
        raise NotImplementedError("handle_send is implemented in task 1.5")

    def handle_change_nick(self, msg: dict) -> dict:
        """Change the user's nickname.

        Implemented in task 1.5.
        """
        raise NotImplementedError("handle_change_nick is implemented in task 1.5")

    def handle_discover_hubs(self, msg: dict) -> dict:
        """Start listening for RRC hub announces.

        Implemented in task 1.7.
        """
        raise NotImplementedError("handle_discover_hubs is implemented in task 1.7")

    def handle_get_hubs(self, msg: dict) -> dict:
        """Return current hubs/bookmarks data.

        Implemented in task 1.8.
        """
        raise NotImplementedError("handle_get_hubs is implemented in task 1.8")

    def handle_save_hub(self, msg: dict) -> dict:
        """Add or update a hub entry.

        Implemented in task 1.8.
        """
        raise NotImplementedError("handle_save_hub is implemented in task 1.8")

    def handle_delete_hub(self, msg: dict) -> dict:
        """Remove a hub entry.

        Implemented in task 1.8.
        """
        raise NotImplementedError("handle_delete_hub is implemented in task 1.8")

    def handle_toggle_bookmark(self, msg: dict) -> dict:
        """Add or remove a bookmark under a hub.

        Implemented in task 1.8.
        """
        raise NotImplementedError("handle_toggle_bookmark is implemented in task 1.8")

    def handle_quit(self, msg: dict, req_id: str | None = None) -> None:
        """Close client, write final response, sys.exit(0).

        Implemented in task 1.8.
        """
        raise NotImplementedError("handle_quit is implemented in task 1.8")

    # ------------------------------------------------------------------
    # RRC client callbacks (stubs — implemented in tasks 1.3–1.5)
    # ------------------------------------------------------------------

    def _on_welcome(self, env: dict) -> None:
        """Handle WELCOME envelope from hub.

        Implemented in task 1.3.
        """
        raise NotImplementedError("_on_welcome is implemented in task 1.3")

    def _on_message(self, env: dict) -> None:
        """Handle MSG envelope from hub.

        Implemented in task 1.5.
        """
        raise NotImplementedError("_on_message is implemented in task 1.5")

    def _on_notice(self, env: dict) -> None:
        """Handle NOTICE envelope from hub.

        Implemented in task 1.5.
        """
        raise NotImplementedError("_on_notice is implemented in task 1.5")

    def _on_error(self, env: dict) -> None:
        """Handle ERROR envelope from hub.

        Implemented in task 1.5.
        """
        raise NotImplementedError("_on_error is implemented in task 1.5")

    def _on_joined(self, room: str, env: dict) -> None:
        """Handle JOINED envelope from hub.

        Implemented in task 1.4.
        """
        raise NotImplementedError("_on_joined is implemented in task 1.4")

    def _on_parted(self, room: str, env: dict) -> None:
        """Handle PARTED envelope from hub.

        Implemented in task 1.4.
        """
        raise NotImplementedError("_on_parted is implemented in task 1.4")

    def _on_close(self) -> None:
        """Handle Link close event.

        Implemented in task 1.3.
        """
        raise NotImplementedError("_on_close is implemented in task 1.3")

    def _on_pong(self, env: dict) -> None:
        """Handle PONG envelope from hub.

        Implemented in task 1.3.
        """
        raise NotImplementedError("_on_pong is implemented in task 1.3")

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
        """Route a parsed command to the appropriate handler."""
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
            resp = {"ok": False, "error": f"unknown action: {action}"}
            if req_id:
                self.write_response(req_id, resp)
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

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    def run(self) -> None:
        """Read NDJSON commands from stdin in a blocking loop."""
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
    bridge = RrcBridge()
    bridge.run()


if __name__ == "__main__":
    main()
