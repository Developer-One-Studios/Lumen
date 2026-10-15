import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceTemplate,
} from '@modelcontextprotocol/server';
import { DOC_CATEGORIES, fetchRobloxDoc, isDocCategory, DocNotFoundError } from './roblox-docs.js';
import { FORK_FEATURES } from './tools/fork/index.js';

export const TOOL_GUIDE_URI = 'lumen://tool-guides';

export const TOOL_GUIDE_MARKDOWN = `# Roblox Studio MCP tool guide

Tool descriptions explain selection. Input schemas explain arguments. This guide holds shared workflows and safety notes.

## Connection and paths

- Use canonical DataModel paths returned by the tools. Paths usually start with game.
- Call get_connected_instances when more than one Studio process may be connected. Pass either a top-level Instance ID or a multiplayer group's role-suffixed Instance ID as instance_id on later calls.
- Use get_place_info for the active place identity and settings.

## Discovery and edit work

- Use get_project_structure for a bounded hierarchy, search_objects for an instance query, and grep_scripts for source text.
- Use get_instance_properties and get_attributes after locating an instance.
- Use execute_luau for custom traversal, bulk edits, and work that would otherwise need many tool calls. It runs through the Studio plugin context.
- Use set_properties when several known properties on one instance can be updated in one request.
- Request stages are queued, dispatched, executing (plugin handler entered), and response_delivery (handler returned or admission rejected). executionOutcome is separate from waiter state and delivery outcome, and handler observations do not prove user Luau instructions ran. A waiter timeout is not an execution deadline or rollback. Neither missing progress nor connection loss proves completion.

## Selection and viewport

- Use selection with action=get when the user's Studio selection should define the scope.
- Use action=set with instance paths to replace, add to, or remove from the selection. An empty paths array in set mode clears it.
- Use action=view with a BasePart or Model path to frame it, or omit path to frame exactly one selected BasePart or Model. Empty, multiple, or unsupported selections require an explicit target or a changed selection. The original camera type is restored after framing, including on failure. The current viewing direction is preserved unless from or angleY overrides it. padding below 1 crops closer and above 1 pulls back.
- For visual proof, change the instance, frame it with selection, then call capture_screenshot.

## Script changes

- Read the relevant source with get_script_source before changing it.
- Use edit_script_lines, insert_script_lines, or delete_script_lines for focused changes with known line numbers.
- Use set_script_source only when replacing the whole script.
- Use find_and_replace_in_scripts with dryRun first when a replacement may affect several scripts.

## Playtests and runtime Luau

Start solo_playtest or multiplayer_playtest before targeting a live server or client. Stop the playtest when the scenario is complete.

execute_luau runs through the Studio plugin. eval_server_runtime and eval_client_runtime run inside a live game VM and share that VM's require cache with game scripts. Use the eval tools when module state or the runtime Script or LocalScript environment matters.
All three cancel code still yielding after timeout_s (25 s by default) and name the WaitForChild that never resolved. Lines before the yield have already run. Prefer FindFirstChild, or WaitForChild with a timeout, for anything that may not exist.

Read output with get_runtime_logs. Reuse nextCursor as cursor for one Instance, or nextCursorByInstance as cursor_by_instance for a Multiplayer Group, instead of requesting the full process streams again.

- Each Peer VM retains approximately 64 KiB of message text, rather than a fixed message count. Reads do not consume or clear the buffer; incoming messages evict old entries.
- totalDropped sums lifetime eviction counts from successfully read Peers. It counts messages evicted, not messages missed by this caller, and may decrease when Peers fail, disconnect, or reload.
- For successfully read Peers, nextCursor advances past all captured entries, including those omitted by filter or tail. It is a continuation watermark, not pagination through omitted results; continuing from it will not return those entries.

## Simulation and input

- Inspect current settings with get_simulation_state before changing them.
- Apply network conditions with set_network_profile. Roblox caps packet loss at 0.5 percent.
- Inspect built-in device IDs with get_device_simulator_state, then apply one with set_device_simulator or compare several with capture_device_matrix.
- Clear temporary network and device settings with reset_simulation_state after a scenario.
- Capture the viewport with capture_screenshot before simulate_mouse_input so the pixel coordinates match. Keyboard input should target a live client when game input is under test.

## Debugging and profiling

- breakpoints requires Studio's Script Editor API beta feature. Logpoints normally use continue_execution=true. A pausing breakpoint with continue_execution=false needs an OnStopped resume handler.
- breakpoints clear removes only MCP-created breakpoints unless clear_all is true. clear_all also removes user-created breakpoints.
- capture_script_profiler ranks Luau functions by CPU time. Use output_path when the raw capture is needed.
- capture_micro_profiler attributes frame time across engine and game work. Its rows are inclusive or cumulative views, so do not sum them as disjoint totals.
- MicroProfiler records frames only while Studio renders. Studio stops rendering when the display turns off or Studio is minimized, and the capture then fails with micro_profiler_no_frames.
- Use baseline_path or baseline for before-and-after MicroProfiler comparisons.
- Use get_memory_breakdown for memory categories and get_scene_analysis for instance, script, triangle, animation, or audio cost.

## Creator Store and generated assets

Search with search_assets, inspect a shortlist with get_asset_details or get_asset_thumbnail, and preview untrusted content with preview_asset before insert_asset.

Studio must allow third-party asset loading for public third-party previews and insertion. preview_asset scans the complete hierarchy without returning script source. insert_asset removes every LuaSourceContainer and PackageLink before parenting the remaining content, then scans again before insertion.

generate_model stages generated content under ServerStorage for review. upload_asset sends an explicit local file to the chosen Roblox user or group.

## Monetization

manage_monetization lists, reads, creates, and updates developer products and game passes through Roblox Open Cloud. ROBLOX_OPEN_CLOUD_API_KEY needs developer-product:read and developer-product:write, or game-pass:read and game-pass:write, with the experience added to the key. universe_id defaults to the connected Studio place; an unpublished place has no universe.

- Roblox cannot delete developer products or game passes. To retire one, update it with for_sale=false.
- create keeps new items off sale unless for_sale=true, which also needs a price.
- create refuses a name that already exists in the universe and returns the existing item. If a create times out, list the universe before retrying.
- update changes only the arguments supplied, then reads the item back.
- image_path uploads a local PNG, JPEG, or BMP icon. Roblox shows icons at 512x512 inside a circle, so keep details away from the corners.

## RBXM files

- export_rbxm writes selected instances to an explicit local path. It can read the edit DataModel or a live server DataModel.
- import_rbxm accepts exactly one local path, HTTP or HTTPS URL, or base64 source. It parents imported instances under the supplied canonical path.

## Studio processes

manage_instance can launch, inspect, and close Studio or list published place revisions. A process-identity launch returns a suspended launch that must be authorized and completed explicitly. Keep its launch_id until the connection has an instance_id.

## Rojo projects

- With a sourcemap.json in or above the server's working directory, or after resolve_source project_root, Studio locations in logs, errors, and breakpoint hits are followed by [file:line].
- set_script_source, edit_script_lines, insert_script_lines, delete_script_lines, multi_edit, and find_and_replace_in_scripts refuse scripts Rojo syncs, because the next sync overwrites Studio edits. Edit the file on disk instead.
- Players.<name>.PlayerScripts, PlayerGui and Backpack map back to their Starter containers. Character scripts in Workspace do not, because a player cannot be told apart from an NPC by path.
- A missing or stale map (older than the project file or ROBLOX_SOURCEMAP_MAX_AGE_S, 300 s by default) is rebuilt in memory with rojo sourcemap and never written into the project. verify_sync regenerate=true forces a rebuild after adding or moving files.

## Finding lag

- perf_stats samples frame time, CPU and GPU render time, draw calls, triangles, heartbeat, physics step, network rates, and ping on each peer. remotes=true also counts calls and bytes per RemoteEvent; it connects a listener to every remote, so a remote with no game listener yet would deliver its queued events to it, run it after game scripts have started.
- Studio frame times on a fast desktop understate player lag. Compare counts (draw calls, triangles, live particles, unanchored parts) and relative changes instead of absolute FPS.
- lag_audit ranks particle emitters by estimated screen fill, shadow-casting lights, heavy top-level models, precise collision, unique meshes, and streaming settings, and lists heuristics that crossed a threshold. Scan a running client to see what it actually streamed in.
- profile_toggle measures a category by sampling, switching it off, sampling again, and restoring it in the same call. It only runs on playtest peers. category=instance unparents the instance for the measurement, which can disturb scripts that watch it.
- High ping in a live game is often a slow server frame; check heartbeatHz and HeartbeatTimeMs on the server before blaming the network.

## Leaks

- leak_check runs action in the game VM for each iteration, then measures memory tags, instance counts by class, unparented instances (needs Scene Analysis in Studio Beta Features), and optional watch expressions such as #require(game.ReplicatedStorage.Cache).entries.
- Unparented instances are counted per creating script and class, as unparented:<script path>:<class>, which points straight at the code holding them.
- Memory tags and instanceCount refresh only every few seconds, so a short settle_ms can hide growth in them.
- The first iteration warms caches and is excluded. Only metrics that grow steadily are reported.

## GUI and characters

- inspect_gui rows are [path, class, x, y, w, h, z, displayOrder, text, clickable, visible] in viewport pixels, the same space as capture_screenshot and simulate_mouse_input.
- navigate_character walks with PathfindingService on the client and falls back to a straight MoveTo when no path exists. An instance target counts as reached within 4 studs of its box.
- A character that makes no headway for a second gets one jump and then one fresh path. If it is still stuck the result has reached false, stopped "stalled" and blocked with the waypoint, the part in front of it (with CanCollide and collision group, since pathfinding can route through parts the character still collides with) and the Humanoid state. Otherwise stopped says "timeout" or "died".

## Security testing

- fuzz_remotes fires malformed values, oversized strings and tables, NaN vectors, random buffers, and spam from a client, the way an exploiter would, then collects server errors per remote. Blink and Zap remotes receive raw buffers, which tests their decoders.
- It only runs in a playtest, but handlers can still change server state during it.

## Roblox reference material

Use get_roblox_docs for official engine and Luau reference pages. Use get_roblox_skills to list or read Roblox-authored Studio Assistant skills when their longer guidance is useful.
`
  + FORK_FEATURES.flatMap((feature) => (feature.guide ? [`\n${feature.guide.trim()}\n`] : [])).join('');

/** Official Roblox reference templates shared by the HTTP and stdio servers. */
export function registerResourceHandlers(server: McpServer): void {
  server.registerResource(
    'Roblox Studio MCP tool guide',
    TOOL_GUIDE_URI,
    {
      description: 'Detailed workflows and safety notes for Roblox Studio MCP tools.',
      mimeType: 'text/markdown',
    },
    async (resourceUrl) => ({
      contents: [{
        uri: resourceUrl.href,
        mimeType: 'text/markdown',
        text: TOOL_GUIDE_MARKDOWN,
      }],
    }),
  );

  const templates = [
    ['classes', 'className', 'Roblox class documentation', 'Official Roblox engine class reference.'],
    ['enums', 'enumName', 'Roblox enum documentation', 'Official Roblox engine enum reference.'],
    ['datatypes', 'dataTypeName', 'Roblox datatype documentation', 'Official Roblox engine datatype reference.'],
    ['libraries', 'libraryName', 'Roblox library documentation', 'Official Roblox Luau library reference.'],
    ['globals', 'globalsPage', 'Roblox globals documentation', 'Official Roblox globals reference.'],
  ] as const;

  for (const [category, variable, name, description] of templates) {
    server.registerResource(
      name,
      new ResourceTemplate(`robloxdocs://${category}/{${variable}}`, { list: undefined }),
      { description, mimeType: 'text/markdown' },
      async (resourceUrl) => {
        const uri = resourceUrl.href;
        const match = uri.match(/^robloxdocs:\/\/([^/]+)\/([^/]+)$/);
        if (!match || !isDocCategory(match[1])) {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource ${uri} not found`);
        }

        const [, docCategory, rawName] = match;
        const docName = decodeURIComponent(rawName);
        try {
          const content = await fetchRobloxDoc(docCategory, docName);
          return {
            contents: [{ uri, mimeType: 'text/markdown', text: content }],
          };
        } catch (error) {
          if (error instanceof DocNotFoundError) {
            throw new ProtocolError(
              ProtocolErrorCode.InvalidParams,
              `Resource ${uri} not found. Names are case-sensitive PascalCase; valid categories: ${DOC_CATEGORIES.join(', ')}.`,
            );
          }
          console.error(`[resource:${uri}]`, error);
          throw new ProtocolError(ProtocolErrorCode.InternalError, `Failed to read ${uri}.`);
        }
      },
    );
  }
}
