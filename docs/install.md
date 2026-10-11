# Installing Lumen

This guide sets up Lumen for one teammate on Windows, macOS or Linux.
It takes about five minutes once Node.js is installed.

## What you need

- Node.js 22 or newer and Git.
- Roblox Studio, signed in.
- An MCP client: Claude Code, Codex, Cursor, Claude Desktop or another client that runs stdio MCP servers.
- Access to the private [Developer-One-Studios/Lumen](https://github.com/Developer-One-Studios/Lumen) repository. Over HTTPS, clone `https://github.com/Developer-One-Studios/Lumen.git` instead.

Lumen is not published to npm.
Its packages are marked private so they can never be published by accident, and every install comes from a checkout of the team repository.
Never install a package called `lumen-mcp` from the public npm registry, because it would not be ours.

## 1. Build Lumen

```sh
git clone git@github.com:Developer-One-Studios/Lumen.git lumen
cd lumen
npm ci
npm ci --prefix studio-plugin
npm run build
```

`npm run build` produces the servers in `packages/lumen-mcp/dist` and `packages/lumen-mcp-inspector/dist`.

## 2. Install the Studio plugin

### Windows and macOS

```sh
npm run build:plugin
```

This compiles the plugin and copies `LumenPlugin.rbxmx` into the Studio Plugins folder:

- Windows: `%LOCALAPPDATA%\Roblox\Plugins`
- macOS: `~/Documents/Roblox/Plugins`

### Linux with Vinegar or Wine

```sh
npm run build:plugin:artifact
node packages/lumen-mcp/dist/index.js --install-plugin
```

The first command builds `studio-plugin/LumenPlugin.rbxmx` without installing it.
The second finds the Plugins folder inside your Vinegar prefix, Flatpak or native, or inside `$WINEPREFIX`.
Set `MCP_PLUGINS_DIR` to install somewhere else.

### Then restart Studio

Close every Studio window and open Studio again.
A **Lumen** toolbar appears with one button.
It is red while no agent is running, and turns green once your agent starts Lumen and the plugin connects.

## 3. Register Lumen with your agent

Use the absolute path of your checkout in every command below.
`--auto-install-plugin` keeps the installed plugin in step with your checkout each time the server starts.

### Claude Code

```sh
claude mcp add lumen -s user -- node /path/to/lumen/packages/lumen-mcp/dist/index.js --auto-install-plugin
```

`-s user` makes Lumen available in every project.
Run `/mcp` inside Claude Code to check that `lumen` is connected.

### Codex

```sh
codex mcp add lumen -- node /path/to/lumen/packages/lumen-mcp/dist/index.js --auto-install-plugin
```

### Cursor, Claude Desktop and other clients

Add this to the client's MCP configuration:

```json
{
  "mcpServers": {
    "lumen": {
      "command": "node",
      "args": ["/path/to/lumen/packages/lumen-mcp/dist/index.js", "--auto-install-plugin"]
    }
  }
}
```

On Windows, double the backslashes inside JSON, for example `"C:\\Users\\you\\lumen\\packages\\lumen-mcp\\dist\\index.js"`.

### Read only edition

To give an agent read access without any way to change the place, build and register the Inspector instead:

```sh
npm run build:plugin:inspector
claude mcp add lumen-inspector -s user -- node /path/to/lumen/packages/lumen-mcp-inspector/dist/index.js --auto-install-plugin
```

Only one edition's plugin can be installed at a time, and each installer removes the other one.

## 4. Optional: Open Cloud key

`cloud_luau`, `upload_assets`, `datastore_read` and the monetization tools call Roblox Open Cloud.
Create a key in the Creator Dashboard under Credentials, add the experiences it may touch, and give it only the scopes you need:

| Tool | Scopes |
| --- | --- |
| `cloud_luau` | `universe.place.luau-execution-session:read` and `:write` |
| `upload_assets` | `asset:read` and `asset:write` |
| `datastore_read` | `universe-datastores.control:list`, `universe-datastores.objects:list` and `universe-datastores.objects:read` |
| Audio previews in `preview_asset` | `legacy-asset:manage` |
| `manage_monetization` | `developer-product:read` and `:write`, or `game-pass:read` and `:write` |

Then set it in the environment your agent starts from:

```sh
# macOS and Linux, in your shell profile
export ROBLOX_OPEN_CLOUD_API_KEY="..."
export ROBLOX_CREATOR_GROUP_ID="123456"
```

```powershell
# Windows, once per user
[Environment]::SetEnvironmentVariable("ROBLOX_OPEN_CLOUD_API_KEY", "...", "User")
[Environment]::SetEnvironmentVariable("ROBLOX_CREATOR_GROUP_ID", "123456", "User")
```

Restart your agent afterwards.
Avoid the `--open-cloud-key` flag, because it stores the key in plain text in your agent's configuration.

## 5. Check that it works

Open any place in Studio, then ask your agent:

> Call get_connected_instances and then get_place_info.

You should see your place name and its peers.
If you use Rojo, also try:

> Run verify_sync with project_root set to my project folder.

## Updating

```sh
cd lumen
git pull
npm ci
npm ci --prefix studio-plugin
npm run build
npm run build:plugin
```

On Linux use `npm run build:plugin:artifact` and `node packages/lumen-mcp/dist/index.js --install-plugin` for the last step.
Restart Studio and reconnect Lumen in your agent, for example with `/mcp` in Claude Code.
The plugin and the server must come from the same build, because the server refuses a plugin of another version when it connects.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| The toolbar button stays red | The agent has not started Lumen yet. Start a session or run `/mcp`, then look at the agent's MCP log for errors. |
| "No Studio peer is connected" | Studio was opened before the plugin was installed. Restart Studio. |
| Port already in use | Another Lumen server is running, for example from a second agent session. The second server joins the first as a proxy, which is fine. To run fully separate servers, give each its own `ROBLOX_STUDIO_PORT`. |
| Plugin and server versions differ | Rebuild both with the update steps above and restart Studio. |
| Edits to a script are refused as "synced by Rojo" | That script comes from a file. Edit the file instead, or set `ROBLOX_ALLOW_SYNCED_EDITS=1` if you really mean to change Studio's copy. |
| `cloud_luau` returns 403 | The key lacks the luau execution scopes, or the experience is not added to the key. |
| Screenshots of multiplayer clients fail on Linux | Wine cannot read captures across Studio processes. Use a solo playtest, or enable host capture as described in [configuration](configuration.md#host-window-capture). |
| Windows Firewall prompt | Allow Node.js on private networks. Lumen only listens on `127.0.0.1`. |

## Uninstalling

Remove the registration from your agent, for example `claude mcp remove lumen -s user`.
Then delete `LumenPlugin.rbxmx` or `LumenInspectorPlugin.rbxmx` from the Studio Plugins folder and restart Studio.
