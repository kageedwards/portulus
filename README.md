# Portulus

A multi-protocol desktop chat client for [Reticulum](https://reticulum.network) mesh networks. Supports both [LXCF](https://github.com/kageedwards/lxcf) (channel-based messaging over LXMF) and [RRC](https://rrc.kc1awv.net/) (Reticulum Relay Chat, real-time room-based chat over Reticulum Links). Built with Electron and dual Python bridge subprocesses.

![portulus](https://img.shields.io/badge/version-0.1.0-blue)

![Portulus screenshot](assets/screenshot.png)
![Portulus chat screenshot](assets/screenshot-2.png)

## Install

```bash
git clone https://github.com/kageedwards/portulus
cd portulus
npm install
npm start
```

Requires Node.js ≥ 18 and Python ≥ 3.11

On first launch, Portulus bootstraps a Python virtual environment and installs protocol dependencies (LXCF, rrc-tui, cbor2). This requires internet access once; subsequent launches use the cached venv.

## Features

### Multi-Protocol Support
- LXCF channels (⬡) and RRC rooms (◈) in the same tabbed interface
- Protocol indicator on each tab and bookmark
- Shared Reticulum identity across both protocols

### LXCF (Channel Messaging)
- Public and symmetrically keyed channels (both E2EE)
- Hub-based message relay via LXMF
- Shared config format with the LXCF TUI client

### RRC (Reticulum Relay Chat)
- Real-time room-based chat over Reticulum Links
- CBOR wire format per the [RRC specification](https://rrc.kc1awv.net/)
- Automatic hub discovery via Reticulum announces
- Hub display name learned from WELCOME handshake
- PING/PONG latency tracking
- Hub limit enforcement (nick length, room name, message size, rate limiting)
- Resource transfer support for large payloads (MOTD, notices)
- Custom `dest_name` support (e.g. `rrc.hub.myinstance`)

### General
- Multi-channel tabbed interface with bookmarks
- Nickname changes, /me emotes
- Member sidebar with identity suffixes
- Twelve themes: midnight, cherry blossom, vintage charm, mocha latte, halcyon skies, legion, millennium, serenity, prism, altitude, sonic bliss, nighttime
- IRC command autocomplete (`/join`, `/leave`, `/nick`, `/me`, `/quit`)
- Reads `~/.reticulum/config` for TCP interfaces automatically
- Local rnsd support on `127.0.0.1:37428`

## Configuration

### Shared config (LXCF)
INI format, shared with the LXCF TUI client.

`~/.lxcf/config`:
```ini
[lxcf]
nick = yourname
announce_joins = True
use_local_rnsd = True
```

### Portulus-specific settings

`~/.lxcf/portulus.json`:
```json
{
  "theme": "midnight",
  "interfaces": [
    { "name": "RMAP", "host": "rmap.world", "port": 4242 }
  ]
}
```

The `interfaces` list is a fallback — if `~/.reticulum/config` has enabled `TCPClientInterface` entries, those are used instead.

### LXCF Bookmarks

`~/.lxcf/bookmarks.json` — managed by the LXCF bridge, shared with the TUI client:
```json
{
  "hubs": {
    "My Hub": {
      "destination": "asd8a9sd8as0d9a8s90dasdas09dadsa",
      "channels": [{"name": "#lobby"}]
    }
  }
}
```

### RRC Bookmarks

`~/.portulus/bookmarks.json` — managed by Portulus for RRC hubs (separate from LXCF):
```json
{
  "hubs": {
    "BerryTube": {
      "destination": "a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8",
      "dest_name": "rrc.hub.berrytube",
      "channels": [{"name": "#lobby"}, {"name": "#general"}]
    }
  }
}
```

Toggle bookmarks with `Ctrl+S` or click the star on a channel/room tab.

## Commands

| Command | Description |
|---|---|
| `/join #channel [hub] [key]` | Join a channel/room. Hub can be a tag name or destination hash. |
| `/leave` | Leave the active channel/room |
| `/nick name` | Change your display name (applies to both protocols) |
| `/me action` | Send an emote-style message |
| `/quit` | Leave all channels/rooms and exit |

For RRC, `/join #room hubhash` connects to the hub and joins the room. If the active tab is already an RRC room, `/join #room` joins on the same hub.

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Ctrl+S` | Toggle bookmark on active channel/room |
| `Escape` | Dismiss modals and menus |
| `Tab` / `Enter` | Accept command autocomplete |

## Architecture

Portulus runs two Python bridge subprocesses:
- **LXCF bridge** (`lxcf_bridge.py`) — drives `lxcf.Client` via LXMF/msgpack
- **RRC bridge** (`rrc_bridge.py`) — drives `rrc_tui.Client` via Reticulum Links/CBOR

Both communicate with the Electron main process via NDJSON over stdin/stdout. The renderer distinguishes events by protocol prefix (`lxcf:` or `rrc:`).

## CLI Options

```bash
npm start -- --rns-config /path/to/reticulum/config
```
This app works best with default config and a running Reticulum shared instance.

## Dependencies

- [LXCF](https://github.com/kageedwards/lxcf) — Python protocol library for channel messaging
- [rrc-tui](https://github.com/kc1awv/rrc-tui) — Python RRC client library by S. Miller, KC1AWV (MIT license)
- [Electron](https://www.electronjs.org/)

## License

See [LICENSE.md](LICENSE.md) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for third-party attribution.
