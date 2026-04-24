"""
Unit tests for the RRC bridge handler logic.

Tests the RrcBridge class by subclassing it to capture write_event and
write_response output, and mocking the rrc_tui.Client where needed.

Requirements validated: 1.4, 2.1, 2.5, 2.6, 6.1, 6.3, 6.5
"""

from __future__ import annotations

import os
import sys

# Add rrc_tui and portulus src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_ref_rrc_tui"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from unittest.mock import MagicMock, patch

import pytest

from rrc_bridge import RrcBridge


class _CapturingRrcBridge(RrcBridge):
    """RrcBridge subclass that captures events and responses for testing."""

    def __init__(self):
        super().__init__()
        self.events: list[dict] = []
        self.responses: list[dict] = []

    def write_event(self, obj: dict) -> None:
        self.events.append(obj)

    def write_response(self, req_id: str, data: dict) -> None:
        data["response"] = req_id
        self.responses.append(data)


def _make_bridge_with_mock_client() -> _CapturingRrcBridge:
    """Create a _CapturingRrcBridge with a mocked client in active state."""
    bridge = _CapturingRrcBridge()
    bridge.client = MagicMock()
    bridge.client.max_nick_bytes = 32
    bridge.client.max_room_name_bytes = 64
    bridge.client.max_msg_body_bytes = 350
    bridge.client.max_rooms_per_session = 32
    bridge.client.rooms = set()
    bridge._session_state = "active"
    return bridge


# ------------------------------------------------------------------
# 1. test_dispatch_unknown_action
# ------------------------------------------------------------------

def test_dispatch_unknown_action():
    """Unknown action returns an error response."""
    bridge = _CapturingRrcBridge()
    bridge._dispatch({"action": "nonexistent_action", "id": "req-1"})

    assert len(bridge.responses) == 1
    resp = bridge.responses[0]
    assert resp["ok"] is False
    assert "unknown action" in resp["error"]
    assert resp["response"] == "req-1"


# ------------------------------------------------------------------
# 2. test_handle_connect_hub_not_initialized
# ------------------------------------------------------------------

def test_handle_connect_hub_not_initialized():
    """connect_hub before init returns error (client is None)."""
    bridge = _CapturingRrcBridge()
    assert bridge.client is None

    result = bridge.handle_connect_hub({"hub_hash": "aa" * 16})
    assert result["ok"] is False
    assert "not initialized" in result["error"].lower()


# ------------------------------------------------------------------
# 3. test_handle_disconnect_hub_clears_state
# ------------------------------------------------------------------

def test_handle_disconnect_hub_clears_state():
    """disconnect_hub resets session state and emits disconnected event."""
    bridge = _make_bridge_with_mock_client()
    bridge._hub_limits = {"some": "limits"}

    result = bridge.handle_disconnect_hub({})

    assert result["ok"] is True
    assert bridge._session_state == "disconnected"
    assert bridge._hub_limits == {}
    assert len(bridge.events) == 1
    assert bridge.events[0]["event"] == "disconnected"


# ------------------------------------------------------------------
# 4. test_handle_join_not_connected
# ------------------------------------------------------------------

def test_handle_join_not_connected():
    """join when disconnected returns error."""
    bridge = _CapturingRrcBridge()
    assert bridge._session_state == "disconnected"

    result = bridge.handle_join({"room": "#lobby"})
    assert result["ok"] is False
    assert "not connected" in result["error"].lower()


# ------------------------------------------------------------------
# 5. test_handle_leave_not_connected
# ------------------------------------------------------------------

def test_handle_leave_not_connected():
    """leave when disconnected returns error."""
    bridge = _CapturingRrcBridge()
    assert bridge._session_state == "disconnected"

    result = bridge.handle_leave({"room": "#lobby"})
    assert result["ok"] is False
    assert "not connected" in result["error"].lower()


# ------------------------------------------------------------------
# 6. test_handle_send_not_connected
# ------------------------------------------------------------------

def test_handle_send_not_connected():
    """send when disconnected returns error."""
    bridge = _CapturingRrcBridge()
    assert bridge._session_state == "disconnected"

    result = bridge.handle_send({"room": "#lobby", "body": "hello"})
    assert result["ok"] is False
    assert "not connected" in result["error"].lower()


# ------------------------------------------------------------------
# 7. test_handle_change_nick_stores_nickname
# ------------------------------------------------------------------

def test_handle_change_nick_stores_nickname():
    """change_nick stores the nickname on the bridge."""
    bridge = _make_bridge_with_mock_client()

    result = bridge.handle_change_nick({"nick": "alice"})
    assert result["ok"] is True
    assert result["nick"] == "alice"
    assert bridge._nickname == "alice"
    bridge.client.set_nickname.assert_called_once_with("alice")


# ------------------------------------------------------------------
# 8. test_handle_get_hubs_returns_data
# ------------------------------------------------------------------

def test_handle_get_hubs_returns_data():
    """get_hubs returns the current hubs data."""
    bridge = _CapturingRrcBridge()
    bridge._hubs_data = {
        "hubs": {
            "my-hub": {"destination": "aa" * 16, "protocol": "rrc", "channels": []}
        }
    }

    result = bridge.handle_get_hubs({})
    assert result["ok"] is True
    assert result["hubs"] == bridge._hubs_data


# ------------------------------------------------------------------
# 9. test_handle_save_hub_adds_rrc_protocol
# ------------------------------------------------------------------

def test_handle_save_hub_adds_rrc_protocol():
    """save_hub sets protocol to 'rrc' on new hub entries."""
    bridge = _CapturingRrcBridge()
    bridge._hubs_data = {"hubs": {}}

    with patch("lxcf.hub_config.save_hubs"):
        result = bridge.handle_save_hub({
            "tag": "test-hub",
            "destination": "bb" * 16,
        })

    assert result["ok"] is True
    hub_entry = result["hubs"]["hubs"]["test-hub"]
    assert hub_entry["protocol"] == "rrc"
    assert hub_entry["destination"] == "bb" * 16


# ------------------------------------------------------------------
# 10. test_on_close_resets_state
# ------------------------------------------------------------------

def test_on_close_resets_state():
    """_on_close resets session state to disconnected and clears limits."""
    bridge = _make_bridge_with_mock_client()
    bridge._hub_limits = {"max_nick": 32}

    bridge._on_close()

    assert bridge._session_state == "disconnected"
    assert bridge._hub_limits == {}
    assert len(bridge.events) == 1
    assert bridge.events[0]["event"] == "disconnected"


# ------------------------------------------------------------------
# 11. test_on_error_string_body
# ------------------------------------------------------------------

def test_on_error_string_body():
    """_on_error with a string body emits error event with that string."""
    from rrc_tui.constants import K_BODY

    bridge = _CapturingRrcBridge()
    bridge._on_error({K_BODY: "something went wrong"})

    assert len(bridge.events) == 1
    evt = bridge.events[0]
    assert evt["event"] == "error"
    assert evt["body"] == "something went wrong"


# ------------------------------------------------------------------
# 12. test_on_error_dict_body
# ------------------------------------------------------------------

def test_on_error_dict_body():
    """_on_error with a dict body emits error event with str() of the dict."""
    from rrc_tui.constants import K_BODY

    bridge = _CapturingRrcBridge()
    error_dict = {"code": 42, "msg": "bad request"}
    bridge._on_error({K_BODY: error_dict})

    assert len(bridge.events) == 1
    evt = bridge.events[0]
    assert evt["event"] == "error"
    assert evt["body"] == str(error_dict)


# ------------------------------------------------------------------
# 13. test_on_message_emits_event
# ------------------------------------------------------------------

def test_on_message_emits_event():
    """_on_message with a MSG envelope emits a message event with correct fields."""
    from rrc_tui.constants import K_BODY, K_NICK, K_ROOM, K_SRC, K_TS

    bridge = _CapturingRrcBridge()
    src_bytes = bytes.fromhex("aa" * 16)
    bridge._on_message({
        K_ROOM: "lobby",
        K_SRC: src_bytes,
        K_NICK: "bob",
        K_BODY: "hello world",
        K_TS: 1700000000000,
    })

    assert len(bridge.events) == 1
    evt = bridge.events[0]
    assert evt["event"] == "message"
    assert evt["room"] == "lobby"
    assert evt["src"] == "aa" * 16
    assert evt["nick"] == "bob"
    assert evt["body"] == "hello world"
    assert evt["timestamp"] == 1700000000.0
    assert evt["suffix"] == ("aa" * 16)[:8]


# ------------------------------------------------------------------
# 14. test_on_notice_emits_event
# ------------------------------------------------------------------

def test_on_notice_emits_event():
    """_on_notice with a NOTICE envelope emits a notice event."""
    from rrc_tui.constants import K_BODY, K_ROOM

    bridge = _CapturingRrcBridge()
    bridge._on_notice({
        K_ROOM: "lobby",
        K_BODY: "Welcome to the hub!",
    })

    assert len(bridge.events) == 1
    evt = bridge.events[0]
    assert evt["event"] == "notice"
    assert evt["room"] == "lobby"
    assert evt["body"] == "Welcome to the hub!"
