import { withArgs } from '../fork-luau.js';

export type Spot = string | number[];

// Boxes are world axis aligned (lo, hi). Invisible parts without collision are triggers and zones, not scenery.
const GEOMETRY = String.raw`
local Workspace = game:GetService("Workspace")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local TOL = ARGS.tolerance or 0.05
local PAD = TOL + 0.05
local DROP_LIMIT = 2000
local SAMPLES = { { 0, 0 }, { 1, 1 }, { 1, -1 }, { -1, 1 }, { -1, -1 } }
local terrain = Workspace.Terrain

local function vec(v)
	return { round(v.X, 3), round(v.Y, 3), round(v.Z, 3) }
end

local function vmin(a, b)
	return Vector3.new(math.min(a.X, b.X), math.min(a.Y, b.Y), math.min(a.Z, b.Z))
end

local function vmax(a, b)
	return Vector3.new(math.max(a.X, b.X), math.max(a.Y, b.Y), math.max(a.Z, b.Z))
end

local function ghost(part)
	return part.Transparency >= 1 and not part.CanCollide
end

local function partBox(part)
	local cf, half = part.CFrame, part.Size / 2
	local r, u, l = cf.RightVector, cf.UpVector, cf.LookVector
	local extent = Vector3.new(
		math.abs(r.X) * half.X + math.abs(u.X) * half.Y + math.abs(l.X) * half.Z,
		math.abs(r.Y) * half.X + math.abs(u.Y) * half.Y + math.abs(l.Y) * half.Z,
		math.abs(r.Z) * half.X + math.abs(u.Z) * half.Y + math.abs(l.Z) * half.Z
	)
	return cf.Position - extent, cf.Position + extent
end

local function unionBox(parts)
	local lo, hi
	for _, part in parts do
		local a, b = partBox(part)
		lo = if lo then vmin(lo, a) else a
		hi = if hi then vmax(hi, b) else b
	end
	return lo, hi
end

-- Visible or colliding parts when there are any, so hitboxes do not inflate a model's box.
local function partsOf(instance)
	local solid, ghosts = {}, {}
	local function consider(item)
		if item:IsA("BasePart") and item ~= terrain then
			table.insert(if ghost(item) then ghosts else solid, item)
		end
	end
	consider(instance)
	for _, item in instance:GetDescendants() do
		consider(item)
	end
	return if #solid > 0 then solid else ghosts
end

local function boundsOf(instance)
	if instance:IsA("Attachment") then
		local point = instance.WorldPosition
		return point, point
	end
	local parts = partsOf(instance)
	if #parts == 0 then return nil end
	return unionBox(parts)
end

-- Each box's extent along the other's local axes: exact for aligned blocks, an upper bound otherwise.
local function projectInto(box, other)
	local rel = box.CFrame:ToObjectSpace(other.CFrame)
	local h, half, p = other.Size / 2, box.Size / 2, rel.Position
	local r, u, l = rel.RightVector, rel.UpVector, rel.LookVector
	local ex = math.abs(r.X) * h.X + math.abs(u.X) * h.Y + math.abs(l.X) * h.Z
	local ey = math.abs(r.Y) * h.X + math.abs(u.Y) * h.Y + math.abs(l.Y) * h.Z
	local ez = math.abs(r.Z) * h.X + math.abs(u.Z) * h.Y + math.abs(l.Z) * h.Z
	local ix = math.min(p.X + ex, half.X) - math.max(p.X - ex, -half.X)
	local iy = math.min(p.Y + ey, half.Y) - math.max(p.Y - ey, -half.Y)
	local iz = math.min(p.Z + ez, half.Z) - math.max(p.Z - ez, -half.Z)
	local inside = p.X - ex >= -half.X - TOL and p.X + ex <= half.X + TOL
		and p.Y - ey >= -half.Y - TOL and p.Y + ey <= half.Y + TOL
		and p.Z - ez >= -half.Z - TOL and p.Z + ez <= half.Z + TOL
	return math.min(ix, iy, iz), math.max(ix, 0) * math.max(iy, 0) * math.max(iz, 0), inside
end

-- Separating axis depth over both boxes' face axes, negative when they are apart.
local function overlapOf(a, b)
	local depthA, volumeA, bInA = projectInto(a, b)
	local depthB, volumeB, aInB = projectInto(b, a)
	return math.min(depthA, depthB), math.min(volumeA, volumeB), aInB, bInA
end

local characters = {}
for _, player in Players:GetPlayers() do
	if player.Character then table.insert(characters, player.Character) end
end

local function withCharacters(exclude)
	local filter = table.clone(exclude)
	for _, character in characters do
		table.insert(filter, character)
	end
	return filter
end

-- Bounds queries return parts whose own box is near, so each candidate is confirmed against its real orientation.
-- MaxParts stays unlimited because a capped list can drop the one part that matters.
local function touching(center, size, exclude, solidOnly)
	local params = OverlapParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	params.FilterDescendantsInstances = withCharacters(exclude)
	params.RespectCanCollide = solidOnly
	local box = { CFrame = CFrame.new(center), Size = vmax(size, Vector3.new(0.05, 0.05, 0.05)) }
	local ok, parts = pcall(function()
		return Workspace:GetPartBoundsInBox(box.CFrame, box.Size, params)
	end)
	if not ok then return nil end
	for _, part in parts do
		if part ~= terrain and not ghost(part) and overlapOf(box, part) > 0 then return part end
	end
	return nil
end

-- Only a part reaching the bottom slab holds a box up, so props sunk into its top and ceilings a lamp hangs from do not.
-- side widens the slab so a wall holds up the sign mounted on it.
local function supportOf(lo, hi, exclude, solidOnly, side)
	local s = if side then PAD * 2 else 0
	local center = Vector3.new((lo.X + hi.X) / 2, lo.Y, (lo.Z + hi.Z) / 2)
	return touching(center, Vector3.new(hi.X - lo.X + s, PAD * 2, hi.Z - lo.Z + s), exclude, solidOnly)
end

-- Anything on or in a box with nothing at all under it tells a ground plane from a stray part.
local function carries(lo, hi, exclude)
	return touching((lo + hi) / 2, hi - lo + Vector3.new(PAD * 2, PAD * 2, PAD * 2), exclude, false) ~= nil
end

-- Rays start at the box top so a bottom sunk into the ground still finds it.
-- A hit whose bottom sits above the box bottom is carried by the box, not under it.
local function groundBelow(lo, hi, exclude, solidOnly)
	local filter = withCharacters(exclude)
	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	params.FilterDescendantsInstances = filter
	params.RespectCanCollide = solidOnly
	local cx, cz = (lo.X + hi.X) / 2, (lo.Z + hi.Z) / 2
	local ix, iz = (hi.X - lo.X) * 0.45, (hi.Z - lo.Z) * 0.45
	local top = hi.Y + 0.05
	local direction = Vector3.new(0, -(hi.Y - lo.Y + DROP_LIMIT), 0)
	local best, below
	for _, sample in SAMPLES do
		local origin = Vector3.new(cx + sample[1] * ix, top, cz + sample[2] * iz)
		for _ = 1, 8 do
			local hit = Workspace:Raycast(origin, direction, params)
			if hit == nil then break end
			local skip = hit.Instance ~= terrain and hit.Instance:IsA("BasePart")
				and (ghost(hit.Instance) or partBox(hit.Instance).Y > lo.Y + PAD)
			if skip then
				table.insert(filter, hit.Instance)
				params.FilterDescendantsInstances = filter
			else
				local gap = math.max(lo.Y - hit.Position.Y, 0)
				if best == nil or gap < best then
					best, below = gap, hit.Instance
				end
				break
			end
		end
	end
	return best, below
end

-- Accessories are left out because they do not collide and would inflate the agent.
local function bodySize(model)
	local parts = {}
	for _, item in model:GetDescendants() do
		if item:IsA("BasePart") and item:FindFirstAncestorOfClass("Accessory") == nil then table.insert(parts, item) end
	end
	if #parts == 0 then return nil end
	local lo, hi = unionBox(parts)
	return hi - lo
end

local function characterStats()
	local stats = { gravity = Workspace.Gravity }
	local humanoid
	if RunService:IsRunning() then
		local player = Players.LocalPlayer
		if player == nil or player.Character == nil then
			for _, other in Players:GetPlayers() do
				if other.Character then
					player = other
					break
				end
			end
		end
		local character = player and player.Character
		humanoid = character and character:FindFirstChildOfClass("Humanoid")
	end
	local body
	if humanoid then
		stats.source = pathOf(humanoid)
		stats.walkSpeed = humanoid.WalkSpeed
		stats.useJumpPower = humanoid.UseJumpPower
		stats.jumpPower = humanoid.JumpPower
		stats.jumpHeight = humanoid.JumpHeight
		body = humanoid.Parent
	else
		local StarterPlayer = game:GetService("StarterPlayer")
		stats.source = "StarterPlayer"
		stats.walkSpeed = readable(StarterPlayer, "CharacterWalkSpeed")
		stats.useJumpPower = readable(StarterPlayer, "CharacterUseJumpPower")
		stats.jumpPower = readable(StarterPlayer, "CharacterJumpPower")
		stats.jumpHeight = readable(StarterPlayer, "CharacterJumpHeight")
		body = StarterPlayer:FindFirstChild("StarterCharacter")
	end
	if body and body:IsA("Model") then
		local ok, size = pcall(bodySize, body)
		if ok and size then
			stats.radius = round(math.max(size.X, size.Z) / 2)
			stats.height = round(size.Y)
		end
	end
	return stats
end
`;

export function spatialAuditLuau(args: { root: string; paths?: string[]; limit: number; tolerance: number; max_parts: number; time_budget_s: number }): string {
  return withArgs(GEOMETRY + String.raw`
-- Spatial queries only see Workspace, so anything elsewhere would be judged against unrelated geometry.
local function inWorkspace(instance)
	return instance == Workspace or (not instance:IsA("WorldRoot") and instance:FindFirstAncestorWhichIsA("WorldRoot") == Workspace)
end

local root = resolve(ARGS.root)
if root == nil then return { error = "root not found: " .. tostring(ARGS.root) } end
if root == game then root = Workspace end
if not inWorkspace(root) then return { error = pathOf(root) .. " is not in Workspace, and spatial queries only see Workspace" } end
local LIMIT = ARGS.limit

local objects, ownerOf, scanned, missing, notInWorkspace = {}, {}, {}, {}, {}
local partCapHit = false
local visited = 0

local function pace()
	visited += 1
	if visited % 4000 == 0 then task.wait() end
end

-- Workspace and WorldModel are Models too, but they are worlds, not objects.
local function isObjectModel(instance)
	return instance:IsA("Model") and not instance:IsA("WorldRoot")
end

local function addObject(instance)
	local entry = { instance = instance, parts = {} }
	local function add(item)
		if not item:IsA("BasePart") or item == terrain or ownerOf[item] ~= nil then return end
		if #scanned >= ARGS.max_parts then
			partCapHit = true
			return
		end
		ownerOf[item] = entry
		table.insert(entry.parts, item)
		table.insert(scanned, item)
	end
	add(instance)
	for _, item in instance:GetDescendants() do
		pace()
		add(item)
	end
	if #entry.parts > 0 then table.insert(objects, entry) end
end

local function discover(container)
	for _, child in container:GetChildren() do
		pace()
		if child:IsA("WorldRoot") or child:IsA("Camera") then
			continue
		elseif isObjectModel(child) then
			if Players:GetPlayerFromCharacter(child) == nil then addObject(child) end
		elseif child:IsA("BasePart") then
			addObject(child)
		else
			discover(child)
		end
	end
end

if type(ARGS.paths) == "table" and #ARGS.paths > 0 then
	for _, path in ARGS.paths do
		local instance = resolve(path)
		if instance == nil then
			table.insert(missing, path)
		elseif not inWorkspace(instance) then
			table.insert(notInWorkspace, pathOf(instance))
		elseif isObjectModel(instance) or instance:IsA("BasePart") then
			addObject(instance)
		else
			discover(instance)
		end
	end
elseif root:IsA("BasePart") then
	addObject(root)
else
	discover(root)
end

local function grounded(part)
	if part.Anchored then return true end
	local rootPart = readable(part, "AssemblyRootPart")
	return rootPart ~= nil and rootPart.Anchored
end

local function constrained(parts)
	for i, part in parts do
		if i > 50 then break end
		local ok, joints = pcall(function() return part:GetJoints() end)
		if ok then
			for _, joint in joints do
				if joint:IsA("Constraint") then return true end
			end
		end
	end
	return false
end

local floating, falling, assemblies, assemblyOrder = {}, {}, {}, {}
for _, entry in objects do
	pace()
	local solid, held, loose = {}, {}, {}
	for _, part in entry.parts do
		local still = grounded(part)
		if not ghost(part) then
			table.insert(solid, part)
			if still then table.insert(held, part) end
		end
		if not still then table.insert(loose, part) end
	end
	entry.lo, entry.hi = unionBox(if #solid > 0 then solid else entry.parts)
	-- Loose parts are judged as assemblies below, so a hinged door cannot hide the floating house it hangs on.
	if #held > 0 then
		local lo, hi = unionBox(held)
		local exclude = { entry.instance }
		if supportOf(lo, hi, exclude, false, true) == nil then
			local gap, below = groundBelow(lo, hi, exclude, false)
			-- Nothing at all underneath while carrying other things means this is the ground itself.
			if (gap ~= nil and gap > TOL) or (gap == nil and not carries(lo, hi, exclude)) then
				table.insert(floating, { instance = entry.instance, gap = gap, below = below, bottom = lo.Y })
			end
		end
	end
	for _, part in loose do
		local rootPart = readable(part, "AssemblyRootPart") or part
		local assembly = assemblies[rootPart]
		if assembly == nil then
			assembly = { rootPart = rootPart, parts = {} }
			assemblies[rootPart] = assembly
			table.insert(assemblyOrder, assembly)
		end
		table.insert(assembly.parts, part)
	end
end

for _, assembly in assemblyOrder do
	pace()
	-- A Humanoid holds its rig up by HipHeight on legs that do not collide, so the whole rig sets its bottom.
	local model = assembly.rootPart:FindFirstAncestorOfClass("Model")
	local rig = model ~= nil and model:FindFirstChildOfClass("Humanoid") ~= nil
	local colliding = {}
	for _, part in assembly.parts do
		if rig or part.CanCollide then table.insert(colliding, part) end
	end
	local row
	if #colliding == 0 then
		row = { reason = "no colliding parts, falls through everything" }
	else
		local lo, hi = unionBox(colliding)
		if supportOf(lo, hi, assembly.parts, true, false) == nil then
			local gap, below = groundBelow(lo, hi, assembly.parts, true)
			if gap == nil or gap > TOL then row = { drop = gap, below = below } end
		end
	end
	if row then
		row.rootPart = assembly.rootPart
		row.parts = #assembly.parts
		row.constrained = constrained(assembly.parts) or nil
		table.insert(falling, row)
	end
end

-- Only a block's box is its shape, so containment in wedges, cylinders and meshes is not claimed.
local function block(part)
	return part:IsA("Part") and readable(part, "Shape") == "Block"
end

local index = {}
for i, part in scanned do
	index[part] = i
end
local playerPart = {}
for _, character in characters do
	for _, item in character:GetDescendants() do
		playerPart[item] = true
	end
end

-- Unscanned parts group the way a full audit would, under their outermost Model or BasePart below Workspace.
local outerOf = {}
local function outermost(instance)
	if instance == nil or instance:IsA("WorldRoot") then return nil end
	local outer = outerOf[instance]
	if outer == nil then
		outer = outermost(instance.Parent) or (if isObjectModel(instance) or instance:IsA("BasePart") then instance else false)
		outerOf[instance] = outer
	end
	return outer or nil
end

local ownerIds, nextOwnerId = {}, 0
local function ownerOfHit(part)
	local entry = ownerOf[part]
	if entry then return entry.instance end
	return outermost(part) or part
end
local function ownerId(owner)
	local id = ownerIds[owner]
	if id == nil then
		nextOwnerId += 1
		id = nextOwnerId
		ownerIds[owner] = id
	end
	return id
end

local pairRows, pairsByKey, buried, buriedSeen = {}, {}, {}, {}
-- A Humanoid rig overlaps on purpose: the root part sits on the torso and accessory handles sit inside the head.
local rigs = {}
local function rigOf(part)
	local cached = rigs[part]
	if cached ~= nil then return cached or nil end
	local model = part:FindFirstAncestorOfClass("Model")
	while model ~= nil and model:FindFirstChildOfClass("Humanoid") == nil do
		model = model:FindFirstAncestorOfClass("Model")
	end
	rigs[part] = model or false
	return model
end
local function addBuried(part, container)
	if buriedSeen[part] or not block(container) then return end
	local rig = rigOf(part)
	if rig ~= nil and rig == rigOf(container) then return end
	buriedSeen[part] = true
	local size = part.Size
	table.insert(buried, { part = part, container = container, volume = size.X * size.Y * size.Z })
end

local params = OverlapParams.new()
params.FilterType = Enum.RaycastFilterType.Exclude
local started = os.clock()
local queried, timeCapHit = 0, false
for i, part in scanned do
	if os.clock() - started > ARGS.time_budget_s then
		timeCapHit = true
		break
	end
	if i % 200 == 0 then task.wait() end
	if not ghost(part) then
		queried += 1
		params.FilterDescendantsInstances = { part }
		local ok, hits = pcall(function() return Workspace:GetPartsInPart(part, params) end)
		if ok then
			for _, other in hits do
				-- A pair of scanned parts is handled once, by whichever came first.
				local j = index[other]
				if other ~= terrain and (j == nil or j > i) and not playerPart[other] and not ghost(other) then
					local depth, volume, aInB, bInA = overlapOf(part, other)
					if depth > TOL then
						if aInB then addBuried(part, other) end
						if bInA then addBuried(other, part) end
						local ownerA, ownerB = ownerOf[part].instance, ownerOfHit(other)
						if ownerA ~= ownerB then
							local idA, idB = ownerId(ownerA), ownerId(ownerB)
							local partA, partB = part, other
							if idB < idA then
								idA, idB, ownerA, ownerB, partA, partB = idB, idA, ownerB, ownerA, partB, partA
							end
							local key = idA .. ":" .. idB
							local row = pairsByKey[key]
							if row == nil then
								row = { a = ownerA, b = ownerB, volume = 0, depth = 0, parts = 0 }
								pairsByKey[key] = row
								table.insert(pairRows, row)
							end
							row.volume += volume
							row.parts += 1
							if depth > row.depth then
								row.depth = depth
								row.deepest = { partA, partB }
							end
						end
					end
				end
			end
		end
	end
end

local tiny = {}
for _, part in scanned do
	local size = part.Size
	local dims = { size.X, size.Y, size.Z }
	table.sort(dims)
	if dims[3] < 0.1 or dims[2] < 0.01 then table.insert(tiny, { part = part, largest = dims[3] }) end
end

local xs, ys, zs = {}, {}, {}
local descendants = root:GetDescendants()
table.insert(descendants, root)
local stride = math.max(1, math.floor(#descendants / 20000))
for i = 1, #descendants, stride do
	local item = descendants[i]
	if item:IsA("BasePart") and item ~= terrain then
		local position = item.Position
		table.insert(xs, position.X)
		table.insert(ys, position.Y)
		table.insert(zs, position.Z)
	end
end
descendants = nil

local outside, extent, core, margin = {}, nil, nil, nil
local destroyHeight = readable(Workspace, "FallenPartsDestroyHeight")
-- The main cluster spans the 5th to 95th percentile of part positions, so a few strays cannot stretch it.
if #xs >= 10 then
	table.sort(xs)
	table.sort(ys)
	table.sort(zs)
	local function at(list, q)
		return list[math.clamp(math.floor(#list * q + 0.5), 1, #list)]
	end
	local lo = Vector3.new(at(xs, 0.05), at(ys, 0.05), at(zs, 0.05))
	local hi = Vector3.new(at(xs, 0.95), at(ys, 0.95), at(zs, 0.95))
	core = { lo = lo, hi = hi }
	margin = Vector3.new(math.max(250, (hi.X - lo.X) / 2), math.max(250, (hi.Y - lo.Y) / 2), math.max(250, (hi.Z - lo.Z) / 2))
	extent = { min = vec(lo), max = vec(hi) }
end
for _, entry in objects do
	local center = (entry.lo + entry.hi) / 2
	if finite(destroyHeight) and entry.hi.Y < destroyHeight then
		table.insert(outside, { instance = entry.instance, center = center, distance = destroyHeight - entry.hi.Y, reason = "below FallenPartsDestroyHeight" })
	elseif core then
		local dx = math.max(core.lo.X - center.X, center.X - core.hi.X, 0)
		local dy = math.max(core.lo.Y - center.Y, center.Y - core.hi.Y, 0)
		local dz = math.max(core.lo.Z - center.Z, center.Z - core.hi.Z, 0)
		if dx > margin.X or dy > margin.Y or dz > margin.Z then
			table.insert(outside, { instance = entry.instance, center = center, distance = math.sqrt(dx * dx + dy * dy + dz * dz) })
		end
	end
end

-- Paths are built only for the rows that survive the limit.
local function top(list, severity, describe)
	table.sort(list, function(a, b) return severity(a) > severity(b) end)
	local rows = {}
	for i = 1, math.min(#list, LIMIT) do
		rows[i] = describe(list[i])
	end
	return rows
end

local function far(gap)
	return if gap == nil then math.huge else gap
end

return {
	root = pathOf(root),
	tolerance = TOL,
	scanned = { objects = #objects, parts = #scanned, queried = queried, partCapHit = partCapHit or nil, timeCapHit = timeCapHit or nil },
	missing = if #missing > 0 then missing else nil,
	notInWorkspace = if #notInWorkspace > 0 then notInWorkspace else nil,
	extent = extent,
	counts = { floating = #floating, overlaps = #pairRows, buried = #buried, falling = #falling, tiny = #tiny, outside = #outside },
	floating = top(floating, function(row) return far(row.gap) end, function(row)
		return { path = pathOf(row.instance), gap = row.gap and round(row.gap, 3), below = row.below and pathOf(row.below), bottom = round(row.bottom, 3) }
	end),
	overlaps = top(pairRows, function(row) return row.volume end, function(row)
		return {
			a = pathOf(row.a), b = pathOf(row.b), volume = round(row.volume, 3), depth = round(row.depth, 3), partPairs = row.parts,
			deepest = { pathOf(row.deepest[1]), pathOf(row.deepest[2]) },
		}
	end),
	buried = top(buried, function(row) return row.volume end, function(row)
		return { part = pathOf(row.part), inside = pathOf(row.container), volume = round(row.volume, 3) }
	end),
	falling = top(falling, function(row) return if row.reason then math.huge else far(row.drop) end, function(row)
		return {
			rootPart = pathOf(row.rootPart), parts = row.parts, drop = row.drop and round(row.drop, 3),
			below = row.below and pathOf(row.below), reason = row.reason, constrained = row.constrained,
		}
	end),
	tiny = top(tiny, function(row) return -row.largest end, function(row)
		return { path = pathOf(row.part), size = vec(row.part.Size) }
	end),
	outside = top(outside, function(row) return row.distance end, function(row)
		return { path = pathOf(row.instance), center = vec(row.center), distance = round(row.distance, 1), reason = row.reason }
	end),
}
`, args);
}

export function spatialBoundsLuau(args: { targets: Spot[]; ground: boolean; character: boolean; tolerance: number }): string {
  return withArgs(GEOMETRY + String.raw`
local boxes = {}
for i, spec in ARGS.targets do
	local lo, hi, extents, instance
	if type(spec) == "table" then
		lo = Vector3.new(spec[1], spec[2], spec[3])
		hi, extents = lo, Vector3.zero
	else
		instance = resolve(spec)
		if instance == nil then return { error = "not found: " .. spec } end
		lo, hi = boundsOf(instance)
		if lo == nil then return { error = spec .. " has no parts to measure" } end
		extents = if instance:IsA("BasePart") then instance.Size
			elseif instance:IsA("Model") then instance:GetExtentsSize()
			else hi - lo
	end
	local box = { path = if instance then pathOf(instance) else nil, min = vec(lo), max = vec(hi), extents = vec(extents) }
	if ARGS.ground then
		local gap, below = groundBelow(lo, hi, if instance then { instance } else {}, false)
		box.clearance = gap and round(gap, 3)
		box.below = below and pathOf(below)
	end
	boxes[i] = box
end
return { boxes = boxes, character = if ARGS.character then characterStats() else nil }
`, args);
}

export function spatialReachLuau(args: { from: Spot; to: Spot; can_jump?: boolean }): string {
  return withArgs(GEOMETRY + String.raw`
local PathfindingService = game:GetService("PathfindingService")

-- Path endpoints must sit in open air where a character root would be, never inside the part.
local function pointOf(spec)
	if type(spec) == "table" then return Vector3.new(spec[1], spec[2], spec[3]), nil end
	local instance = resolve(spec)
	if instance == nil then return nil, "not found: " .. spec end
	if instance:IsA("Attachment") then return instance.WorldPosition, pathOf(instance) end
	if instance:IsA("Model") then
		local humanoid = instance:FindFirstChildOfClass("Humanoid")
		if humanoid and humanoid.RootPart then return humanoid.RootPart.Position, pathOf(instance) end
	end
	if instance:IsA("BasePart") or instance:IsA("Model") then
		local lo, hi = boundsOf(instance)
		if lo == nil then return nil, spec .. " has no parts" end
		return Vector3.new((lo.X + hi.X) / 2, hi.Y + 3, (lo.Z + hi.Z) / 2), pathOf(instance)
	end
	return nil, spec .. " is not a BasePart, Model or Attachment"
end

local start, startPath = pointOf(ARGS.from)
if start == nil then return { error = "from " .. startPath } end
local goal, goalPath = pointOf(ARGS.to)
if goal == nil then return { error = "to " .. goalPath } end

local stats = characterStats()
local canJump = ARGS.can_jump
if canJump == nil then
	canJump = if stats.useJumpPower then (stats.jumpPower or 0) > 0 else (stats.jumpHeight or 0) > 0
end
local agent = { AgentRadius = stats.radius or 2, AgentHeight = stats.height or 5, AgentCanJump = canJump }

local result = {
	from = startPath, to = goalPath, start = vec(start), goal = vec(goal),
	direct = round((goal - start).Magnitude),
	agent = { radius = agent.AgentRadius, height = agent.AgentHeight, canJump = canJump, source = stats.source },
}
local path = PathfindingService:CreatePath(agent)
local ok, problem = pcall(function()
	path:ComputeAsync(start, goal)
end)
if not ok then
	result.status = "Error"
	result.problem = tostring(problem)
	return result
end
result.status = path.Status.Name
if path.Status ~= Enum.PathStatus.Success then return result end

local waypoints = path:GetWaypoints()
local length, ascent, jumps = 0, 0, {}
for i, waypoint in waypoints do
	if i > 1 then
		local step = waypoint.Position - waypoints[i - 1].Position
		length += step.Magnitude
		if step.Y > 0 then ascent += step.Y end
	end
	if waypoint.Action == Enum.PathWaypointAction.Jump then table.insert(jumps, waypoint.Position) end
end
result.waypoints = #waypoints
result.length = round(length)
result.ascent = round(ascent)
result.jumps = #jumps
local jumpAt = {}
for i = 1, math.min(#jumps, 10) do
	jumpAt[i] = vec(jumps[i])
end
result.jumpAt = jumpAt
if #waypoints > 0 then
	local last = waypoints[#waypoints].Position
	result.finish = vec(last)
	result.finishToGoal = round((last - goal).Magnitude)
end
return result
`, args);
}
