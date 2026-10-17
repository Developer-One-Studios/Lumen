# Lumen tool reference

Lumen has 75 tools.
This page covers the 26 that Lumen adds and the upstream tools it changes.
The other upstream tools are listed with their full schemas in `packages/core/src/tools/definitions.ts`, and agents can read the workflow guides at the `lumen://tool-guides` resource.

Every tool that talks to Studio accepts `instance_id` to pick a Studio process when several are connected.
Peers are named `edit`, `server` and `client-1`, `client-2` and so on.
Paths use the canonical form tools return, such as `game.Workspace.Map["Spawn Pad"]`, and `PlayerGui.Main.Play` works for a client's GUI.

## Performance

### `perf_stats`

Samples frame time, GPU time, draw calls, triangles, Heartbeat, physics, network traffic and ping on each peer.

- `target`: `all` (default), `edit`, `server` or `client-N`.
- `duration_ms` and `sample_ms`: sampling window and interval.
- `remotes` and `top_remotes`: also count calls and bytes per RemoteEvent and return the busiest.

Start here when someone says "it lags".
It tells you whether the cost is rendering, scripts, physics or the network, and on which peer.

### `lag_audit`

Ranks the content that costs the most: particle fill, shadow casting lights, heavy models, precise collision, unique meshes and streaming settings.

- `root`: subtree to scan, `game.Workspace` by default.
- `top`: rows per ranked list.

### `profile_toggle`

Measures what one category really costs by sampling, switching it off, sampling again and restoring it.

- `category`: `particles`, `shadows`, `lights`, `post_effects`, `gui` or `instance`.
- `path`: the instance to remove when `category` is `instance`.
- `target`: `client-1` by default.

Use it to turn "maybe it's the particles" into a number.

## Memory

### `leak_check`

Runs an action repeatedly and reports what keeps growing between rounds: memory tags, instance counts per class, instances detached from the DataModel, or values you watch.
Detached instances are counted per script that created them and per class, so a leak names its source, such as `unparented:ServerScriptService.Spawner:Model`.
Roblox refreshes memory tags and `Stats.InstanceCount` only every few seconds, so keep `settle_ms` near its 1500 default when you rely on them.

- `action`: Luau run in the game VM once per round, such as spawning and despawning an enemy.
- `iterations` and `settle_ms`: rounds and the wait before each measurement.
- `watch`: Luau number expressions read every round, such as the size of a cache table.
- `target`: `server` by default.

## Playtest automation

### `playtest_scenario`

Runs a whole playtest script in one call and returns one report.
It starts a solo playtest when none is running and stops it afterwards unless `keep_running` is set.

Each step has exactly one kind:

| Step | Does |
| --- | --- |
| `key` | Taps a key on the client, with `hold_s`. |
| `text` | Types into the focused TextBox. |
| `click` | Clicks a GuiObject path or `{x, y}` viewport pixels. |
| `walk_to` | Walks the character to an instance path or a position. |
| `wait` | Pauses for seconds. |
| `wait_for` | Polls a Luau condition until it is true. |
| `expect` | Asserts a Luau condition, counted as an assertion. |
| `run` | Runs Luau once and keeps the returned value. |
| `watch` | Samples Luau expressions over `duration_ms`. |
| `screenshot` | Captures the client's viewport with a label. |

Steps can set `client`, `peer`, `vm`, `timeout_s` and `label`.
`stop_on_failure` ends at the first failed step, which is the default.
The report lists each step's result and timing, the assertions passed and failed, deduplicated errors and warnings from every peer, and screenshot sizes with the scale for mouse coordinates.
Screenshots default to `max_width` 1280.

### `wait_for`

Blocks until a Luau condition is true or a log line appears, polling inside Studio.

- `condition`: an expression, or a body with `return`.
- `log`: a substring or `/regex/` to wait for in runtime logs instead.
- `peer`, `vm`, `timeout_s` and `interval_ms`.

A condition still yielding when time runs out is reported with a hint to use `FindFirstChild`, and errors name the line inside the condition.

### `watch`

Samples up to 10 Luau expressions over time and returns a series and a summary for each.

- `expressions`: a map from names to expressions, such as `{ "speed": "hrp.AssemblyLinearVelocity.Magnitude" }`.
- `action`: Luau started in the same VM when sampling begins, such as firing an ability.
- `duration_ms`, `interval_ms`, `peer` and `vm`.

Good for cooldowns, velocities, health over time and anything else that changes during an action.

### `navigate_character`

Walks the local character with pathfinding.

- `position` or `path`: a world point, or a BasePart, Model or Attachment.
- `speed_multiplier` and `timeout_s`.

An instance target counts as reached within 4 studs of its bounding box, so walls and tall parts work.
The walk tries the top of the target first, so pads and checkpoints are stepped on and fire Touched, then the ground beside it.
A character that makes no progress for a second gets one jump and then one fresh path.
If it is still stuck the result says `stopped: "stalled"` and `blocked` names the waypoint, the part in front with its CanCollide and collision group, and the Humanoid state.

### `run_tests`

Starts a solo playtest, waits for the place's test runner summaries in the logs, and collects pass, fail and error lines.

- `summary_pattern` and `fail_pattern`: regexes for the runner's output.
- `expected_summaries`, `mode`, `timeout_s` and `keep_running`.

## Edit mode safety

### `checkpoint`

Snapshots the place before an experiment.

- `action: "create"` snapshots `roots`, the main services by default. Rojo synced subtrees are skipped, because the files on disk are their source of truth.
- `action: "changes"` lists every added, removed and modified instance and property since.
- `action: "revert"` restores everything, or only `paths`, as one undo step named "MCP: revert checkpoint". References such as welds and ObjectValues pointing between subtrees are repointed to the restored copies.
- `action: "list"` and `action: "drop"` manage checkpoints.

Snapshots live in the plugin's memory and disappear when Studio closes.
A revert first saves earlier edits made outside an undo recording, such as `execute_luau` changes, as their own undo step, so Ctrl+Z on the revert never takes them along.
On a 125,000 instance place, create takes about 0.7 seconds and revert about 2 seconds.

### `multi_edit`

Applies several text edits to one script as one atomic, undoable step, or creates the script when it is missing.
When an `old_string` does not match exactly, the edit is retried ignoring whitespace and applied only if that match is unique.

## Moving content

### `copy_instances`

Copies instances from one open place into another, or within one place, without writing a file.

- `instance_paths`: what to copy from the source place.
- `parent_path`: where to put the copies in the destination place.
- `source_instance_id`: the Studio process to copy from. Without it the copy stays inside `instance_id`.
- `name`: a new name for the copy when copying one instance.

The copy lands as one undo step named "MCP: copy instances" in the destination.
Each copy reports `same_named_siblings` when its parent already has children with its name, since a path then resolves to the first of them.

### `move_instances`

Moves or turns Models, parts and Folders as one undo step named "MCP: move instances".

- `offset`: studs to move by.
- `to`: where the centre of everything moved should end up, instead of `offset`.
- `rotation`: degrees to turn by, applied before moving.
- `origin`: the point to turn about, the bounding box centre by default.

Welded parts stay together, Models with a PrimaryPart follow it, and Models without one keep their pivot in the same place relative to their parts.
The result has the bounding box before and after, so the move can be checked without a screenshot.

### `inspect_rbxm`

Reads an .rbxm file without importing it, from a path, URL or base64 like `import_rbxm`.
The file is read into memory in the edit plugin and never parented, so the place and its undo history stay untouched.

- `root`: a slash path inside the file to start at, such as `allstuff/Juudara`.
- `depth` and `limit`: how many levels and instances are listed. Deeper levels are summed up by class.
- `assets`: also list every asset id the file uses, by property, with how many instances use each.
- `match_in`: a place path, such as a folder of unit models. Each item of the file is matched against its children by the meshes and mesh textures they share.

Effect textures are left out of matching, because many unrelated effects reuse them.

## Level and UI QA

### `spatial_check`

Checks 3D layout with numbers instead of eyeballing screenshots.

| Mode | Reports |
| --- | --- |
| `audit` | Floating objects with the gap below them, overlaps, parts buried in other parts, unanchored assemblies that will fall, tiny parts and far outliers. |
| `gaps` | For `platforms` in jump order, whether each jump is possible with the place's jump height, gravity and walk speed, and by what margin. |
| `reach` | Whether pathfinding can get from `from` to `to`, with length, jumps and status. |
| `measure` | Distances, gaps, overlap and ground clearance between two parts or points. |

`character` overrides the walk speed and jump height.
Parts of one Humanoid rig are never reported as buried in each other.
A full audit of 20,000 parts takes about 2 seconds.

### `ui_audit`

Switches the device simulator through phone, tablet and PC presets, measures the GUI, and puts the simulator back exactly as it was.

- `devices`: preset ids, optionally with `@Portrait`, `@LandscapeLeft` or `@LandscapeRight`.
- `checks`: `offscreen`, `clipped`, `overlap`, `text_overflow`, `small_text`, `small_touch` and `under_topbar`.
- `root`: a GUI subtree. During a playtest it defaults to the client's PlayerGui, otherwise StarterGui.

Issues found on every device are layout bugs, and issues on some devices are responsive bugs.
Roblox's own touch controls are skipped.
It refuses to start while a custom simulator device is active, because the simulator API cannot switch back to it.

### `inspect_gui`

Lists a client's GUI objects with their viewport rectangles, text, visibility and clickability, or hit tests a viewport point.
Rectangles use the same pixels as screenshots and mouse input.

## Screenshots

### `capture_views`

Takes screenshots from chosen camera positions and restores the camera afterwards.

- `views`: up to 8 placements, each with `camera_position`, optional `look_at` and a `label`.
- `clients`: `"all"` or a list of clients, to shoot each view on each client during a playtest.
- `max_width`, `format` and `quality`.

On a client the view is held every frame and put back whenever a game script moves the camera, so custom camera scripts cannot spoil the shot.
A view that still drifted carries a warning.
It is not offered in the read only Inspector edition, because it moves the camera.

### `record_viewport`

Records the viewport that input tools target for a few seconds and returns a grid of evenly spaced frames, each labelled with its time since the start.

- `duration_s`: 0.5 to 30 seconds, 5 by default.
- `fps`: 1 to 30 grabs a second, 15 by default.
- `frame_width`: width of each saved frame, 480 by default.
- `sheet_frames`: how many frames the grid shows, 24 by default.
- `save_frames`: every frame is saved as a PNG in the artifact folder unless this is false.

It reads the Studio window through the host OS, like the screenshot fallback: straight from the X server on Linux, a few milliseconds a frame, and through the host capture helper on Windows and macOS, where the frame rate is low.
Studio may sit behind other windows but must not be minimized, since a minimized window has no pixels.
`distinctFrames` and `newFramesPerSecond` show how often Studio drew a new frame, which is often about 15 a second when Studio is not focused.

## Rojo

### `resolve_source`

Maps Studio paths to files and files to Studio paths.
`project_root` names the Rojo project folder and sticks for later calls.
When there is no `sourcemap.json`, Lumen builds the map in memory with `rojo sourcemap` and never writes into the project.

With a map, Studio locations in logs, errors and breakpoint hits are followed by `[file:line]`, and script edit tools refuse scripts that Rojo syncs.

### `verify_sync`

Answers "is Studio running what is on disk?" for every peer.

- `peers`: `all` (default), `edit`, `server` or `client-N`.
- `paths`: limit the check to some scripts.
- `regenerate`: rebuild the sourcemap first, after adding or moving files.

It hashes every synced file and compares it with each peer's source, then explains the result: edit lagging while the running game matches, old code running everywhere, or a playtest that started before the sync.
Scripts that game code moved at runtime, the way Cmdr moves its commands, are found by name and contents and listed under `moved_scripts`.

## Diagnostics

### `get_errors`

Returns a deduplicated digest of errors and warnings from every peer, each with a count, peers, first and last time and the stack.
A bare call continues where the previous call stopped, and `since: "all"` reads everything still buffered.
`exclude` drops messages containing any of the given texts before grouping, so noise such as asset permission errors does not use up the limit.

### `get_playtest_logs`

Reads the script output of a playtest that already ended, from Studio's own log files, which keep every playtest's output after its DataModels are gone.
`list` shows recent playtests with their place, times, client count and error counts, and `playtest` picks one, 1 being the latest.
`level`, `filter`, `exclude` and `tail` narrow the lines.
Lines carry no server or client label, and `ROBLOX_STUDIO_LOG_DIR` overrides where the logs are read from.

### `replication_diff`

Compares one instance between the server and each client: properties, attributes and optionally children.
Use it when a client sees something different from the server.

### `fuzz_remotes`

Fires malformed and spammed payloads at RemoteEvents, and optionally RemoteFunctions, from a client, then collects the server errors each remote caused.
Use it in a playtest to find handlers that trust the client.

## Cloud and assets

### `cloud_luau`

Runs Luau on a Roblox cloud server against a published place version, without Studio.

- `script` or `script_file`, and `timeout_s` up to 300.
- `place_id` and `universe_id`, which default to the open place, and `place_version`.
- `summary_pattern` and `fail_pattern` to parse test output.
- `task_path` to read back an earlier run.

The result has the state, return values, logs, parsed pass and fail counts, and failure lines.
It runs the last published version, not what is open in Studio.
Needs `ROBLOX_OPEN_CLOUD_API_KEY` with the luau execution scopes for that experience.

### `upload_assets`

Uploads many audio, model, image and animation files with retries and a manifest.

- `files`, or `directory` with `extensions` and `recursive`.
- `asset_type: "Animation"` uploads `.rbxm` and `.rbxmx` files as animations instead of models.
- `animations_from`: Studio paths, such as a rig's `AnimSaves`. Every KeyframeSequence and CurveAnimation under them is exported and uploaded as an animation, so animations never need publishing one by one from the Animation Editor.
- `group_id` or `user_id`, `name_prefix` and `description`.
- `create_in`: a Studio path that gets one Sound per audio file and one Animation per animation, pointing at the new ids, as one undo step.
- `concurrency`, up to 6.

Animations a group's game uses must belong to that group, so upload them with `group_id`.
An upload whose status cannot be confirmed is reported as `unconfirmed` with its operation id and never retried, because a retry could create a duplicate asset.
The manifest is written under the artifacts folder.

### `audit_assets`

Finds animations, audio and other assets that will fail to load in live servers, such as animations and audio not owned by the experience's owner and assets that no longer exist.

### `datastore_read`

Lists DataStores and keys, and reads single entries, through Open Cloud.
It never writes.

## Changed upstream tools

| Tool | Change |
| --- | --- |
| `execute_luau`, `eval_server_runtime`, `eval_client_runtime` | `timeout_s`, 25 seconds by default. Code still yielding then is cancelled where it waits, and the error quotes Roblox's "Infinite yield possible" warning. Lines before the yield have already run. |
| `edit_script_lines` | Retries a failed exact match ignoring whitespace, and refuses when that match is not unique. |
| `capture_screenshot` | `max_width` downscales and reports the scale for mouse input. `clients` shoots several playtest clients. It never moves the camera, which `capture_views` does. |
| `simulate_mouse_input` | `instance_path` clicks a GuiObject on a point no other button covers, and refuses when it is covered everywhere. |
| Script edit tools | Refuse scripts that Rojo syncs, waiting for the first sourcemap build when one is running. Set `ROBLOX_ALLOW_SYNCED_EDITS=1` to allow it. |
| `manage_instance` | Launch overrides that can run any program need `ROBLOX_STUDIO_ALLOW_LAUNCH_OVERRIDES=1`. |
| `export_rbxm`, `import_rbxm` | A relative path is written to and read from `ROBLOX_MCP_ARTIFACT_DIR` when it is set, so the same name works for both. |
