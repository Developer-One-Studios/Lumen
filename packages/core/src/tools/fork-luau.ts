// Luau run on a Studio peer through /api/execute-luau (plugin VM) or
// /api/eval-runtime (game VM). Arguments travel as JSON in a long string, and
// every snippet returns one plain table so the plugin JSON-encodes it.

export function luauLongString(text: string): string {
  let level = '';
  // Appending the closer must not form one earlier, so text ending in "]" or "]=" also needs a longer level.
  while (`${text}]${level}`.includes(`]${level}]`)) level += '=';
  // A newline right after the opening bracket is dropped by Lua, so one is always added.
  return `[${level}[\n${text}]${level}]`;
}

export function withArgs(body: string, args: Record<string, unknown>): string {
  return `local ARGS = game:GetService("HttpService"):JSONDecode(${luauLongString(JSON.stringify(args))})\n${PRELUDE}\n${body}`;
}

// Mirrors the plugin's canonical path parser and printer so paths round-trip with every other tool.
const PRELUDE = String.raw`
local KEYWORDS = {}
for _, word in { "and", "break", "continue", "do", "else", "elseif", "end", "export", "false", "for", "function", "if", "in", "local", "nil", "not", "or", "repeat", "return", "then", "true", "type", "until", "while" } do
	KEYWORDS[word] = true
end

local function parsePath(path)
	local parts = {}
	if path == "" or path == "game" then return parts end
	local i = 1
	if string.sub(path, 1, 5) == "game." then i = 6 elseif string.sub(path, 1, 5) == "game[" then i = 5 end
	local current = ""
	local len = #path
	while i <= len do
		local ch = string.sub(path, i, i)
		local quote = string.sub(path, i + 1, i + 1)
		if ch == "." then
			if current ~= "" then
				table.insert(parts, current)
				current = ""
			elseif i > 1 and string.sub(path, i - 1, i - 1) == "." and i < len and quote ~= "[" then
				current = "."
			end
			i += 1
		elseif ch == "[" and (quote == '"' or quote == "'") and string.sub(path, i - 1, i - 1) ~= "." then
			if current ~= "" then table.insert(parts, current) end
			current = ""
			local j = i + 2
			local raw = {}
			while j <= len and string.sub(path, j, j) ~= quote do
				local c = string.sub(path, j, j)
				if c == "\\" and j < len then
					local n = string.sub(path, j + 1, j + 1)
					table.insert(raw, if n == "n" then "\n" elseif n == "r" then "\r" elseif n == "t" then "\t" else n)
					j += 2
				else
					table.insert(raw, c)
					j += 1
				end
			end
			if string.sub(path, j + 1, j + 1) ~= "]" then return nil end
			table.insert(parts, table.concat(raw))
			i = j + 2
		else
			current ..= ch
			i += 1
		end
	end
	if current ~= "" then table.insert(parts, current) end
	return parts
end

local function resolve(path)
	if type(path) ~= "string" then return nil end
	local parts = parsePath(path)
	if parts == nil then return nil end
	if #parts == 0 then return game end
	local ok, current = pcall(game.GetService, game, parts[1])
	if not ok or current == nil then current = game:FindFirstChild(parts[1]) end
	for i = 2, #parts do
		if current == nil then return nil end
		current = current:FindFirstChild(parts[i])
	end
	return current
end

local function segment(name)
	if string.match(name, "^[%a_][%w_]*$") and not KEYWORDS[name] then return "." .. name end
	local escaped = string.gsub(string.gsub(name, "\\", "\\\\"), '"', '\\"')
	return '["' .. escaped .. '"]'
end

local function pathOf(instance)
	if instance == game then return "game" end
	local parts = {}
	local current = instance
	while current ~= nil and current ~= game do
		local name = current.Name
		if current.Parent == game then
			local ok, service = pcall(game.GetService, game, current.ClassName)
			if ok and service == current then name = current.ClassName end
		end
		table.insert(parts, 1, segment(name))
		current = current.Parent
	end
	return (if current == game then "game" else "nil") .. table.concat(parts)
end

local function round(value, places)
	local scale = 10 ^ (places or 2)
	return math.floor(value * scale + 0.5) / scale
end

local function finite(value)
	return type(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge
end

-- Some properties exist but refuse script reads, which would otherwise abort the whole snippet.
local function readable(instance, property)
	local ok, value = pcall(function() return (instance :: any)[property] end)
	if not ok then return nil end
	return if typeof(value) == "EnumItem" then value.Name else value
end
`;

// Stats readings in seconds are reported in milliseconds.
const STATS_SAMPLER = String.raw`
local Stats = game:GetService("Stats")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local METRICS = {
	"FrameTime", "RenderCPUFrameTime", "RenderGPUFrameTime", "HeartbeatTime", "PhysicsStepTime",
	"SceneDrawcallCount", "SceneTriangleCount", "ShadowsDrawcallCount", "ShadowsTriangleCount",
	"UI2DDrawcallCount", "UI2DTriangleCount", "UI3DDrawcallCount", "UI3DTriangleCount",
	"DataSendKbps", "DataReceiveKbps", "PhysicsSendKbps", "PhysicsReceiveKbps",
	"InstanceCount", "PrimitivesCount", "MovingPrimitivesCount", "ContactsCount",
}
local SECONDS = { FrameTime = true, RenderCPUFrameTime = true, RenderGPUFrameTime = true, HeartbeatTime = true, PhysicsStepTime = true }

local function summarize(values)
	if #values == 0 then return nil end
	table.sort(values)
	local sum = 0
	for _, value in values do sum += value end
	return { avg = round(sum / #values), p95 = round(values[math.max(1, math.ceil(#values * 0.95))]), max = round(values[#values]) }
end

local function sampleStats(duration, interval)
	local series = {}
	for _, name in METRICS do series[name] = {} end
	local ping = {}
	local beats = 0
	local beat = RunService.Heartbeat:Connect(function() beats += 1 end)
	local started = os.clock()
	while os.clock() - started < duration do
		for _, name in METRICS do
			local ok, value = pcall(function() return (Stats :: any)[name] end)
			if ok and finite(value) then table.insert(series[name], if SECONDS[name] then value * 1000 else value) end
		end
		local player = Players.LocalPlayer
		if player then
			local ok, value = pcall(function() return player:GetNetworkPing() end)
			if ok and finite(value) then table.insert(ping, value * 1000) end
		end
		task.wait(interval)
	end
	local elapsed = os.clock() - started
	beat:Disconnect()
	local metrics = {}
	for _, name in METRICS do
		local summary = summarize(series[name])
		-- Render counters read zero on a server and simulation counters on an idle edit peer.
		if summary and summary.max ~= 0 then metrics[name .. (if SECONDS[name] then "Ms" else "")] = summary end
	end
	return {
		seconds = round(elapsed),
		heartbeatHz = round(beats / math.max(elapsed, 0.001), 1),
		pingMs = summarize(ping),
		metrics = metrics,
	}
end
`;

export function perfStatsLuau(args: { duration_ms: number; sample_ms: number; remotes: boolean; top_remotes: number }): string {
  return withArgs(STATS_SAMPLER + String.raw`
local isServer = RunService:IsServer() and RunService:IsRunning()
local remotes = {}
local connections = {}

local function sizeOf(value, depth)
	local kind = typeof(value)
	if kind == "buffer" then return buffer.len(value) end
	if kind == "string" then return #value end
	if kind == "number" then return 8 end
	if kind == "boolean" or kind == "nil" then return 1 end
	if kind == "Vector3" then return 12 end
	if kind == "Vector2" then return 8 end
	if kind == "CFrame" then return 24 end
	if kind == "Instance" then return 4 end
	if kind == "table" then
		if depth > 6 then return 0 end
		local total = 2
		for key, child in value do total += sizeOf(key, depth + 1) + sizeOf(child, depth + 1) end
		return total
	end
	return 8
end

if ARGS.remotes then
	for _, instance in game:GetDescendants() do
		if instance:IsA("RemoteEvent") or instance:IsA("UnreliableRemoteEvent") then
			local entry = { path = pathOf(instance), class = instance.ClassName, count = 0, bytes = 0 }
			table.insert(remotes, entry)
			local signal = if isServer then (instance :: any).OnServerEvent else (instance :: any).OnClientEvent
			table.insert(connections, signal:Connect(function(...)
				entry.count += 1
				-- The server signal's first argument is the sending Player.
				for i = if isServer then 2 else 1, select("#", ...) do entry.bytes += sizeOf((select(i, ...)), 0) end
			end))
		end
	end
end

local result = sampleStats(ARGS.duration_ms / 1000, ARGS.sample_ms / 1000)
for _, connection in connections do connection:Disconnect() end

if ARGS.remotes then
	local seconds = math.max(result.seconds, 0.001)
	table.sort(remotes, function(a, b) return a.bytes > b.bytes or (a.bytes == b.bytes and a.count > b.count) end)
	local top = {}
	for i = 1, math.min(ARGS.top_remotes, #remotes) do
		local entry = remotes[i]
		if entry.count == 0 then break end
		table.insert(top, { path = entry.path, class = entry.class, perSecond = round(entry.count / seconds, 1), bytesPerSecond = round(entry.bytes / seconds) })
	end
	result.remotes = { direction = if isServer then "client_to_server" else "server_to_client", watched = #remotes, top = top }
end
result.running = RunService:IsRunning()
return result
`, args);
}

export function lagAuditLuau(args: { root: string; top: number }): string {
  return withArgs(String.raw`
local Lighting = game:GetService("Lighting")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local Stats = game:GetService("Stats")

local root = resolve(ARGS.root)
if root == nil then return { error = "root not found: " .. tostring(ARGS.root) } end
local running = RunService:IsRunning()
local isServer = running and RunService:IsServer()
local TOP = ARGS.top

local function keepTop(list, entry, key)
	table.insert(list, entry)
	table.sort(list, function(a, b) return a[key] > b[key] end)
	if #list > TOP then table.remove(list) end
end

local function sequenceMax(sequence)
	local best = 0
	for _, point in sequence.Keypoints do best = math.max(best, point.Value + point.Envelope) end
	return best
end

local function sequenceMin(sequence)
	local best = math.huge
	for _, point in sequence.Keypoints do best = math.min(best, point.Value) end
	return best
end

local classCounts = {}
local totals = {
	instances = 0, baseParts = 0, meshParts = 0, unanchored = 0, castShadow = 0, transparentParts = 0,
	preciseCollision = 0, preciseCollisionUnanchored = 0, preciseRender = 0,
	particleEmitters = 0, liveParticlesEstimate = 0, trails = 0, beams = 0,
	lights = 0, shadowLights = 0, decalsAndTextures = 0, surfaceAppearances = 0,
	humanoids = 0, sounds = 0, playingSounds = 0, viewportFrames = 0, canvasGroups = 0,
}
local uniqueMeshes, uniqueTextures = {}, {}
local emitters, lights, heavyGroups, ownership = {}, {}, {}, {}
local groups = {}

local function groupOf(instance)
	local current = instance
	while current.Parent ~= nil and current.Parent ~= root do current = current.Parent end
	return current
end

local scanned = 0
for _, instance in root:GetDescendants() do
	scanned += 1
	-- Keep Studio responsive on very large places.
	if scanned % 4000 == 0 then task.wait() end
	totals.instances += 1
	classCounts[instance.ClassName] = (classCounts[instance.ClassName] or 0) + 1
	local group = groupOf(instance)
	local stats = groups[group]
	if stats == nil then
		stats = { parts = 0, particles = 0, lights = 0, descendants = 0 }
		groups[group] = stats
	end
	stats.descendants += 1

	if instance:IsA("BasePart") then
		totals.baseParts += 1
		stats.parts += 1
		if not instance.Anchored then
			totals.unanchored += 1
			if isServer and instance:GetRootPart() == instance then
				local ok, owner = pcall(instance.GetNetworkOwner, instance)
				local key = if not ok then "anchoredRoot" elseif owner == nil then "server" else "player"
				ownership[key] = (ownership[key] or 0) + 1
			end
		end
		if instance.CastShadow and instance.Transparency < 1 then totals.castShadow += 1 end
		if instance.Transparency > 0 and instance.Transparency < 1 then totals.transparentParts += 1 end
		if instance:IsA("MeshPart") then
			totals.meshParts += 1
			uniqueMeshes[instance.MeshId] = true
			if instance.TextureID ~= "" then uniqueTextures[instance.TextureID] = true end
			if instance.RenderFidelity == Enum.RenderFidelity.Precise then totals.preciseRender += 1 end
		end
		local okFidelity, fidelity = pcall(function() return (instance :: any).CollisionFidelity end)
		if okFidelity and fidelity == Enum.CollisionFidelity.PreciseConvexDecomposition and instance.CanCollide then
			totals.preciseCollision += 1
			if not instance.Anchored then totals.preciseCollisionUnanchored += 1 end
		end
	elseif instance:IsA("ParticleEmitter") then
		totals.particleEmitters += 1
		local live = if instance.Enabled then instance.Rate * instance.Lifetime.Max else 0
		local size = sequenceMax(instance.Size)
		local opacity = 1 - math.clamp(sequenceMin(instance.Transparency), 0, 1)
		totals.liveParticlesEstimate += live
		stats.particles += live
		uniqueTextures[instance.Texture] = true
		-- Screen fill drives fragment cost: count times area times opacity.
		keepTop(emitters, {
			path = pathOf(instance), live = round(live, 0), rate = round(instance.Rate, 1), lifetime = round(instance.Lifetime.Max, 1),
			size = round(size, 1), opacity = round(opacity), fill = round(live * size * size * opacity, 0),
		}, "fill")
	elseif instance:IsA("Trail") then
		totals.trails += 1
	elseif instance:IsA("Beam") then
		totals.beams += 1
	elseif instance:IsA("Light") then
		totals.lights += 1
		stats.lights += 1
		if instance.Enabled and instance.Shadows then
			totals.shadowLights += 1
			local range = if instance:IsA("SurfaceLight") or instance:IsA("SpotLight") or instance:IsA("PointLight") then (instance :: any).Range else 0
			keepTop(lights, { path = pathOf(instance), class = instance.ClassName, range = round(range, 1), brightness = round(instance.Brightness, 1) }, "range")
		end
	elseif instance:IsA("Decal") then
		totals.decalsAndTextures += 1
		uniqueTextures[instance.Texture] = true
	elseif instance:IsA("SurfaceAppearance") then
		totals.surfaceAppearances += 1
	elseif instance:IsA("Humanoid") then
		totals.humanoids += 1
	elseif instance:IsA("Sound") then
		totals.sounds += 1
		if instance.IsPlaying then totals.playingSounds += 1 end
	elseif instance:IsA("ViewportFrame") then
		totals.viewportFrames += 1
	elseif instance:IsA("CanvasGroup") then
		totals.canvasGroups += 1
	end
end

for group, stats in groups do
	keepTop(heavyGroups, { path = pathOf(group), parts = stats.parts, liveParticles = round(stats.particles, 0), lights = stats.lights, descendants = stats.descendants }, "descendants")
end

local function count(set)
	local n = 0
	for _ in set do n += 1 end
	return n
end
totals.uniqueMeshes = count(uniqueMeshes)
totals.uniqueTextures = count(uniqueTextures)
totals.liveParticlesEstimate = round(totals.liveParticlesEstimate, 0)

local topClasses = {}
for class, n in classCounts do table.insert(topClasses, { class = class, count = n }) end
table.sort(topClasses, function(a, b) return a.count > b.count end)
while #topClasses > TOP do table.remove(topClasses) end

local workspace = game:GetService("Workspace")
local environment = {
	lightingTechnology = readable(Lighting, "Technology"),
	globalShadows = Lighting.GlobalShadows,
	streamingEnabled = workspace.StreamingEnabled,
	-- Studio refuses script reads of some streaming settings, depending on version.
	streamingTargetRadius = readable(workspace, "StreamingTargetRadius"),
	streamingMinRadius = readable(workspace, "StreamingMinRadius"),
}
local okCells, cells = pcall(function() return workspace.Terrain:CountCells() end)
if okCells then environment.terrainCells = cells end

local render = {}
for _, name in { "SceneDrawcallCount", "SceneTriangleCount", "ShadowsDrawcallCount", "ShadowsTriangleCount", "UI2DDrawcallCount", "InstanceCount", "PrimitivesCount", "MovingPrimitivesCount" } do
	local ok, value = pcall(function() return (Stats :: any)[name] end)
	if ok and finite(value) and value ~= 0 then render[name] = value end
end

local hints = {}
local function hint(condition, text) if condition then table.insert(hints, text) end end
hint(totals.liveParticlesEstimate > 2000, "Over 2000 live particles estimated; see emitters, large translucent particles cost the most on mobile.")
hint(totals.shadowLights > 8, "More than 8 shadow-casting local lights; each re-renders shadows.")
hint(totals.castShadow > 6000 and Lighting.GlobalShadows, "Over 6000 shadow-casting parts; turn CastShadow off on small or interior parts.")
hint(totals.preciseCollisionUnanchored > 25, "Unanchored parts with PreciseConvexDecomposition collision are expensive to simulate.")
hint(totals.unanchored > 1500, "Over 1500 unanchored parts; physics and replication scale with them.")
hint(totals.humanoids > 80, "Over 80 Humanoids; consider AnimationController or simplified rigs for NPCs.")
hint(totals.uniqueMeshes > 1500, "Over 1500 unique meshes; reuse meshes so instancing can batch draw calls.")
hint(totals.viewportFrames > 4, "More than 4 ViewportFrames; each renders a separate scene.")
hint(not workspace.StreamingEnabled and totals.baseParts > 20000, "StreamingEnabled is off with over 20000 parts; clients load the whole map.")
hint((render.SceneDrawcallCount or 0) > 3000, "Over 3000 scene draw calls this frame.")
hint((render.SceneTriangleCount or 0) > 2000000, "Over 2 million triangles rendered this frame.")

return {
	root = pathOf(root),
	peer = if not running then "edit" elseif isServer then "server" else "client",
	totals = totals,
	networkOwnership = if isServer then ownership else nil,
	environment = environment,
	renderNow = render,
	topClasses = topClasses,
	heaviestGroups = heavyGroups,
	emitters = emitters,
	shadowLights = lights,
	hints = hints,
}
`, args);
}

export function profileToggleLuau(args: { category: string; path?: string; duration_ms: number }): string {
  return withArgs(STATS_SAMPLER + String.raw`
if not RunService:IsRunning() then
	return { error = "profile_toggle only runs in a playtest peer, edit changes would be saved into the place." }
end
local Lighting = game:GetService("Lighting")
local workspace = game:GetService("Workspace")

local undo = {}
local affected = 0
local function set(instance, property, value)
	local ok, previous = pcall(function() return (instance :: any)[property] end)
	if not ok or previous == value then return end
	if pcall(function() (instance :: any)[property] = value end) then
		affected += 1
		table.insert(undo, function() pcall(function() (instance :: any)[property] = previous end) end)
	end
end

local category = ARGS.category
local function apply()
	if category == "particles" then
		for _, instance in game:GetDescendants() do
			if instance:IsA("ParticleEmitter") or instance:IsA("Trail") or instance:IsA("Beam") or instance:IsA("Fire") or instance:IsA("Smoke") or instance:IsA("Sparkles") then
				set(instance, "Enabled", false)
			end
		end
	elseif category == "shadows" then
		set(Lighting, "GlobalShadows", false)
		for _, instance in game:GetDescendants() do
			if instance:IsA("Light") then set(instance, "Shadows", false) end
		end
	elseif category == "lights" then
		for _, instance in game:GetDescendants() do
			if instance:IsA("Light") then set(instance, "Enabled", false) end
		end
	elseif category == "post_effects" then
		local containers = { Lighting }
		if workspace.CurrentCamera then table.insert(containers, workspace.CurrentCamera) end
		for _, container in containers do
			for _, instance in container:GetChildren() do
				if instance:IsA("PostEffect") then set(instance, "Enabled", false) end
			end
		end
	elseif category == "gui" then
		local player = Players.LocalPlayer
		local gui = player and player:FindFirstChildOfClass("PlayerGui")
		if gui == nil then return "gui needs a client peer" end
		for _, instance in gui:GetChildren() do
			if instance:IsA("ScreenGui") then set(instance, "Enabled", false) end
		end
	elseif category == "instance" then
		local target = resolve(ARGS.path)
		if target == nil then return "path not found: " .. tostring(ARGS.path) end
		local parent = target.Parent
		target.Parent = nil
		affected += 1
		table.insert(undo, function() pcall(function() target.Parent = parent end) end)
	else
		return "unknown category " .. tostring(category)
	end
	return nil
end

local seconds = ARGS.duration_ms / 1000
local baseline = sampleStats(seconds, 0.1)
local problem = apply()
local toggled
if problem == nil then
	task.wait(0.3)
	toggled = sampleStats(seconds, 0.1)
end
for i = #undo, 1, -1 do undo[i]() end
if problem then return { error = problem } end

local delta = {}
for name, before in baseline.metrics do
	local after = toggled.metrics[name]
	local change = if after then after.avg - before.avg else -before.avg
	if math.abs(change) > 0.0001 then
		delta[name] = { before = before.avg, after = if after then after.avg else 0, change = round(change), percent = if before.avg ~= 0 then round(change / before.avg * 100, 1) else nil }
	end
end
return { category = category, affected = affected, restored = true, heartbeatHz = { before = baseline.heartbeatHz, after = toggled.heartbeatHz }, delta = delta }
`, args);
}

export const LEAK_SNAPSHOT_LUAU = String.raw`
local Stats = game:GetService("Stats")
local tags = {}
for _, item in Enum.DeveloperMemoryTag:GetEnumItems() do
	local ok, value = pcall(Stats.GetMemoryUsageMbForTag, Stats, item)
	if ok and finite(value) then tags[item.Name] = round(value, 3) end
end
local classes = {}
local scanned = 0
for _, instance in game:GetDescendants() do
	scanned += 1
	if scanned % 5000 == 0 then task.wait() end
	classes[instance.ClassName] = (classes[instance.ClassName] or 0) + 1
end
local unparented = nil
local okService, scene = pcall(game.GetService, game, "SceneAnalysisService")
if okService and scene then
	local ok, tree = pcall(function() return (scene :: any):GetUnparentedInstancesAsync() end)
	if ok and type(tree) == "table" then
		local nodes = 0
		local function walk(node)
			if type(node) ~= "table" then return end
			if node.Children == nil or #node.Children == 0 then nodes += 1 end
			for _, child in node.Children or {} do walk(child) end
		end
		walk(tree)
		unparented = nodes
	end
end
return {
	totalMb = round(Stats:GetTotalMemoryUsageMb(), 2),
	instanceCount = Stats.InstanceCount,
	tags = tags,
	classes = classes,
	unparentedInstances = unparented,
}
`;

export function leakSnapshotLuau(): string {
  return withArgs(LEAK_SNAPSHOT_LUAU, {});
}

export function replicationProbeLuau(args: { path: string; properties: string[]; children: boolean }): string {
  return withArgs(String.raw`
local RunService = game:GetService("RunService")
local target = resolve(ARGS.path)
if target == nil then return { exists = false } end

local function encode(value)
	local kind = typeof(value)
	if kind == "number" then return if finite(value) then round(value, 3) else tostring(value) end
	if kind == "string" or kind == "boolean" then return value end
	if kind == "Vector3" then return { round(value.X, 3), round(value.Y, 3), round(value.Z, 3) } end
	if kind == "Vector2" then return { round(value.X, 3), round(value.Y, 3) } end
	if kind == "CFrame" then
		local x, y, z = value:ToEulerAnglesXYZ()
		return { round(value.X, 3), round(value.Y, 3), round(value.Z, 3), round(math.deg(x), 1), round(math.deg(y), 1), round(math.deg(z), 1) }
	end
	if kind == "Color3" then return value:ToHex() end
	if kind == "EnumItem" then return tostring(value) end
	if kind == "Instance" then return pathOf(value) end
	if kind == "nil" then return "nil" end
	return tostring(value)
end

local properties = {}
for _, name in ARGS.properties do
	local ok, value = pcall(function() return (target :: any)[name] end)
	if ok then properties[name] = encode(value) end
end
local attributes = {}
for name, value in target:GetAttributes() do attributes[name] = encode(value) end
local children = nil
if ARGS.children then
	children = {}
	for _, child in target:GetChildren() do table.insert(children, child.Name .. ":" .. child.ClassName) end
	table.sort(children)
	while #children > 200 do table.remove(children) end
end
local owner = nil
if RunService:IsServer() and RunService:IsRunning() and target:IsA("BasePart") and not target.Anchored then
	local ok, player = pcall(target.GetNetworkOwner, target)
	if ok then owner = if player then player.Name else "server" end
end
return { exists = true, class = target.ClassName, properties = properties, attributes = attributes, children = children, networkOwner = owner }
`, args);
}

export function fuzzRemoteLuau(args: { path: string; spam: number; include_functions: boolean }): string {
  return withArgs(String.raw`
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
if not (RunService:IsRunning() and RunService:IsClient()) then
	return { error = "fuzz_remotes fires from a playtest client peer" }
end
local remote = resolve(ARGS.path)
if remote == nil then return { error = "remote not found: " .. ARGS.path } end

local nested = {}
local cursor = nested
for _ = 1, 60 do cursor.next = {} cursor = cursor.next end
local wide = {}
for i = 1, 5000 do wide[i] = i end
local noise = buffer.create(1024)
for i = 0, 1023 do buffer.writeu8(noise, i, math.random(0, 255)) end

local nan = 0 / 0
-- table.pack keeps explicit nils so each case sends exactly the arguments listed.
local function case(name, ...)
	return { name = name, args = table.pack(...) }
end
local cases = {
	case("no_args"),
	case("nil", nil),
	case("boolean", true),
	case("negative", -1),
	case("zero", 0),
	case("huge", math.huge),
	case("nan", nan),
	case("float_max", 1.7976931348623157e308),
	case("empty_string", ""),
	case("long_string", string.rep("A", 200000)),
	case("table_empty", {}),
	case("table_nested_60", nested),
	case("table_wide_5000", wide),
	case("table_mixed_keys", { [1] = "a", key = "b", [true] = 1 }),
	case("vector_nan", Vector3.new(nan, nan, nan)),
	case("cframe_huge", CFrame.new(1e30, 1e30, 1e30)),
	case("instance_workspace", game:GetService("Workspace")),
	case("instance_self", Players.LocalPlayer),
	case("buffer_empty", buffer.create(0)),
	case("buffer_noise", noise),
	case("many_args", 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16),
}

local fired, failures = 0, {}
local isFunction = remote:IsA("RemoteFunction")
if isFunction and not ARGS.include_functions then return { remote = pathOf(remote), skipped = "RemoteFunction; pass include_functions" } end

local function fire(entry)
	local ok, err = pcall(function()
		if isFunction then
			-- InvokeServer yields until the server answers, a handler that never returns must not stall the run.
			local thread = task.spawn(function() (remote :: any):InvokeServer(table.unpack(entry.args, 1, entry.args.n)) end)
			task.delay(2, function() pcall(task.cancel, thread) end)
		else
			(remote :: any):FireServer(table.unpack(entry.args, 1, entry.args.n))
		end
	end)
	if ok then fired += 1 else table.insert(failures, entry.name .. ": " .. tostring(err)) end
end

for _, entry in cases do fire(entry) end
for i = 1, ARGS.spam do
	fire(case("spam", i))
	if i % 50 == 0 then task.wait() end
end
return { remote = pathOf(remote), class = remote.ClassName, fired = fired, clientErrors = failures, kicked = Players.LocalPlayer.Parent == nil }
`, args);
}

export function listRemotesLuau(args: { root: string; include_functions: boolean }): string {
  return withArgs(String.raw`
local root = resolve(ARGS.root)
if root == nil then return { error = "root not found: " .. ARGS.root } end
local remotes = {}
for _, instance in root:GetDescendants() do
	if instance:IsA("RemoteEvent") or instance:IsA("UnreliableRemoteEvent") or (ARGS.include_functions and instance:IsA("RemoteFunction")) then
		if string.sub(instance.Name, 1, 5) ~= "__Lumen" then table.insert(remotes, pathOf(instance)) end
	end
end
table.sort(remotes)
return { remotes = remotes }
`, args);
}

export function inspectGuiLuau(args: { root?: string; at?: { x: number; y: number }; max_nodes: number; visible_only: boolean; text?: string }): string {
  return withArgs(String.raw`
local Players = game:GetService("Players")
local GuiService = game:GetService("GuiService")
local player = Players.LocalPlayer
if player == nil then return { error = "inspect_gui needs a playtest client peer" } end
local playerGui = player:FindFirstChildOfClass("PlayerGui")
if playerGui == nil then return { error = "PlayerGui not loaded yet" } end
local root = if ARGS.root then resolve(ARGS.root) else playerGui
if root == nil then return { error = "root not found: " .. tostring(ARGS.root) } end
local inset = GuiService:GetGuiInset()
local camera = game:GetService("Workspace").CurrentCamera

local function shown(object)
	local current = object
	while current ~= nil and current ~= playerGui do
		if current:IsA("GuiObject") and not current.Visible then return false end
		if current:IsA("LayerCollector") and not current.Enabled then return false end
		current = current.Parent
	end
	return true
end

local function relativePath(object)
	local full = pathOf(object)
	local base = pathOf(playerGui)
	if string.sub(full, 1, #base) == base then return "PlayerGui" .. string.sub(full, #base + 1) end
	return full
end

local function fullText(object)
	local ok, text = pcall(function() return (object :: any).Text end)
	if ok and type(text) == "string" and text ~= "" then return text end
	return nil
end

-- Cut on a character boundary, JSONEncode rejects a split multibyte character.
local function shorten(text)
	local cut = utf8.offset(text, 61)
	return if cut then string.sub(text, 1, cut - 1) else text
end

local rows = {}
local truncated = false
local needle = if ARGS.text then string.lower(ARGS.text) else nil
for _, object in root:GetDescendants() do
	if object:IsA("GuiObject") then
		local visible = shown(object)
		local full = fullText(object)
		local text = if full then shorten(full) else nil
		local wanted = (visible or not ARGS.visible_only) and (needle == nil or (full ~= nil and string.find(string.lower(full), needle, 1, true) ~= nil))
		if wanted then
			if #rows >= ARGS.max_nodes then truncated = true break end
			local position, size = object.AbsolutePosition, object.AbsoluteSize
			local screen = object:FindFirstAncestorWhichIsA("LayerCollector")
			table.insert(rows, {
				relativePath(object), object.ClassName,
				math.floor(position.X + inset.X + 0.5), math.floor(position.Y + inset.Y + 0.5),
				math.floor(size.X + 0.5), math.floor(size.Y + 0.5),
				object.ZIndex, if screen and screen:IsA("ScreenGui") then screen.DisplayOrder else 0,
				text or "", object:IsA("GuiButton") or object:IsA("TextBox"), visible,
			})
		end
	end
end

local hits = nil
if ARGS.at then
	hits = {}
	for _, object in playerGui:GetGuiObjectsAtPosition(ARGS.at.x - inset.X, ARGS.at.y - inset.Y) do
		table.insert(hits, relativePath(object))
	end
end

return {
	viewport = if camera then { math.floor(camera.ViewportSize.X), math.floor(camera.ViewportSize.Y) } else nil,
	inset = { math.floor(inset.X), math.floor(inset.Y) },
	columns = { "path", "class", "x", "y", "w", "h", "z", "order", "text", "clickable", "visible" },
	rows = rows,
	truncated = truncated,
	hitsAt = hits,
}
`, args);
}

// Viewport pixels of a GuiObject centre, in the space simulate_mouse_input and capture_screenshot use.
export function guiCenterLuau(args: { path: string }): string {
  return withArgs(String.raw`
local GuiService = game:GetService("GuiService")
local Players = game:GetService("Players")
local object = resolve(ARGS.path)
if object == nil and Players.LocalPlayer then
	local relative = string.match(ARGS.path, "^PlayerGui(.*)$")
	local playerGui = Players.LocalPlayer:FindFirstChildOfClass("PlayerGui")
	if relative and playerGui then object = resolve(pathOf(playerGui) .. relative) end
end
if object == nil or not object:IsA("GuiObject") then return { error = "GuiObject not found: " .. ARGS.path } end
local current = object
while current ~= nil do
	if current:IsA("GuiObject") and not current.Visible then return { error = "GuiObject is hidden: " .. pathOf(current) } end
	if current:IsA("LayerCollector") and not current.Enabled then return { error = "ScreenGui is disabled: " .. pathOf(current) } end
	current = current.Parent
end
local inset = GuiService:GetGuiInset()
local position, size = object.AbsolutePosition, object.AbsoluteSize
local playerGui = Players.LocalPlayer and Players.LocalPlayer:FindFirstChildOfClass("PlayerGui")
local camera = game:GetService("Workspace").CurrentCamera
local viewport = if camera then camera.ViewportSize else Vector2.new(math.huge, math.huge)
-- A click goes to the topmost button or Active object, so a point where another one covers the target would press that one.
-- Rank 0 has the target on top, rank 1 only passive overlays above it, rank 2 a button or Active object above it.
local function rank(x, y)
	if playerGui == nil then return 0 end
	for index, hit in playerGui:GetGuiObjectsAtPosition(x, y) do
		if hit == object or hit:IsDescendantOf(object) then return if index == 1 then 0 else 1 end
		if hit:IsA("GuiButton") or hit.Active then return 2, hit end
	end
	return nil
end
local fractions = { 0.5, 0.3, 0.7, 0.15, 0.85 }
local best, covering
for _, fy in fractions do
	for _, fx in fractions do
		local x, y = position.X + size.X * fx, position.Y + size.Y * fy
		local sx, sy = x + inset.X, y + inset.Y
		if sx >= 0 and sy >= 0 and sx < viewport.X and sy < viewport.Y then
			local score, over = rank(x, y)
			covering = covering or over
			local offCentre = math.abs(fx - 0.5) + math.abs(fy - 0.5)
			if score ~= nil and score < 2 and (best == nil or score < best.score or (score == best.score and offCentre < best.offCentre)) then
				best = { score = score, offCentre = offCentre, x = sx, y = sy }
			end
		end
	end
end
if best == nil and covering then
	return { error = "GuiObject is covered by " .. pathOf(covering) .. " everywhere on screen: " .. pathOf(object) }
end
-- Hit testing only sees on-screen 2D GUI, so anything else keeps the plain centre.
best = best or { x = position.X + size.X / 2 + inset.X, y = position.Y + size.Y / 2 + inset.Y }
return { x = math.floor(best.x + 0.5), y = math.floor(best.y + 0.5), path = pathOf(object) }
`, args);
}

export function navigateLuau(args: { position?: { x: number; y: number; z: number }; path?: string; speed_multiplier: number; timeout_s: number }): string {
  return withArgs(String.raw`
local Players = game:GetService("Players")
local PathfindingService = game:GetService("PathfindingService")
local player = Players.LocalPlayer
if player == nil then return { error = "navigate_character needs a playtest client peer" } end
local character = player.Character
if character == nil then return { error = "the local player has no character" } end
local humanoid = character:FindFirstChildOfClass("Humanoid")
local rootPart = humanoid and humanoid.RootPart
if humanoid == nil or rootPart == nil or humanoid.Health <= 0 then return { error = "the character has no living Humanoid" } end

local goal, box
if ARGS.path then
	local target = resolve(ARGS.path)
	if target == nil then return { error = "path not found: " .. ARGS.path } end
	if target:IsA("BasePart") then box = { cframe = target.CFrame, size = target.Size }
	elseif target:IsA("Model") then
		local cframe, size = target:GetBoundingBox()
		box = { cframe = cframe, size = size }
	elseif target:IsA("Attachment") then goal = target.WorldPosition
	else return { error = "path is not a BasePart, Model or Attachment" } end
else
	goal = Vector3.new(ARGS.position.x, ARGS.position.y, ARGS.position.z)
end

-- A tall or wide target counts as reached from beside it, so distance is measured to its box, not its centre.
local function closestOnBox(position)
	local offset = box.cframe:PointToObjectSpace(position)
	local half = box.size / 2
	return box.cframe:PointToWorldSpace(Vector3.new(
		math.clamp(offset.X, -half.X, half.X),
		math.clamp(offset.Y, -half.Y, half.Y),
		math.clamp(offset.Z, -half.Z, half.Z)
	))
end
local function remaining()
	if box == nil then return (rootPart.Position - goal).Magnitude end
	return (rootPart.Position - closestOnBox(rootPart.Position)).Magnitude
end
local function against() return box ~= nil and remaining() < 3 end

-- The top comes first so pads and platforms are stepped on and fire Touched. A wall has no path to its top,
-- so the next try is the ground beside the face nearest the character.
local goals = { goal }
if box then
	local top = box.cframe:PointToWorldSpace(Vector3.new(0, box.size.Y / 2, 0))
	local face = closestOnBox(rootPart.Position)
	local away = Vector3.new(rootPart.Position.X - face.X, 0, rootPart.Position.Z - face.Z)
	if away.Magnitude < 0.1 then away = Vector3.new(rootPart.Position.X - box.cframe.X, 0, rootPart.Position.Z - box.cframe.Z) end
	goals = { top }
	if away.Magnitude >= 0.1 then table.insert(goals, Vector3.new(face.X, rootPart.Position.Y, face.Z) + away.Unit * 3) end
end

local started = os.clock()
local deadline = started + ARGS.timeout_s
local originalSpeed = humanoid.WalkSpeed
humanoid.WalkSpeed = originalSpeed * ARGS.speed_multiplier
-- Even at a tenth of walk speed a free character closes half a stud well within this, so no headway for this long means it is stuck.
local STALL_S = 1

-- With passRadius an intermediate waypoint hands over to the next one before the Humanoid stops on it.
-- Returns false with "stalled", "timeout" or "died" when the waypoint was not reached.
local function walkTo(position, stopEarly, passRadius)
	-- Twice the walking time, and never less than a stall plus its jump, so a short hop still gets its jump.
	local expected = (rootPart.Position - position).Magnitude / math.max(humanoid.WalkSpeed, 1) * 2 + 1.5
	local limit = math.min(deadline, os.clock() + math.max(expected, STALL_S * 2 + 0.5))
	local function flat()
		local offset = rootPart.Position - position
		return Vector3.new(offset.X, 0, offset.Z).Magnitude, offset.Y
	end
	local function passed()
		if passRadius == nil then return false end
		local across, up = flat()
		return across < passRadius and math.abs(up) < 6
	end
	local closest, progressAt, jumped = (rootPart.Position - position).Magnitude, os.clock(), false
	-- MoveTo gives up after 8 seconds, so a long walk is re-issued until it arrives or runs out of time.
	while os.clock() < limit and humanoid.Health > 0 do
		local finished, reached, stalled = false, false, false
		local connection = humanoid.MoveToFinished:Connect(function(ok)
			finished = true
			reached = ok
		end)
		humanoid:MoveTo(position)
		-- Checked every frame, since a slower poll leaves the Humanoid standing still between waypoints.
		while not finished and os.clock() < limit and humanoid.Health > 0 and not passed() and not (stopEarly and stopEarly()) do
			task.wait()
			local gap = (rootPart.Position - position).Magnitude
			if gap < closest - 0.5 then closest, progressAt = gap, os.clock() end
			-- A character pressed against something makes no headway, so it gets one jump and then gives up
			-- instead of pushing until the time limit runs out.
			if os.clock() - progressAt > STALL_S then
				if jumped then
					stalled = true
					break
				end
				jumped = true
				humanoid.Jump = true
				progressAt = os.clock()
			end
		end
		connection:Disconnect()
		if stopEarly and stopEarly() then
			humanoid:MoveTo(rootPart.Position)
			return true
		end
		if reached or passed() or (rootPart.Position - position).Magnitude < 3 or (stalled and flat() < 2) then return true end
		if stalled then
			humanoid:MoveTo(rootPart.Position)
			return false, "stalled"
		end
		task.wait(0.05)
	end
	if humanoid.Health <= 0 then return false, "died" end
	-- Missing a waypoint's own allowance means the character is stuck, only the walk's deadline is a timeout.
	return false, if os.clock() >= deadline then "timeout" else "stalled"
end

local function computePath(target)
	local okPath, route = pcall(function()
		local created = PathfindingService:CreatePath({ AgentCanJump = true, AgentRadius = 2, AgentHeight = 5 })
		created:ComputeAsync(rootPart.Position, target)
		return created
	end)
	if okPath and route.Status == Enum.PathStatus.Success then return route end
	return nil, if okPath then tostring(route.Status) else "PathError"
end

local waypointCount = 0
local function follow(route)
	local waypoints = route:GetWaypoints()
	waypointCount += #waypoints
	for index, waypoint in waypoints do
		if os.clock() >= deadline then return false, "timeout", index, waypoint.Position end
		if index > 1 then
			if waypoint.Action == Enum.PathWaypointAction.Jump then humanoid.Jump = true end
			-- The last waypoint and one before a jump are walked onto, so the stop and the jump stay where the path put them.
			local stops = index == #waypoints or waypoints[index + 1].Action == Enum.PathWaypointAction.Jump
			local ok, why = walkTo(waypoint.Position, nil, if stops then nil else 2)
			if not ok then return false, why, index, waypoint.Position end
		end
	end
	return true
end

local status = "Direct"
local path, pathGoal
for _, candidate in goals do
	local route, why = computePath(candidate)
	if route then
		path, pathGoal = route, candidate
		break
	end
	status = why
end
local finished, why, stuckAt, toward = true, nil, nil, goals[1]
local repathed = false
if path then
	status = "Path"
	finished, why, stuckAt, toward = follow(path)
	-- A stall can come from a moving obstacle or a gap in the navigation mesh, so one fresh path from where
	-- the character stands gets a try.
	if not finished and why == "stalled" and os.clock() < deadline then
		local again = computePath(pathGoal)
		if again then
			repathed = true
			finished, why, stuckAt, toward = follow(again)
		end
	end
else
	finished, why = walkTo(goals[1], against)
end
humanoid.WalkSpeed = originalSpeed

-- Pathfinding can route through something the character still collides with, such as an invisible wall or a part in
-- another collision group, so the cast respects CanCollide and the character's collision group like movement does.
local function blockerToward(target)
	local direction = Vector3.new(target.X - rootPart.Position.X, 0, target.Z - rootPart.Position.Z)
	if direction.Magnitude < 0.1 then return nil end
	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	params.FilterDescendantsInstances = { character }
	params.RespectCanCollide = true
	params.CollisionGroup = rootPart.CollisionGroup
	-- A cast ignores parts it starts inside, so it starts behind the character, which the filter skips, to catch a wall it is pressed against.
	local from = rootPart.Position - direction.Unit
	local ok, hit = pcall(function()
		return game:GetService("Workspace"):Blockcast(CFrame.lookAt(from, from + direction), Vector3.new(2, 5, 0.5), direction.Unit * 4, params)
	end)
	if not ok or hit == nil then return nil end
	local part = hit.Instance
	return {
		path = pathOf(part),
		class = part.ClassName,
		canCollide = part.CanCollide,
		collisionGroup = part.CollisionGroup,
		transparency = round(part.Transparency),
		distance = round(math.max(0, hit.Distance - 1)),
	}
end

local distance = remaining()
local blocked = nil
if distance >= 4 and why == "stalled" then
	blocked = {
		waypoint = stuckAt,
		toward = { round(toward.X), round(toward.Y), round(toward.Z) },
		by = blockerToward(toward),
		humanoid = { walkSpeed = humanoid.WalkSpeed, state = humanoid:GetState().Name, sit = humanoid.Sit, anchored = rootPart.Anchored },
	}
end
return {
	reached = distance < 4,
	finished = finished,
	route = status,
	waypoints = waypointCount,
	distance = round(distance),
	position = { round(rootPart.Position.X), round(rootPart.Position.Y), round(rootPart.Position.Z) },
	seconds = round(os.clock() - started),
	stopped = if distance >= 4 then why else nil,
	repathed = if repathed then true else nil,
	blocked = blocked,
}
`, args);
}

// A port of fork/fuzzy-edit.ts without the line anchor (spans are 1-based and inclusive here), kept in step by a parity test.
export const FUZZY_MATCH_LUAU = String.raw`
local FUZZY_QUOTE_LINES = 12
local FUZZY_QUOTE_CHARS = 160
local FUZZY_LISTED_RANGES = 10
local FUZZY_QUOTED_CANDIDATES = 3
local FUZZY_BUDGET = 300000

local function fuzzyNormalize(text)
	local out, starts, ends = {}, {}, {}
	local n, pending = 0, nil
	for i = 1, #text do
		local byte = string.byte(text, i)
		if byte == 32 or byte == 9 or byte == 13 then
			if pending == nil then pending = i end
		elseif byte == 10 then
			n += 1
			out[n], starts[n], ends[n] = "\n", pending or i, i
			pending = nil
		else
			if pending ~= nil then
				n += 1
				out[n], starts[n], ends[n] = " ", pending, i - 1
				pending = nil
			end
			n += 1
			out[n], starts[n], ends[n] = string.char(byte), i, i
		end
	end
	return table.concat(out), starts, ends
end

local function fuzzyLocate(source, needle)
	local wanted = fuzzyNormalize(needle)
	if wanted == "" then return {} end
	-- Normalizing drops a trailing space or tab, which was a word boundary, so the script needs whitespace there too.
	local boundary = string.find(needle, "[ \t\r]$") ~= nil
	local text, starts, ends = fuzzyNormalize(source)
	local spans = {}
	local from, line, scanned = 1, 1, 1
	while true do
		local a, b = string.find(text, wanted, from, true)
		if a == nil then break end
		local after = string.sub(text, b + 1, b + 1)
		if boundary and after ~= "" and after ~= " " and after ~= "\n" then
			-- A skipped candidate may overlap one that counts, so resume one character on.
			from = a + 1
		else
			-- The run after the match stands for the trailing whitespace, so new_string's own replaces it.
			if boundary and after == " " then b += 1 end
			local first, last = starts[a], ends[b]
			local _, before = string.gsub(string.sub(source, scanned, first - 1), "\n", "")
			line += before
			local _, inside = string.gsub(string.sub(source, first, last - 1), "\n", "")
			table.insert(spans, { first = first, last = last, startLine = line, endLine = line + inside })
			scanned = first
			from = b + 1
		end
	end
	return spans
end

local function fuzzyRange(span)
	return if span.startLine == span.endLine then tostring(span.startLine) else span.startLine .. "-" .. span.endLine
end

local function fuzzyRanges(spans)
	local ranges = {}
	for i = 1, math.min(#spans, FUZZY_LISTED_RANGES) do ranges[i] = fuzzyRange(spans[i]) end
	return table.concat(ranges, ", ") .. (if #spans > FUZZY_LISTED_RANGES then ", ..." else "")
end

local function fuzzyLines(text)
	local lines = string.split(text, "\n")
	if #lines > 1 and lines[#lines] == "" then table.remove(lines) end
	return lines
end

local function fuzzyQuote(lines, startLine, endLine)
	local last = math.min(endLine, startLine + FUZZY_QUOTE_LINES - 1)
	local out = {}
	for n = startLine, last do
		local line = string.gsub(lines[n] or "", "\r$", "")
		-- Error text is JSON encoded, which rejects invalid UTF-8.
		if utf8.len(line) == nil then line = string.gsub(line, "[\128-\255]", "?") end
		if utf8.len(line) > FUZZY_QUOTE_CHARS then
			line = string.sub(line, 1, utf8.offset(line, FUZZY_QUOTE_CHARS + 1) - 1) .. "..."
		end
		table.insert(out, n .. ": " .. line)
	end
	if endLine > last then table.insert(out, "... " .. (endLine - last) .. " more lines") end
	return table.concat(out, "\n")
end

local function fuzzyKey(line)
	return (string.gsub((string.gsub(line, "[ \t\r]+", " ")), "^ ?(.-) ?$", "%1"))
end

local function fuzzyBigrams(key)
	local counts = {}
	for i = 1, #key - 1 do
		local gram = string.sub(key, i, i + 1)
		counts[gram] = (counts[gram] or 0) + 1
	end
	return counts
end

local function fuzzySimilarity(a, b, ga, gb)
	if a == b then return 1 end
	if #a < 2 or #b < 2 then return 0 end
	local overlap = 0
	for gram, count in ga do
		local other = gb[gram]
		if other ~= nil then overlap += math.min(count, other) end
	end
	return 2 * overlap / (#a + #b - 2)
end

local function fuzzyClosest(source, needle)
	local lines = fuzzyLines(source)
	local wanted = fuzzyLines(needle)
	local keys, grams, wantedKeys, wantedGrams = {}, {}, {}, {}
	for i, line in lines do
		keys[i] = fuzzyKey(line)
		grams[i] = fuzzyBigrams(keys[i])
	end
	for i, line in wanted do
		wantedKeys[i] = fuzzyKey(line)
		wantedGrams[i] = fuzzyBigrams(wantedKeys[i])
	end
	local windows = math.max(1, #lines - #wanted + 1)
	local compared = math.min(#wanted, #lines, math.max(1, math.floor(FUZZY_BUDGET / windows)))
	local best, bestStart, work = -1, 1, 0
	for s = 1, windows do
		local score = 0
		for i = 1, compared do
			score += fuzzySimilarity(wantedKeys[i], keys[s + i - 1], wantedGrams[i], grams[s + i - 1])
		end
		if score > best then
			best = score
			bestStart = s
		end
		work += compared
		if work >= 20000 then
			work = 0
			task.wait()
		end
	end
	local closest = { startLine = bestStart, endLine = math.min(#lines, bestStart + #wanted - 1) }
	return lines, closest, math.floor(best / compared * 100 + 0.5)
end

-- Returns the spans to replace, or nil and an error quoting the matches or the closest lines.
local function fuzzyMatch(source, needle, all)
	if fuzzyNormalize(needle) == "" then return nil, "old_string not found, and it is only whitespace." end
	local spans = fuzzyLocate(source, needle)
	if #spans == 1 or (all and #spans > 0) then return spans end
	if #spans > 1 then
		local lines = fuzzyLines(source)
		local quotes = {}
		for i = 1, math.min(#spans, FUZZY_QUOTED_CANDIDATES) do quotes[i] = fuzzyQuote(lines, spans[i].startLine, spans[i].endLine) end
		return nil, ("old_string is not exact and matches %d places ignoring whitespace (lines %s). Include more surrounding lines to make it unique:\n%s"):format(
			#spans, fuzzyRanges(spans), table.concat(quotes, "\n--\n"))
	end
	local lines, closest, percent = fuzzyClosest(source, needle)
	return nil, ("old_string not found, even ignoring whitespace. Closest text is %s %s (%d%% similar):\n%s"):format(
		if closest.startLine == closest.endLine then "line" else "lines", fuzzyRange(closest), percent, fuzzyQuote(lines, closest.startLine, closest.endLine))
end

local function fuzzyReplace(source, spans, replacement)
	local pieces, from = {}, 1
	for _, span in spans do
		table.insert(pieces, string.sub(source, from, span.first - 1))
		table.insert(pieces, replacement)
		from = span.last + 1
	end
	table.insert(pieces, string.sub(source, from))
	return table.concat(pieces)
end
`;

export function multiEditLuau(args: {
  path: string;
  parent_path?: string;
  name?: string;
  class_name?: string;
  edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }>;
}): string {
  return withArgs(String.raw`
${FUZZY_MATCH_LUAU}
local ScriptEditorService = game:GetService("ScriptEditorService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local RunService = game:GetService("RunService")
if RunService:IsRunning() then return { error = "multi_edit edits the edit DataModel; stop the playtest or target edit" } end

local target = resolve(ARGS.path)
local parent = nil
local created = false
if target == nil then
	if ARGS.class_name == nil then return { error = "script not found: " .. ARGS.path .. "; pass class_name to create it" } end
	parent = resolve(ARGS.parent_path)
	if parent == nil then return { error = "parent not found: " .. tostring(ARGS.parent_path) } end
	created = true
elseif not target:IsA("LuaSourceContainer") then
	return { error = ARGS.path .. " is a " .. target.ClassName .. ", not a script" }
end

local source = if created then "" else ScriptEditorService:GetEditorSource(target)
local fuzzyEdits = {}
for index, edit in ARGS.edits do
	local old, new = edit.old_string, edit.new_string
	if old == new then return { error = ("edit %d: old_string and new_string are identical"):format(index) } end
	if old == "" then
		if source ~= "" then return { error = ("edit %d: an empty old_string only sets the content of a new or empty script"):format(index) } end
		source = new
	else
		local first, last = string.find(source, old, 1, true)
		if first == nil then
			local spans, problem = fuzzyMatch(source, old, edit.replace_all == true)
			if spans == nil then return { error = ("edit %d: %s"):format(index, problem) } end
			-- Lines are where the match stood when this edit ran, since later edits in the batch may shift them.
			table.insert(fuzzyEdits, { edit = index, lines = fuzzyRanges(spans), matches = #spans })
			source = fuzzyReplace(source, spans, new)
		elseif edit.replace_all then
			local pieces, from, count = {}, 1, 0
			while true do
				local a, b = string.find(source, old, from, true)
				if a == nil then break end
				table.insert(pieces, string.sub(source, from, a - 1))
				table.insert(pieces, new)
				from = b + 1
				count += 1
			end
			table.insert(pieces, string.sub(source, from))
			source = table.concat(pieces)
		else
			if string.find(source, old, last + 1, true) then
				return { error = ("edit %d: old_string occurs more than once; add context or set replace_all"):format(index) }
			end
			source = string.sub(source, 1, first - 1) .. new .. string.sub(source, last + 1)
		end
	end
end

local recording = nil
pcall(function() recording = ChangeHistoryService:TryBeginRecording("MCP multi_edit") end)
local ok, err = pcall(function()
	if created then
		target = Instance.new(ARGS.class_name)
		target.Name = ARGS.name
		target.Parent = parent
	end
	ScriptEditorService:UpdateSourceAsync(target, function() return source end)
end)
if recording then
	pcall(function()
		ChangeHistoryService:FinishRecording(recording, if ok then Enum.FinishRecordingOperation.Commit else Enum.FinishRecordingOperation.Cancel)
	end)
end
if not ok then return { error = tostring(err) } end
local _, lines = string.gsub(source, "\n", "")
return {
	path = pathOf(target), created = created, edits = #ARGS.edits, lines = lines + 1, bytes = #source,
	fuzzy = if #fuzzyEdits > 0 then true else nil, fuzzyEdits = if #fuzzyEdits > 0 then fuzzyEdits else nil,
}
`, args);
}

export type CameraPlacement = { position: number[]; look_at?: number[] };
export type CameraSave = { cframe: number[]; focus: number[]; camera_type?: string };

// Each set stashes the camera it found in _G unless an earlier set already did. _G persists across calls in one plugin VM.
// The restore prefers that stash, so a move whose reply never reached the server is still undone.
export function cameraSetLuau(args: CameraPlacement): string {
  return withArgs(String.raw`
if game:GetService("RunService"):IsRunning() then
	return { error = "this simulation has no playtest client whose camera could move. Stop it or start a play session." }
end
local camera = game:GetService("Workspace").CurrentCamera
if _G.MCPCaptureEditCamera == nil then
	_G.MCPCaptureEditCamera = { saved = { cframe = { camera.CFrame:GetComponents() }, focus = { camera.Focus:GetComponents() } } }
end
local position = Vector3.new(ARGS.position[1], ARGS.position[2], ARGS.position[3])
local target = if ARGS.look_at then Vector3.new(ARGS.look_at[1], ARGS.look_at[2], ARGS.look_at[3]) else position + camera.CFrame.LookVector
camera.CFrame = CFrame.lookAt(position, target)
camera.Focus = CFrame.new(target)
-- Let the viewport render the new view before it is captured.
task.wait(0.2)
return { saved = _G.MCPCaptureEditCamera.saved, held = (camera.CFrame.Position - position).Magnitude < 0.05 }
`, args);
}

export function cameraRestoreLuau(args: { saved?: CameraSave }): string {
  return withArgs(String.raw`
local stash = _G.MCPCaptureEditCamera
_G.MCPCaptureEditCamera = nil
local saved = if stash ~= nil then stash.saved else ARGS.saved
if saved == nil then return { restored = false } end
local camera = game:GetService("Workspace").CurrentCamera
camera.CFrame = CFrame.new(table.unpack(saved.cframe))
camera.Focus = CFrame.new(table.unpack(saved.focus))
return { restored = true }
`, args);
}

export function clientCameraSetLuau(args: CameraPlacement): string {
  return withArgs(String.raw`
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")
local camera = Workspace.CurrentCamera
if camera == nil then return { error = "the client has no CurrentCamera" } end
if _G.MCPCaptureClientCamera == nil then
	_G.MCPCaptureClientCamera = {
		saved = { cframe = { camera.CFrame:GetComponents() }, focus = { camera.Focus:GetComponents() }, camera_type = camera.CameraType.Name },
		frames = 0,
		bound = false,
	}
end
local stash = _G.MCPCaptureClientCamera
local position = Vector3.new(ARGS.position[1], ARGS.position[2], ARGS.position[3])
local target = if ARGS.look_at then Vector3.new(ARGS.look_at[1], ARGS.look_at[2], ARGS.look_at[3]) else position + camera.CFrame.LookVector
stash.view = CFrame.lookAt(position, target)
stash.focus = CFrame.new(target)
-- The PlayerModule camera scripts rewrite CFrame every frame unless the camera is Scriptable.
camera.CameraType = Enum.CameraType.Scriptable
camera.CFrame = stash.view
camera.Focus = stash.focus
if not stash.bound then
	-- Game cameras that set CFrame every frame whatever the CameraType would replace the view before the capture.
	stash.bound = pcall(function()
		RunService:BindToRenderStep("MCPCaptureCamera", Enum.RenderPriority.Last.Value + 1, function()
			local active = _G.MCPCaptureClientCamera
			local current = Workspace.CurrentCamera
			if active == nil or active.view == nil or current == nil then return end
			current.CFrame = active.view
			current.Focus = active.focus
			active.frames += 1
		end)
	end)
end
if stash.guardCamera ~= camera then
	if stash.guard ~= nil then stash.guard:Disconnect() end
	-- RenderStepped connections run after every render step binding, so a game script writing CFrame there still won.
	-- Putting the view back whenever anything changes it also covers Heartbeat and Stepped writers.
	stash.guardCamera = camera
	stash.guard = camera:GetPropertyChangedSignal("CFrame"):Connect(function()
		local active = _G.MCPCaptureClientCamera
		if active == nil or active.view == nil or camera.CFrame == active.view then return end
		camera.CFrame = active.view
	end)
end
-- Two rendered frames so the capture shows the new view, bounded in case the window is not rendering.
local start = stash.frames
local deadline = os.clock() + 1
while stash.frames - start < 2 and os.clock() < deadline do task.wait() end
local current = Workspace.CurrentCamera
return { saved = stash.saved, held = current ~= nil and (current.CFrame.Position - position).Magnitude < 0.05 }
`, args);
}

export function clientCameraRestoreLuau(args: { saved?: CameraSave }): string {
  return withArgs(String.raw`
local stash = _G.MCPCaptureClientCamera
_G.MCPCaptureClientCamera = nil
-- Unbound even without a stash, so no binding outlives the restore and keeps holding the camera.
pcall(function() game:GetService("RunService"):UnbindFromRenderStep("MCPCaptureCamera") end)
if stash ~= nil and stash.guard ~= nil then stash.guard:Disconnect() end
local saved = if stash ~= nil then stash.saved else ARGS.saved
if saved == nil then return { restored = false } end
local camera = game:GetService("Workspace").CurrentCamera
camera.CFrame = CFrame.new(table.unpack(saved.cframe))
camera.Focus = CFrame.new(table.unpack(saved.focus))
-- Custom hands the camera back to the PlayerModule, which resumes following the character.
camera.CameraType = (Enum.CameraType :: any)[saved.camera_type]
return { restored = true }
`, args);
}
