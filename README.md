# Lumen

**See what your Roblox game is really doing.**

Lumen connects AI coding agents such as Claude Code, Codex and Cursor to Roblox Studio.
Agents can edit places, run Luau on the edit, server and client peers, drive playtests, and read logs, screenshots and profiler data.
On top of that, Lumen adds tools that answer the questions a game team actually asks while shipping: why does it lag, what leaks, did that sync land, is this jump possible, does the shop button fit on a phone.

Lumen is a private team build.
It is a fork of [robloxstudio-mcp](https://github.com/Chrrxs/robloxstudio-mcp) 3.2.0, keeps all 49 of its tools, and adds 24 more for 73 in total.

## What Lumen adds

| Area | Tools | What you get |
| --- | --- | --- |
| Lag | `perf_stats`, `lag_audit`, `profile_toggle` | Frame, GPU, draw call, physics, network and ping samples per peer, ranked lists of costly content, and before and after numbers with a category switched off. |
| Leaks | `leak_check` | Repeats an action and reports memory tags, classes, detached instances or values that keep growing. |
| Playtests | `playtest_scenario`, `wait_for`, `watch` | One call runs keys, clicks, walks, checks and screenshots and returns one report with errors from every peer. |
| Movement | `navigate_character` | Pathfinding walks that stop within seconds when blocked and name the part in the way. |
| Safe experiments | `checkpoint` | Snapshot the place, list every change since, and undo it all as one Ctrl+Z step. |
| Level QA | `spatial_check` | Floating parts, overlaps, buried parts, jump gaps with real jump physics, pathfinding reach and distances. |
| UI QA | `ui_audit`, `inspect_gui` | Offscreen, clipped, overlapping, tiny or unreadable GUI across phone, tablet and PC presets, plus clicks by GuiObject path. |
| Screenshots | `capture_views` | Shots from chosen camera positions in edit mode or on playtest clients, held even against game camera scripts. |
| Rojo | `resolve_source`, `verify_sync` | Studio paths become `file:line`, edits to synced scripts are refused, and each peer is checked against the files on disk. |
| Errors | `get_errors` | A deduplicated error and warning digest from every peer since the last call. |
| Networking | `replication_diff`, `fuzz_remotes` | Compare an instance between server and clients, and fire malformed or spammed payloads at remotes. |
| Tests | `run_tests`, `cloud_luau` | Run the place's test runner in a playtest, or run Luau headlessly on a Roblox cloud server. |
| Assets | `upload_assets`, `audit_assets`, `datastore_read` | Batch uploads with retries and Sounds created in Studio, a check for assets that fail to load live, and read only DataStore access. |
| Editing | `multi_edit` | Several edits to one script as one atomic, undoable step. |

Lumen also improves a few upstream tools.
`execute_luau` and the eval tools cancel code that is still waiting after `timeout_s`, so a `WaitForChild` that never resolves fails fast and names the missing child.
Script edits match through whitespace differences, `capture_screenshot` can shrink frames and shoot every client, and clicks by path avoid buttons drawn over the target.
The full reference is in [docs/tools.md](docs/tools.md).

## How it compares

Based on each project's tool list in October 2026.

| Capability | Lumen | robloxstudio-mcp 3.2.0 | Official Roblox Studio MCP |
| --- | --- | --- | --- |
| Run Luau in edit, server and client | Yes | Yes | Yes |
| Lag sampling, lag audit and on and off cost tests | Yes | Profilers only | No |
| Memory leak detection | Yes | No | No |
| Scripted playtests with one report | Yes | No | No |
| Checkpoint and one step revert | Yes | No | No |
| Level checks (floating, overlaps, jump gaps, reach) | Yes | No | No |
| GUI audit across devices | Yes | Device screenshots | No |
| Rojo sync checks and `file:line` mapping | Yes | No | No |
| Replication diff and remote fuzzing | Yes | No | No |
| Headless cloud Luau | Yes | No | No |
| Batch asset upload | Audio, models and images | One file at a time | Images |
| Atomic multi edit | Yes | No | Yes |
| Character walking | Yes, with stall reports | No | Yes |
| AI mesh, texture and material generation | No | Model staging | Yes |
| Roblox subagents | No | No | Yes |
| Linux with Vinegar | Plugin install, screenshots and launching | Wine launcher | Not supported |

Lumen runs side by side with the official Roblox Studio MCP.
It uses its own port, plugin file, toolbar and settings, so it can also sit next to an upstream robloxstudio-mcp install.

## Quick start

You need Node.js 22 or newer, Git, and Roblox Studio.
Lumen is not on npm.
Every teammate builds it from the private [Developer-One-Studios/Lumen](https://github.com/Developer-One-Studios/Lumen) repository.

```sh
git clone git@github.com:Developer-One-Studios/Lumen.git lumen
cd lumen
npm ci
npm ci --prefix studio-plugin
npm run build
npm run build:plugin
```

`npm run build:plugin` compiles the Studio plugin and installs `LumenPlugin.rbxmx` into your Studio Plugins folder.
Restart Studio afterwards.
The **Lumen** toolbar button turns green once an agent connects.

Then register Lumen with your agent, using the absolute path of your checkout.

**Claude Code**

```sh
claude mcp add lumen -s user -- node /path/to/lumen/packages/lumen-mcp/dist/index.js --auto-install-plugin
```

**Codex**

```sh
codex mcp add lumen -- node /path/to/lumen/packages/lumen-mcp/dist/index.js --auto-install-plugin
```

**Cursor, Claude Desktop and other clients**

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

On Windows use the full path, and double the backslashes inside JSON, for example `C:\\Users\\you\\lumen\\packages\\lumen-mcp\\dist\\index.js`.
`--auto-install-plugin` refreshes the Studio plugin from your checkout whenever the server starts with a newer build.

Full setup for Windows, macOS and Linux, plus updating and troubleshooting, is in [docs/install.md](docs/install.md).

## Try it

Ask your agent things like:

- "Start a playtest and tell me what costs the most frame time on the client."
- "Spawn and despawn an enemy 30 times and check whether anything leaks."
- "Walk the character from the spawn to the boss arena and screenshot each checkpoint."
- "Checkpoint the place, try the new lighting, show me the changes, then revert."
- "Audit the main menu on a phone, a tablet and a 1080p PC."
- "Which platforms on the obby can't be reached with the default jump?"
- "I edited the dash module but nothing changed in game. Is Rojo syncing?"
- "Run the place's tests on the published version in the cloud."

## Editions

| Edition | Package | Plugin | Use it for |
| --- | --- | --- | --- |
| Lumen | `packages/lumen-mcp` | `LumenPlugin.rbxmx` | Everything: editing, playtests, profiling and QA. |
| Lumen Inspector | `packages/lumen-mcp-inspector` | `LumenInspectorPlugin.rbxmx` | Read only access through 27 tools that cannot change the DataModel or scripts. |

Install one edition at a time, since each installer removes the other plugin.
The Inspector is built with `npm run build:plugin:inspector` and registered with `packages/lumen-mcp-inspector/dist/index.js`.

## Configuration

Most teams only need these:

| Variable | Purpose |
| --- | --- |
| `ROBLOX_OPEN_CLOUD_API_KEY` | Open Cloud key for `cloud_luau`, `upload_assets`, `datastore_read` and the monetization tools. |
| `ROBLOX_CREATOR_GROUP_ID` | Group that uploads belong to when no `group_id` is passed. |
| `ROBLOX_STUDIO_PORT` | Bridge port, `58761` by default. |
| `ROBLOX_SOURCEMAP` | Rojo `sourcemap.json` to use when none is found above the working directory. |
| `ROBLOX_MCP_ARTIFACT_DIR` | Keeps every file Lumen writes, such as screenshots, exports and manifests, inside one folder. |

Set the key in your environment rather than with `--open-cloud-key`, which would store it in your agent's configuration file.
Every variable is listed in [docs/configuration.md](docs/configuration.md).

## Security

Lumen keeps upstream's local bridge with token authentication and hardens several paths around it.
Playtest clients only run requests the server peer issued through single use tickets, so game scripts cannot borrow plugin level Luau.
Proxy instances check that the primary holds the token before sending it, launch overrides need an explicit opt in, and file writes can be confined to one folder.
Details and how to report a problem are in [SECURITY.md](SECURITY.md).

## Documentation

| Topic | Guides |
| --- | --- |
| Using Lumen | [Install](docs/install.md) · [Tool reference](docs/tools.md) · [Configuration](docs/configuration.md) · [Large inputs](docs/large-inputs.md) · [Creator Store assets](docs/creator-store-assets.md) |
| Working on Lumen | [Development](docs/development.md) · [Building from source](docs/building-from-source.md) · [Token budgets](docs/token-efficiency.md) · [API migration](docs/deprecated-api.md) |
| History | [Lumen releases](docs/releases.md) · [Upstream changelog](CHANGELOG.md) |

## License

Lumen is MIT licensed.
[LICENSE](LICENSE) also carries the notice of robloxstudio-mcp, the project Lumen is forked from.
