# Benchmark

`bench/run.mjs` runs seven everyday Studio tasks twice against a live Studio.
The baseline arm uses only tools that robloxstudio-mcp 3.2.0 already had, which is also how an agent works with the official Roblox Studio MCP: `execute_luau`, playtest start and stop, key presses, screenshots and the output log.
The Lumen arm uses Lumen's dedicated tools for the same job.
Both arms must find the same planted problem.

## What is measured

| Column | Meaning |
| --- | --- |
| Tool calls | Each call is one agent turn: the model reads the last result, decides, and writes the next call. |
| Studio time | Wall time spent inside the tool calls. |
| Data returned | Text the agent has to read, which fills its context window. |
| Agent writes | Characters of arguments the agent has to generate, Luau code included. |
| Agent time | Tool calls × 5 s, plus what the agent writes at 50 tokens per second and 4 characters per token, plus Studio time. |
| Found the problem | Whether the arm surfaced the planted problem in every run. |

The 5 seconds per turn and 50 tokens per second are assumptions, and `LUMEN_BENCH_TURN_S` and `LUMEN_BENCH_TOKENS_S` change them.

## The baseline is generous

The baseline's Luau was written once, ahead of time, by someone who knew exactly what the fixtures contain.
A real agent would first explore the place, then write that code, and often fix it after a first failed run.
The baseline also only checks for the problems that were planted, while each Lumen tool checks for every problem it knows about.
So the savings below are a floor.

## Tasks

| Task | Planted problem | Baseline | Lumen |
| --- | --- | --- | --- |
| Find what makes a scene expensive | 12 particle emitters at 400 per second and 6 shadow casting lights | One `execute_luau` that samples frames and scans for emitters and lights | `perf_stats`, then `lag_audit` |
| Try an edit, list what changed, undo it | Moved, removed and added parts and a lighting change | Clone a backup, run the edit, diff by hand, restore the backup | `checkpoint` create, the edit, `checkpoint` changes and revert |
| Find floating parts and impossible jumps | A floating platform and a 20 stud gap | One `execute_luau` with raycasts and jump physics | `spatial_check` audit, then gaps |
| Check a menu on a phone, a tablet and a PC | A button pushed off the right edge, small text and small touch targets | `set_device_simulator` and an `execute_luau` scan per device | One `ui_audit` over three devices |
| Summarize errors and warnings | 15 copies of one error behind 20 numbered warnings | `get_runtime_logs` with the last 100 lines | `get_errors` |
| Check whether spawning enemies leaks memory | Each spawn keeps a destroyed enemy and 300 folders alive in a table | `eval_server_runtime` comparing `Stats` before and after six spawns | `leak_check` |
| Playtest: jump, check it, screenshot, collect errors | None, the jump has to be seen in the character's height | Start, wait for the character, press Space, sample height, screenshot, read logs, stop | One `playtest_scenario` |

## Results

Three runs per task on October 11, 2026, Roblox Studio under Vinegar on Linux, an empty place, Lumen 1.0.0.
Each cell reads baseline → Lumen.

| Task | Tool calls | Studio time | Data returned | Agent writes | Agent time | Found the problem |
| --- | --- | --- | --- | --- | --- | --- |
| Find what makes a scene expensive | 1 → 2 | 1.5 s → 1.6 s | 0.2 KB → 3.1 KB | 1001 → 69 chars | 11.5 s → 11.9 s | yes → yes |
| Try an edit, list what changed, undo it | 4 → 4 | 0.1 s → 0.1 s | 0.5 KB → 1.6 KB | 1618 → 517 chars | 28.2 s → 22.7 s | yes → yes |
| Find floating parts and impossible jumps | 1 → 2 | 0.0 s → 0.0 s | 0.4 KB → 1.5 KB | 1192 → 189 chars | 11.0 s → 11.0 s | yes → yes |
| Check a menu on a phone, a tablet and a PC | 7 → 1 | 4.4 s → 4.8 s | 2.3 KB → 2.1 KB | 2266 → 96 chars | 50.8 s → 10.3 s | yes → yes |
| Summarize errors and warnings | 1 → 1 | 0.0 s → 0.0 s | 8.5 KB → 0.5 KB | 12 → 16 chars | 5.1 s → 5.1 s | yes → yes |
| Check whether spawning enemies leaks memory | 1 → 1 | 1.3 s → 1.5 s | 0.2 KB → 0.6 KB | 574 → 113 chars | 9.2 s → 7.0 s | no → yes |
| Playtest: jump, check it, screenshot, collect errors | 7 → 1 | 5.2 s → 5.7 s | 5.3 KB → 1.0 KB | 626 → 218 chars | 43.4 s → 11.8 s | yes → yes |
| **All tasks** | **22 → 12** | **12.6 s → 13.7 s** | **17.6 KB → 10.5 KB** | **7289 → 1218 chars** | **159.1 s → 79.8 s** | |

Across all seven tasks Lumen needs about half the agent time, 10 fewer turns, and a sixth of the code the agent has to write.

### Where the time goes

- Multi step work collapses into one call.
  The device check drops from 7 turns to 1 and is about 5 times faster, and the scripted playtest drops from 7 turns to 1 and is about 3.7 times faster.
- Studio time is about the same in both arms, within a second per task.
  Lumen saves agent turns and writing, not engine time.
- Where the baseline already fits in one prewritten `execute_luau`, Lumen is even.
  The lag and level tasks take one extra call with Lumen, but the agent writes 15 and 6 times less, and that code would not exist ahead of time in real use.
- Lumen returns more text for the lag and level tasks because `lag_audit` and `spatial_check` report every cost and every problem they find, not only the planted ones.

### What the baseline missed

- The leak.
  Roblox refreshes `Stats.InstanceCount` and the memory tags only every few seconds, so a before and after comparison inside one call saw no growth in any of the three runs.
  `leak_check` counts unparented instances through `SceneAnalysisService`, which updates at once, and names the script and class that hold them, here `unparented:ServerStorage.LumenBenchLeaky:Folder`.
- The errors were found by both, but the baseline had to read 8.5 KB of raw log to find one error repeated 15 times, while `get_errors` returned it as one group with a count in 0.5 KB.

### Bugs the benchmark found in Lumen

Writing the benchmark exposed two Lumen bugs, both fixed before these results:

- `get_errors` treated "slot 1" through "slot 20" as 20 different warnings, which filled its 20 group page and pushed the real error out.
  Numbers no longer split a group, and errors are listed before warnings.
- `leak_check` counted the nodes of the unparented instance tree instead of the instances in it, so it never saw the leak grow.

## Run it yourself

Open an unsaved place in Studio with the Lumen plugin connected and an MCP client or Lumen server already running, then:

```sh
npm run build
npm run bench
```

The benchmark joins the running server in proxy mode, builds its fixtures under names that start with `LumenBench`, and removes them and restores `Lighting.ClockTime` when it ends, even after a failure.
Reports are written to `bench/results` as Markdown and JSON.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LUMEN_BENCH_RUNS` | 1 | Runs per task, averaged. |
| `LUMEN_BENCH_TURN_S` | 5 | Seconds an agent turn costs before it writes anything. |
| `LUMEN_BENCH_TOKENS_S` | 50 | Tokens the agent writes per second. |
| `LUMEN_BENCH_ONLY` | all | Comma separated task ids: `lag`, `checkpoint`, `level`, `ui`, `errors`, `leak`, `playtest`. |
