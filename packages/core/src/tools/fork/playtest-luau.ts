import { withArgs } from '../fork-luau.js';

// Caller Luau is compiled into the chunk as functions (the game VM has no
// loadstring), placed first so its line numbers are known and errors can name
// the caller's own line instead of a line in the generated chunk.

export interface UserFunction {
  label: string;
  source: string;
  kind: 'expression' | 'body';
}

export interface LuauChunk {
  code: string;
  /**
   * Chunk lines of each caller function: from its wrapper line, which a runtime error in an expression can name,
   * through its closing lines, where unfinished code fails to parse. first is the caller's line 1.
   */
  ranges: Array<{ label: string; from: number; first: number; last: number; lines: number }>;
}

/** Sentinels for samples Luau cannot store in an array: nil leaves a hole and an error has no value. */
export const NIL_SAMPLE = '<nil>';
export const ERROR_SAMPLE = '<error>';

/** A condition is a body when it uses return as a statement outside strings and comments. */
export function isBody(source: string): boolean {
  const code = source
    .replace(/\[(=*)\[[\s\S]*?\]\1\]/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, '""')
    .replace(/--[^\n]*/g, '');
  return /(^|[\s;])return(?!\w)/.test(code);
}

export function userFunction(label: string, source: string, kind?: UserFunction['kind']): UserFunction {
  return { label, source, kind: kind ?? (isBody(source) ? 'body' : 'expression') };
}

function chunk(user: UserFunction[], body: string, args: Record<string, unknown>): LuauChunk {
  // The plugin runs the chunk inside its own wrapper, so pcall messages carry wrapper lines and BASE measures the shift.
  const lines = ['local BASE = (debug.info(1, "l") or 1) - 1', 'local USER = {}'];
  const ranges: LuauChunk['ranges'] = [];
  user.forEach((fn, index) => {
    lines.push(`USER[${index + 1}] = function()`);
    const from = lines.length + 1;
    if (fn.kind === 'expression') lines.push('return (');
    const first = lines.length + 1;
    const source = fn.source.replace(/\r\n?/g, '\n').split('\n');
    lines.push(...source);
    if (fn.kind === 'expression') lines.push(')');
    lines.push('end');
    ranges.push({ label: fn.label, from, first, last: lines.length, lines: source.length });
  });
  return { code: `${lines.join('\n')}\n${withArgs(HELPERS + body, args)}`, ranges };
}

/** Rewrites user_code:N chunk locations, from the plugin or from reason(), into the caller's label and line. */
export function explainLuauError(message: string, ranges: LuauChunk['ranges']): string {
  return message.replace(/user_code:(\d+)/g, (match, raw: string) => {
    const line = Number(raw);
    const range = ranges.find((entry) => line >= entry.from && line <= entry.last);
    if (!range) return match;
    const offset = Math.max(1, line - range.first + 1);
    return offset > range.lines ? `${range.label}:${range.lines} (at end)` : `${range.label}:${offset}`;
  });
}

const HELPERS = String.raw`
-- Cut on a character boundary, since JSONEncode rejects a split or invalid multibyte character.
local function clip(text, limit)
	if utf8.len(text) == nil then text = string.gsub(text, "[\128-\255]", "?") end
	local cut = utf8.offset(text, limit + 1)
	if cut == nil or cut > #text then return text end
	return string.sub(text, 1, cut - 1) .. "..."
end

local function num(value)
	if not finite(value) then return tostring(value) end
	local rounded = round(value, 3)
	return if finite(rounded) then rounded else value
end

local function render(value, depth)
	local kind = typeof(value)
	if kind == "nil" or kind == "boolean" then return value end
	if kind == "number" then return if finite(value) then value else tostring(value) end
	if kind == "string" then return clip(value, 300) end
	if kind == "Vector3" then return { num(value.X), num(value.Y), num(value.Z) } end
	if kind == "Vector2" then return { num(value.X), num(value.Y) } end
	if kind == "CFrame" then return { num(value.Position.X), num(value.Position.Y), num(value.Position.Z) } end
	if kind == "Instance" then return clip(pathOf(value), 300) end
	if kind ~= "table" then return clip(tostring(value), 300) end
	depth = (depth or 0) + 1
	if depth > 3 then return "{...}" end
	local out = {}
	if #value > 0 then
		for i = 1, math.min(#value, 50) do
			local item = render(value[i], depth)
			out[i] = if item == nil then "nil" else item
		end
		if #value > 50 then table.insert(out, "...") end
		return out
	end
	local count = 0
	for key, item in value do
		count += 1
		if count > 50 then
			out["..."] = "more keys"
			break
		end
		out[clip(tostring(key), 100)] = render(item, depth)
	end
	return out
end

-- pcall messages start with the payload's chunk name and line. The user_code:N form lets Node name the caller's line.
local function reason(err)
	local function relative(line)
		return "user_code:" .. (tonumber(line) - BASE) .. ": "
	end
	local text = tostring(err)
	text = string.gsub(text, '^%[string "[^"]*"%]:(%d+): ', relative)
	text = string.gsub(text, "^[%w_%.]*__Lumen%w*Payload:(%d+): ", relative)
	return clip(text, 500)
end

-- A call that yields (WaitForChild, InvokeServer) is cut off at deadline instead of holding the caller's loop.
local function settle(fn, deadline)
	local done, ok, result = false, false, nil
	local thread = task.spawn(function()
		ok, result = pcall(fn)
		done = true
	end)
	while not done and os.clock() < deadline do task.wait() end
	if not done then pcall(task.cancel, thread) end
	return done, ok, result
end
`;

/** Polls USER[1] until truthy or timeout_s. timeout_s 0 checks once. A check may yield until timeout_s or yield_s. */
export function conditionLuau(condition: UserFunction, args: { timeout_s: number; interval_ms: number; yield_s: number }): LuauChunk {
  return chunk([condition], String.raw`
local started = os.clock()
local deadline = started + math.max(ARGS.timeout_s, ARGS.yield_s)
local interval = ARGS.interval_ms / 1000
local polls = 0
local met = false
local value, failure
while true do
	polls += 1
	local done, ok, result = settle(USER[1], deadline)
	if not done then
		value, failure = nil, "still yielding when time ran out, use FindFirstChild instead of WaitForChild"
	elseif ok then
		value, failure = result, nil
		met = result ~= nil and result ~= false
	else
		value, failure = nil, reason(result)
	end
	if met or os.clock() - started >= ARGS.timeout_s then break end
	task.wait(interval)
end
return { met = met, elapsed_s = round(os.clock() - started, 3), polls = polls, value = render(value), last_error = failure }
`, args);
}

/** Runs caller statements once, saying whether they returned anything, and renders the first value as JSON-safe data. */
export function runLuau(code: UserFunction): LuauChunk {
  return chunk([code], String.raw`
local results = table.pack(USER[1]())
return { returned = results.n > 0, value = render(results[1]) }
`, {});
}

/**
 * Notes when each frame renders for duration_ms, and reads the stamp expression on frames at least gap_ms apart.
 * RenderStepped only exists where Studio draws, so a peer without it falls back to Heartbeat and says so.
 */
export function frameClockLuau(stamp: UserFunction | undefined, args: { duration_ms: number; gap_ms: number }): LuauChunk {
  return chunk(stamp ? [stamp] : [], String.raw`
local RunService = game:GetService("RunService")
local MAX_FRAMES = 20000
local startedUnix = DateTime.now().UnixTimestampMillis
local started = os.clock()
local frames, stampT, stampV = {}, {}, {}
local stampError
local lastStamp = -math.huge

local function stampValue(value)
	local kind = typeof(value)
	if kind == "number" then return if finite(value) then round(value, 3) else tostring(value) end
	if kind == "boolean" then return value end
	-- An array cannot hold nil, so it is stored as the sentinel to keep stamp_t and stamp_v aligned.
	if kind == "nil" then return "${NIL_SAMPLE}" end
	if kind == "string" then return clip(value, 40) end
	return clip(tostring(value), 40)
end

local function onFrame()
	local ms = (os.clock() - started) * 1000
	if #frames < MAX_FRAMES then table.insert(frames, round(ms, 1)) end
	if ARGS.has_stamp and ms - lastStamp >= ARGS.gap_ms then
		lastStamp = ms
		-- Read on the frame itself, so a stamp that yields is reported rather than stalling the clock.
		local ok, value = pcall(USER[1])
		if ok then
			table.insert(stampT, round(ms, 1))
			table.insert(stampV, stampValue(value))
		elseif stampError == nil then
			stampError = reason(value)
		end
	end
end

local signal = "RenderStepped"
local connected, connection = pcall(function() return RunService.RenderStepped:Connect(onFrame) end)
if not connected then
	signal = "Heartbeat"
	connection = RunService.Heartbeat:Connect(onFrame)
end
task.wait(ARGS.duration_ms / 1000)
connection:Disconnect()
return { started_unix_ms = startedUnix, frames = frames, signal = signal, stamp_t = stampT, stamp_v = stampV, stamp_error = stampError }
`, { ...args, has_stamp: stamp !== undefined });
}

/** Samples every expression each interval_ms for duration_ms, and spawns action right after the first sample. */
export function watchLuau(expressions: UserFunction[], action: UserFunction | undefined, args: { names: string[]; duration_ms: number; interval_ms: number }): LuauChunk {
  return chunk(action ? [...expressions, action] : expressions, String.raw`
local NIL, ERR = "${NIL_SAMPLE}", "${ERROR_SAMPLE}"
local names = ARGS.names
local interval = ARGS.interval_ms / 1000
local duration = ARGS.duration_ms / 1000
local times, series, magnitudes, errors = {}, {}, {}, {}
for _, name in names do series[name] = {} end

local function sample(value)
	local kind = typeof(value)
	if kind == "nil" then return NIL end
	if kind == "number" then return if finite(value) then value else tostring(value) end
	if kind == "boolean" then return value end
	if kind == "string" then return clip(value, 120) end
	if kind == "Vector3" then return { num(value.X), num(value.Y), num(value.Z) }, num(value.Magnitude) end
	if kind == "Vector2" then return { num(value.X), num(value.Y) }, num(value.Magnitude) end
	if kind == "CFrame" then
		local position = value.Position
		return { num(position.X), num(position.Y), num(position.Z) }, num(position.Magnitude)
	end
	if kind == "Instance" then return clip(pathOf(value), 120) end
	return clip(tostring(value), 120)
end

local started = os.clock()
local function take()
	table.insert(times, round(os.clock() - started, 3))
	local index = #times
	for i, name in names do
		-- A sample may not yield, or one slow expression would skew every timestamp.
		local done, ok, value = settle(USER[i], os.clock())
		local converted, magnitude = ERR, nil
		if done and ok then
			converted, magnitude = sample(value)
		else
			local problem = if done then reason(value) else "yielded, a sampled expression must not yield"
			if errors[name] == nil then
				errors[name] = { count = 1, first = problem }
			else
				errors[name].count += 1
			end
		end
		series[name][index] = converted
		if magnitude ~= nil and magnitudes[name] == nil then magnitudes[name] = table.create(index - 1, NIL) end
		if magnitudes[name] ~= nil then magnitudes[name][index] = if magnitude ~= nil then magnitude else NIL end
	end
end

take()
local actionError
if ARGS.has_action then
	task.spawn(function()
		local ok, err = pcall(USER[#names + 1])
		if not ok then actionError = reason(err) end
	end)
end
while os.clock() - started < duration do
	task.wait(interval)
	take()
end
return { t = times, series = series, magnitudes = magnitudes, errors = errors, action_error = actionError }
`, { ...args, has_action: action !== undefined });
}
