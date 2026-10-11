# Security

## Reporting a problem

Report suspected vulnerabilities to the Lumen maintainer directly and privately, not in a shared channel or an open issue.
Include the Lumen version, what an attacker could do, how to reproduce it, and any workaround you know.
Leave out secrets such as Open Cloud keys and cookies, and unrelated game content.

If the problem also affects upstream robloxstudio-mcp, the maintainer coordinates a private report to its author before anything is shared further.

## Supported versions

Fixes go into the latest Lumen release on the team repository.
Update by following [docs/install.md](docs/install.md#updating).

## Security model

Lumen gives an AI agent a lot of control over Roblox Studio, so it is built to stay local and to give game content no new powers.

**Only your machine can reach it.**
The bridge listens on `127.0.0.1`, and HTTP endpoints that can run tools require the token stored in `~/.lumen-mcp/auth-token`.
The Studio plugin registers without that file and gets its own token for its WebSocket, which cannot call tools directly.
The plugin only remembers and reconnects to loopback addresses.

**Game code cannot borrow plugin powers.**
During a playtest, requests for a client travel through plugin settings as single use tickets that the server peer issues.
Game scripts cannot read plugin settings, so a Script in the place cannot make the client run Luau at plugin level.
Upstream robloxstudio-mcp let any server Script do this, and Lumen closes it.

**Tools stay inside their lane.**

- `manage_instance` cannot choose the Studio executable, its environment or its working directory unless the server runs with `ROBLOX_STUDIO_ALLOW_LAUNCH_OVERRIDES=1`.
- With `ROBLOX_MCP_ARTIFACT_DIR` set, every file a tool writes or reads as a baseline must stay inside that folder, symlinks included.
- `import_rbxm` refuses URLs that resolve to loopback, private or link local addresses, on every redirect.
- Script edit tools refuse scripts that Rojo syncs from disk, so the files stay the source of truth.
- `datastore_read` never writes, and `cloud_luau` only touches what the script you run touches.
- Code run through `execute_luau` and the eval tools is cancelled at its `timeout_s`, so a stuck call cannot resume and change the place later.

**A second server is checked before it trusts the first.**
A server started while another one is running joins it as a proxy.
It connects to the exact address the primary binds, and sends the token only after the primary proves it holds the same token.

**Nothing is fetched from public registries.**
Lumen is private and never published to npm, and the plugin installer only uses the plugin built in your checkout.
Never install a public npm package named like Lumen.

## Secrets

- Keep `ROBLOX_OPEN_CLOUD_API_KEY` in your environment, not in the `--open-cloud-key` flag, which ends up in your agent's configuration file.
- Give each key only the scopes and experiences it needs. The scopes per tool are listed in [docs/install.md](docs/install.md#4-optional-open-cloud-key).
- Lumen never reads your Roblox cookie unless you set `ROBLOSECURITY` yourself, and nothing in the team setup needs it.

## Known limits

- `import_rbxm` checks a URL's addresses before fetching, but the fetch resolves the name again, so a DNS rebinding host can still reach a local service.
- Tickets for multiplayer clients cross Studio processes through plugin settings, and a client waits up to 2 seconds for one before refusing.
- Anyone who can run commands as your user can read the bridge token file, as with any local developer tool.
