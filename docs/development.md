# Working on Lumen

This guide is for teammates who change Lumen itself.
For building and installing, see [install.md](install.md).

## Layout

| Path | Contents |
| --- | --- |
| `packages/core` | The server: HTTP and WebSocket bridge, tool catalog, tool implementations, Open Cloud clients. |
| `packages/lumen-mcp` | The full edition's entry point and CLI. |
| `packages/lumen-mcp-inspector` | The read only edition's entry point and CLI. |
| `studio-plugin` | The Studio plugin in roblox-ts, compiled to Luau and packed into `LumenPlugin.rbxmx`. |
| `scripts` | Plugin assembly, packaging and the live Studio test harness. |
| `tests` | Live Studio integration tests and runner self tests. |

## Architecture

The server and the plugin talk over a local HTTP and WebSocket bridge on port 58761.
Each Studio DataModel the plugin runs in, edit, server and every client, connects as a peer, and tools route requests to peers by role.
A second server started while one is running joins it in proxy mode instead of fighting over the port.

Most Lumen tools are thin TypeScript handlers around generated Luau:

- `packages/core/src/tools/fork-luau.ts` builds Luau snippets. `withArgs(body, args)` passes arguments as JSON decoded from a long string, never spliced into code, and adds a prelude with `parsePath`, `resolve`, `pathOf`, `round`, `finite` and `readable`.
- Snippets run through `/api/execute-luau` in the plugin VM, or `/api/eval-runtime` in the game VM, which shares the game's `require` cache.
- `_G` persists between calls in one DataModel's plugin VM, which is how state such as checkpoints and camera holds survives between calls.
- `packages/core/src/tools/fork-tools.ts` holds the first group of composite tools and shared helpers such as `luauValue`, `toolText`, `parseResult`, `clamp`, `sourcemaps` and `assertNotSynced`.
- `packages/core/src/tools/fork/` holds feature modules. Each exports a `ForkFeature` with `definitions`, `handlers` and optional `instructions` and `guide`, and `fork/index.ts` registers it so the catalog, handler table, server instructions and tool guide pick it up.
- A handler receives `(tools, body, context)`. `tools.forkHost` offers `peerTargets` and `requestPeer`, and `tools.fork.serializeCapture` queues anything that moves a camera or captures, because parallel captures would fight over the camera.

The plugin side lives in `studio-plugin/src/modules`.
`LuauExec.ts` wraps user Luau for `execute_luau` and the eval tools, captures output, maps error lines back to user code and enforces `timeout_s`.
`ClientBroker.ts` and `BrokerTickets.ts` run requests on playtest clients only when the server peer issued a matching single use ticket.

## Adding a tool

- Descriptions are one sentence about when to use the tool, at most 120 characters, and every argument has a description of at most 64 characters, nested ones included. Tests enforce both.
- Tools that route to Studio take `instance_id`, and the handler must read `body.instance_id`.
- A tool that runs generated Luau is `category: 'write'`, which keeps it out of the read only edition. When it changes nothing, give it `annotations` with `readOnlyHint: true`.
- Every Luau snippet gets a compile check with `luau-compile` (see `fork-luau.test.ts`), and handlers get tests with a fake host (see `fork-tools.test.ts`). Several features also run their Luau under the `luau` interpreter against a small mock of the engine.
- Return compact JSON. Large lists take a limit and say when they were cut.
- Throw `Error` with an actionable message. The runtime turns it into `tool_failed` with the message visible to the agent.
- Only use real Roblox APIs. When unsure, probe them read only in edit mode with `execute_luau` before relying on them.
- Anything that changes the place should be one ChangeHistory recording, so the user can undo it in one step.

## Tests

```sh
npm run typecheck
npm run lint
npm test -w packages/core
npm test
```

`npm test -w packages/core` runs the unit tests.
`npm test` adds the packaging, runner and port isolation suites.
The Luau checks need `luau` and `luau-compile` on `PATH` and are skipped without them.
Three upstream lifecycle tests in `smoke.test.ts` depend on timing and fail now and then on Linux.

The live Studio suites are described in [building-from-source.md](building-from-source.md) and [`tests/README.md`](../tests/README.md).

## Icons

The toolbar icons and the panel logo are drawn in `studio-plugin/assets/icons/render.sh`, which writes SVG and PNG files with `rsvg-convert`.
Studio only shows uploaded images, so after a change upload the PNGs as Decals to the team group with `upload_assets`, look up each Decal's image id in Studio, and update the ids in `scripts/build-plugin.mjs`.
The status dot sits in a transparent cut, so the icons read on both the light and the dark Studio theme.

## Testing against a live Studio

Your agent keeps running the server it started, so a rebuilt server is not used until you reconnect it.
Two faster ways to try a change:

- Start a second instance yourself, `node packages/lumen-mcp/dist/index.js`, and send it JSON RPC lines on stdin. It joins the running server in proxy mode and runs your new tool code against the live Studio.
- Reconnect the server from your agent, for example with `/mcp` in Claude Code.

Plugin changes need `npm run build:plugin` and a Studio restart.
Build throwaway fixtures under names starting with `MCPFixture` in an unsaved place, and delete them afterwards.
Never run captures that move the camera in parallel.

## Linux setup with confine

Lumen's own development on NixOS, with Studio under Vinegar, runs every build, test and server inside a confine sandbox defined in `sandbox.nix` next to this checkout.

| Attribute | Gives |
| --- | --- |
| `dev` | `sandboxed-bash`, `sandboxed-npm` and `sandboxed-node` that can write only this checkout, with `luau`, `luau-compile` and `rojo` on `PATH`. |
| `server` | The confined server: host network, a private home, this checkout and the Rojo projects read only, and only an artifacts folder writable. |
| `call` | `lumen-mcp-call <tool> '<json>' ...`, which runs tool calls through a proxy instance and saves images to `artifacts/live`. |

Build one with `nix build --impure -f sandbox.nix <attribute> --out-link result-<attribute>`.
None of this is needed on Windows or macOS.

## Upstream

Lumen tracks [Chrrxs/robloxstudio-mcp](https://github.com/Chrrxs/robloxstudio-mcp) 3.2.0.
`CHANGELOG.md` is upstream's history and stays untouched, and Lumen's own changes are in [releases.md](releases.md).
Internal names such as `RobloxStudioMCPServer` were kept on purpose, so upstream fixes still merge cleanly.
