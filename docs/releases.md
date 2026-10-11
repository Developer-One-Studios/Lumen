# Lumen releases

## 1.0.0

The first team release, based on robloxstudio-mcp 3.2.0.
Every tool below was tested against a live Roblox Studio, including a 127,000 instance place and real Open Cloud calls.

### New tools

- Performance: `perf_stats`, `lag_audit` and `profile_toggle`.
- Memory: `leak_check`.
- Playtests: `playtest_scenario`, `wait_for`, `watch`, `navigate_character` and `run_tests`.
- Edit safety: `checkpoint` and `multi_edit`.
- Level and UI QA: `spatial_check`, `ui_audit` and `inspect_gui`.
- Screenshots: `capture_views`.
- Rojo: `resolve_source` and `verify_sync`.
- Diagnostics: `get_errors`, `replication_diff` and `fuzz_remotes`.
- Cloud and assets: `cloud_luau`, `upload_assets`, `audit_assets` and `datastore_read`.
- `upload_assets` also uploads animations, either `.rbxm` files or every clip under a Studio path such as `AnimSaves`, and creates the matching Animation instances.

See [tools.md](tools.md) for what each one does.

### Benchmark

- `npm run bench` runs seven tasks against a live Studio with the upstream tools and with Lumen's, and reports turns, time, data and the code an agent writes.
- Lumen halves agent time across them, from 159 s to 80 s, and only Lumen finds the planted leak. See [benchmark.md](benchmark.md).

### Changed tools

- `execute_luau`, `eval_server_runtime` and `eval_client_runtime` take `timeout_s` and cancel code that never stops yielding, naming the stuck `WaitForChild`.
- `edit_script_lines` and `multi_edit` match through whitespace differences.
- `capture_screenshot` takes `max_width` and `clients`, and leaves camera placement to `capture_views`.
- `simulate_mouse_input` clicks a GuiObject by path on a point no other button covers.
- Script edit tools refuse scripts that Rojo syncs, and logs, errors and breakpoint hits show `[file:line]`.
- Multiplayer client screenshots that Studio cannot read back now fail with the reason, where upstream returned an unrelated cached image.

### Security

- Playtest clients run requests only with a single use ticket issued by the server peer, which closes upstream's path for game scripts to run plugin level Luau.
- A conflicting `/ready` no longer reveals the existing peer's id.
- Proxy instances connect to the exact address the primary binds, and send the token only after the primary proves it holds it.
- `manage_instance` launch overrides that can run any program need `ROBLOX_STUDIO_ALLOW_LAUNCH_OVERRIDES=1`. Normal launches are unchanged.
- `ROBLOX_MCP_ARTIFACT_DIR` confines every file tools write, symlinks included.
- `import_rbxm` refuses URLs that resolve to loopback or private addresses on every redirect.
- The plugin only remembers loopback server URLs and no longer checks npm on every Studio start.
- The plugin installer uses only the build from your checkout and never downloads one.

### Linux

- The plugin installer finds Studio's Plugins folder inside Vinegar prefixes, Flatpak or native, and `$WINEPREFIX`.
- `capture_screenshot` can fall back to capturing the Studio window through X11.

### Identity

- Renamed to Lumen: packages `lumen-mcp`, `lumen-mcp-inspector` and `lumen-mcp-core`, plugins `LumenPlugin.rbxmx` and `LumenInspectorPlugin.rbxmx`, the Lumen toolbar, and the `lumen://tool-guides` resource.
- New default port 58761 and new plugin settings and bridge names, so Lumen runs next to upstream and the official Roblox Studio MCP.
- Packages are private and never published to npm.
