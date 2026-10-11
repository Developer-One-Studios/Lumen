# Lumen Studio plugin

The Lumen plugin connects Roblox Studio to the Lumen server that your AI agent runs.
It is built from this repository, so there is no Creator Store listing and no download link.

## Installing

Follow [docs/install.md](../docs/install.md).
In short, `npm run build:plugin` builds `LumenPlugin.rbxmx` and copies it into Studio's Plugins folder on Windows and macOS.
On Linux, run `npm run build:plugin:artifact` and then `node packages/lumen-mcp/dist/index.js --install-plugin`.

To copy it by hand, put `studio-plugin/LumenPlugin.rbxmx` into the Plugins folder:

- Windows: `%LOCALAPPDATA%\Roblox\Plugins`
- macOS: `~/Documents/Roblox/Plugins`
- Any platform: in Studio, open **Plugins > Plugins Folder**.

Keep only one edition in that folder.
Remove `LumenInspectorPlugin.rbxmx` when you install `LumenPlugin.rbxmx`, and the other way around.
Fully close and reopen Studio after installing or updating.

## Using it

The plugin adds a **Lumen** toolbar with one button.

| Button | Meaning |
| --- | --- |
| Red | No Lumen server is running. Start a session in your agent. |
| Yellow | Connecting. |
| Green | Connected, and your agent can use Studio. |

The button also opens a small panel with the connection steps and the server URL.
The plugin connects by itself whenever a Lumen server starts, so you rarely need to click it.

To preview or insert public Creator Store assets you do not own, turn on **Allow Loading Third Party Assets** under **Game Settings > Security**.

## How it works

1. Your agent calls a tool, and the Lumen server queues the request.
2. The plugin receives it over an authenticated WebSocket.
3. The plugin runs the Studio API calls in the right DataModel: edit, the playtest server, or a client.
4. Progress and the result travel back over the same socket.

During playtests the server and each client connect as their own peers, and client requests run only with a ticket the server peer issued.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| No Lumen toolbar | Check the file is in the Plugins folder, then restart Studio completely and look for errors in the Output window. |
| The button stays red | Normal until your agent starts Lumen. Reconnect the server from your agent, for example with `/mcp` in Claude Code. |
| It connects and drops again | The plugin and server come from different builds. Rebuild both as in [docs/install.md](../docs/install.md#updating) and restart Studio. |
| Firewall prompt on Windows | Allow Node.js on private networks. Lumen only uses `localhost:58761`. |

## Settings

- **Server URL**: the panel has one URL field, `http://localhost:58761` by default. The plugin only accepts and remembers loopback addresses.
- **Several places**: every open place connects to the same server, and agents pick one with `get_connected_instances` and `instance_id`.

## Privacy

The full plugin can change a place whenever your agent calls a write tool.
Install the Inspector edition when you only want read access.
Tool results go to your AI agent, so your AI provider's data policy applies to what it sends.
See [SECURITY.md](../SECURITY.md) for the security model and how to report a problem.
