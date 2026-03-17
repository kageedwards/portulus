# Portulus

A desktop chat client for [LXCF](https://github.com/kageedwards/lxcf-js) over [Reticulum](https://reticulum.network) mesh networks. Built with Electron.

![portulus](https://img.shields.io/badge/version-0.1.0-blue)

## Install

```bash
git clone https://github.com/kageedwards/portulus
cd portulus
npm install
npm start
```

Requires Node.js ≥ 18.

## Features

- Multi-channel tabbed interface with bookmarks
- Public and subnet (keyed) channels
- Emotes, nick changes
- Member sidebar with identity suffixes
- 7 themes: midnight, cherry blossom, vintage charm, mocha latte, halcyon skies, legion, millennium
- Command autocomplete (`/join`, `/leave`, `/nick`, `/me`, `/quit`)
- Shared config with the LXCF TUI client (`~/.lxcf/`)
- Reads `~/.reticulum/config` for TCP interfaces automatically
- Local rnsd support on `127.0.0.1:37428`

## Configuration

Portulus uses two config sources:

### Shared config (`~/.lxcf/config`)

INI format, shared with the TUI client.

```ini
[lxcf]
nick = yourname
announce_joins = True
use_local_rnsd = True
```

### Portulus settings (`~/.lxcf/portulus.json`)

Portulus-specific preferences.

```json
{
  "theme": "midnight",
  "interfaces": [
    { "name": "RMAP", "host": "rmap.world", "port": 4242 }
  ]
}
```

The `interfaces` list is a fallback — if `~/.reticulum/config` has enabled `TCPClientInterface` entries, those are used instead.

### Bookmarks (`~/.lxcf/bookmarks.json`)

Shared bookmark list. Toggle with `Ctrl+S` or click the star on a channel tab.

## Commands

| Command | Description |
|---|---|
| `/join #channel [subnet]` | Join a channel, optionally with a subnet passphrase |
| `/leave` | Leave the active channel |
| `/nick name` | Change your display name |
| `/me action` | Send an emote |
| `/quit` | Leave all channels and exit |

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Ctrl+S` | Toggle bookmark on active channel |
| `Escape` | Dismiss modals and menus |
| `Tab` / `Enter` | Accept command autocomplete |

## CLI Options

```bash
npm start -- --rns-config /path/to/reticulum/config
```

## Dependencies

- [lxcf-js](https://github.com/kageedwards/lxcf-js) — LXCF protocol library
- [@liamcottle/rns.js](https://github.com/liamcottle/rns.js) — Reticulum for JavaScript
- [Electron](https://www.electronjs.org/)

## License

MIT
