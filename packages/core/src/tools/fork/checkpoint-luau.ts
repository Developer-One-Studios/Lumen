import { withArgs } from '../fork-luau.js';

const STORE_PRELUDE = String.raw`
if game:GetService("RunService"):IsRunning() then
	return { error = "checkpoint only works on the edit DataModel, not in a running playtest" }
end

-- Snapshots outlive server rebuilds in the plugin VM, so ones laid out by an older build are refused instead of misread.
local FORMAT = 2

-- _G lives as long as the edit plugin VM, so snapshots survive between calls but never reach the saved place.
local STORE = _G.__Lumen_CHECKPOINTS
if STORE == nil then
	STORE = {}
	_G.__Lumen_CHECKPOINTS = STORE
end

local function ids()
	local list = {}
	for id in STORE do table.insert(list, id) end
	table.sort(list)
	return list
end

local function pick(id)
	if id == nil then
		local list = ids()
		if #list == 0 then return nil, { missing = true, existing = list } end
		if #list > 1 then return nil, { error = "pass id, there are several checkpoints: " .. table.concat(list, ", ") } end
		id = list[1]
	end
	local checkpoint = STORE[id]
	if checkpoint == nil then return nil, { missing = true, id = id, existing = ids() } end
	if checkpoint.busy then return nil, { error = "checkpoint " .. id .. " is busy with another call, retry when it finishes" } end
	if checkpoint.format ~= FORMAT then return nil, { error = "checkpoint " .. id .. " was made by an older build of this tool, drop it and create a new one" } end
	return checkpoint
end

local function guarded(checkpoint, work)
	checkpoint.busy = true
	local ok, result = pcall(work)
	checkpoint.busy = nil
	if not ok then return { error = tostring(result) } end
	return result
end
`;

// Fingerprints are keyed by the live Instance, so a diff never has to match instances by path.
const WALK_PRELUDE = String.raw`
local ScriptEditorService = game:GetService("ScriptEditorService")
local Workspace = game:GetService("Workspace")

local NAME, CLASS, PARENT, TOP, SOURCE, ATTRIBUTES, TAGS, FIRST_PROPERTY = 1, 2, 3, 4, 5, 6, 7, 8

local PROPERTIES = {
	"CFrame", "Size", "Position", "Rotation", "Orientation", "PivotOffset", "WorldPivot", "Color", "Transparency",
	"Reflectance", "Material", "MaterialVariant", "Anchored", "CanCollide", "CanTouch", "CanQuery", "CastShadow",
	"CollisionGroup", "Locked", "Massless", "Shape", "MeshId", "TextureID", "DoubleSided", "MeshType", "Scale",
	"Offset", "VertexColor", "C0", "C1",
	"Text", "TextColor3", "TextSize", "TextTransparency", "TextStrokeColor3", "TextStrokeTransparency", "TextScaled",
	"TextWrapped", "TextXAlignment", "TextYAlignment", "RichText", "FontFace", "LineHeight", "BackgroundColor3",
	"BackgroundTransparency", "BorderColor3", "BorderSizePixel", "AnchorPoint", "AutomaticSize", "ClipsDescendants",
	"Visible", "Image", "ImageColor3", "ImageTransparency", "ImageRectOffset", "ImageRectSize", "ScaleType",
	"SliceCenter", "LayoutOrder", "ZIndex", "DisplayOrder", "IgnoreGuiInset", "ResetOnSpawn", "ZIndexBehavior",
	"CornerRadius", "Thickness", "Padding", "PaddingTop", "PaddingBottom", "PaddingLeft", "PaddingRight",
	"FillDirection", "SortOrder", "HorizontalAlignment", "VerticalAlignment", "CellSize", "CellPadding", "AspectRatio",
	"AlwaysOnTop", "MaxDistance", "StudsOffset", "Face", "PixelsPerStud", "SizingMode", "Color3",
	"Density", "Haze", "Glare", "Decay", "Intensity", "Threshold", "Contrast", "Saturation", "TintColor", "Spread",
	"FarIntensity", "NearIntensity", "FocusDistance", "InFocusRadius", "Cover", "SkyboxBk", "SkyboxDn", "SkyboxFt",
	"SkyboxLf", "SkyboxRt", "SkyboxUp", "SunTextureId", "MoonTextureId", "CelestialBodiesShown", "StarCount",
	"SunAngularSize", "MoonAngularSize",
	"Brightness", "Range", "Angle", "Shadows", "SoundId", "Volume", "PlaybackSpeed", "Looped", "RollOffMaxDistance",
	"RollOffMinDistance", "AnimationId", "Texture", "Rate", "Lifetime", "Speed", "SpreadAngle", "Acceleration", "Drag",
	"RotSpeed", "LightEmission", "LightInfluence", "EmissionDirection", "ZOffset", "Width0", "Width1", "FillColor",
	"OutlineColor", "FillTransparency", "OutlineTransparency", "DepthMode", "Heat", "SecondaryColor", "Opacity",
	"RiseVelocity",
	"Enabled", "RunContext", "WalkSpeed", "JumpPower", "JumpHeight", "UseJumpPower", "MaxHealth", "Health", "HipHeight",
	"DisplayName", "ActionText", "ObjectText", "HoldDuration", "MaxActivationDistance", "RequiresLineOfSight",
	"TeamColor", "Neutral", "AutoAssignable", "Duration", "ToolTip", "CanBeDropped", "RequiresHandle", "Grip", "Length",
	"Restitution", "Stiffness", "Damping", "FreeLength", "MaxForce", "Responsiveness", "LimitsEnabled", "UpperAngle",
	"LowerAngle", "ActuatorType", "TargetAngle", "AngularVelocity", "MotorMaxTorque",
}

-- Properties that hold Instances, compared like PROPERTIES and repointed by a revert.
local REFERENCES = {
	"Value", "PrimaryPart", "Part0", "Part1", "Attachment0", "Attachment1", "Adornee", "SoundGroup", "CurrentCamera",
	"ReferenceInstance", "SourceInstance", "TargetInstance", "ChainRoot", "EndEffector", "Target", "Pole",
	"NextSelectionUp", "NextSelectionDown", "NextSelectionLeft", "NextSelectionRight", "SelectionImageObject",
}

-- These follow CFrame wherever both exist, so tracking them would only repeat every move.
local DERIVED = { Position = true, Rotation = true, Orientation = true }

local SERVICE_PROPERTIES = {
	Lighting = {
		"Ambient", "Brightness", "ClockTime", "FogColor", "FogEnd", "FogStart", "GlobalShadows", "OutdoorAmbient",
		"ExposureCompensation", "EnvironmentDiffuseScale", "EnvironmentSpecularScale", "GeographicLatitude",
		"ShadowSoftness", "ColorShift_Top", "ColorShift_Bottom", "Technology",
	},
	Workspace = { "Gravity", "GlobalWind", "FallenPartsDestroyHeight" },
	SoundService = { "AmbientReverb", "DistanceFactor", "DopplerScale", "RolloffScale" },
}

local function get(instance, property)
	return (instance :: any)[property]
end

local lastYield = os.clock()
local function breathe()
	-- Walks over big places would otherwise freeze Studio until they finish.
	if os.clock() - lastYield > 0.05 then
		task.wait()
		lastYield = os.clock()
	end
end

local function same(a, b)
	if a == b then return true end
	if typeof(a) ~= typeof(b) then return false end
	if type(a) == "number" then return a ~= a and b ~= b end
	-- Sequences may not compare by value, and distinct Instances must never match by name.
	return type(a) == "userdata" and typeof(a) ~= "Instance" and tostring(a) == tostring(b)
end

local function sameAttributes(a, b)
	if a == nil or b == nil then return a == b end
	for key, value in a do
		if not same(value, b[key]) then return false end
	end
	for key in b do
		if a[key] == nil then return false end
	end
	return true
end

local function plain(value)
	local kind = typeof(value)
	if kind == "number" then return if finite(value) then round(value, 4) else tostring(value) end
	if kind == "boolean" or kind == "string" then return value end
	if kind == "Color3" then return { round(value.R * 255, 1), round(value.G * 255, 1), round(value.B * 255, 1) } end
	if kind == "EnumItem" then return value.Name end
	return tostring(value)
end

local function sourceOf(instance)
	if not instance:IsA("LuaSourceContainer") then return nil end
	local ok, source = pcall(ScriptEditorService.GetEditorSource, ScriptEditorService, instance)
	if ok and type(source) == "string" then return source end
	ok, source = pcall(get, instance, "Source")
	return if ok then source else nil
end

local function attributesOf(instance)
	local attributes = instance:GetAttributes()
	return if next(attributes) ~= nil then attributes else nil
end

local function tagsOf(instance)
	local ok, tags = pcall(instance.GetTags, instance)
	if not ok or #tags == 0 then return nil end
	table.sort(tags)
	return table.concat(tags, "\0")
end

local function propertiesOf(checkpoint, instance)
	local class = instance.ClassName
	local list = checkpoint.classProperties[class]
	if list == nil then
		list = {}
		local hasCFrame = pcall(get, instance, "CFrame")
		for _, names in { PROPERTIES, REFERENCES } do
			for _, property in names do
				if not (DERIVED[property] and hasCFrame) and pcall(get, instance, property) then
					table.insert(list, property)
				end
			end
		end
		checkpoint.classProperties[class] = list
	end
	return list
end

local function referencesOf(checkpoint, instance)
	local class = instance.ClassName
	local list = checkpoint.classReferences[class]
	if list == nil then
		list = {}
		for _, property in REFERENCES do
			local ok, value = pcall(get, instance, property)
			-- Only ObjectValue.Value holds an Instance among the Value properties, so the type decides.
			if ok and (value == nil or typeof(value) == "Instance") then table.insert(list, property) end
		end
		checkpoint.classReferences[class] = list
	end
	return list
end

-- A reference is stored as the snapshot copy behind its target, so it still matches once a revert swapped that target for a fresh copy.
local function identity(checkpoint, value)
	if typeof(value) ~= "Instance" then return value end
	return checkpoint.originals[value] or checkpoint.copies[value] or value
end

local function fingerprint(checkpoint, instance, top)
	local entry = { instance.Name, instance.ClassName, instance.Parent, top, sourceOf(instance), attributesOf(instance), tagsOf(instance) }
	for index, property in propertiesOf(checkpoint, instance) do
		local ok, value = pcall(get, instance, property)
		if ok then entry[FIRST_PROPERTY + index - 1] = identity(checkpoint, value) end
	end
	return entry
end

local function addField(fields, field)
	fields = fields or {}
	table.insert(fields, field)
	return fields
end

local function changedFields(checkpoint, instance, entry)
	local fields = nil
	if instance.Name ~= entry[NAME] then fields = addField(fields, "Name") end
	if instance.Parent ~= entry[PARENT] then fields = addField(fields, "Parent") end
	if sourceOf(instance) ~= entry[SOURCE] then fields = addField(fields, "Source") end
	if not sameAttributes(attributesOf(instance), entry[ATTRIBUTES]) then fields = addField(fields, "Attributes") end
	if tagsOf(instance) ~= entry[TAGS] then fields = addField(fields, "Tags") end
	for index, property in checkpoint.classProperties[entry[CLASS]] or {} do
		local ok, value = pcall(get, instance, property)
		if not same(entry[FIRST_PROPERTY + index - 1], if ok then identity(checkpoint, value) else nil) then fields = addField(fields, property) end
	end
	return fields
end

-- Clone() drops non-Archivable children, so copies are paired by name and class rather than by position.
local function pairUp(source, copy, visit)
	local stack = { source, copy }
	while #stack > 0 do
		local b = table.remove(stack)
		local a = table.remove(stack)
		visit(a, b)
		local queues, taken = {}, {}
		for _, child in b:GetChildren() do
			local key = child.Name .. "\0" .. child.ClassName
			local queue = queues[key]
			if queue == nil then
				queue = {}
				queues[key] = queue
			end
			table.insert(queue, child)
		end
		for _, child in a:GetChildren() do
			if child.Archivable then
				local key = child.Name .. "\0" .. child.ClassName
				local index = (taken[key] or 0) + 1
				local match = queues[key] and queues[key][index]
				if match then
					taken[key] = index
					table.insert(stack, child)
					table.insert(stack, match)
				end
			end
		end
		breathe()
	end
end

local function rootChildren(root)
	local children = {}
	for _, child in root.container:GetChildren() do
		-- The viewer's camera is not content and Terrain is only captured through include_terrain.
		if root.isWorkspace and (child == Workspace.CurrentCamera or child:IsA("Terrain")) then continue end
		table.insert(children, child)
	end
	return children
end

-- Rebuilds the path an instance had when the checkpoint was made, even after it was destroyed.
local function snapshotPath(checkpoint, instance)
	local parts = {}
	local current = instance
	local entry = checkpoint.prints[current]
	while entry ~= nil do
		table.insert(parts, 1, segment(entry[NAME]))
		current = entry[PARENT]
		entry = checkpoint.prints[current]
	end
	return (checkpoint.rootPaths[current] or "nil") .. table.concat(parts)
end

local function within(path, base)
	if path == base then return true end
	local head = string.sub(path, 1, #base + 1)
	return head == base .. "." or head == base .. "["
end

-- Sourcemap paths arrive as name lists, so every prefix becomes a key that a root child can be looked up by.
local function syncedIndex(synced)
	local prefixes = {}
	for _, parts in synced do
		local key = nil
		for _, part in parts do
			key = if key == nil then part else key .. "\0" .. part
			if prefixes[key] == nil then prefixes[key] = parts end
		end
	end
	return prefixes
end

local function syncedExample(prefixes, root, name)
	local parts = prefixes[root.key .. "\0" .. name]
	if parts == nil then return nil end
	local path = "game"
	for _, part in parts do path ..= segment(part) end
	return path
end

-- Batched into one pass, since a revert can swap thousands of subtrees among hundreds of thousands of fingerprints.
local function extract(checkpoint, tops)
	local taken = {}
	for top in tops do taken[top] = {} end
	for instance, entry in checkpoint.prints do
		local bucket = taken[entry[TOP]]
		if bucket then
			bucket[instance] = entry
			checkpoint.prints[instance] = nil
		end
		breathe()
	end
	return taken
end

-- Ctrl+Z on a revert reattaches the subtree it replaced and detaches the copy, so the retired generation becomes current again.
local function adoptUndone(checkpoint)
	local back = {}
	for _, top in checkpoint.tops do
		local retired = top.retired
		if retired and not top.live:IsDescendantOf(game) and retired.live:IsDescendantOf(game) then back[top] = true end
	end
	if next(back) == nil then return end
	local taken = extract(checkpoint, back)
	for top in back do
		local retired = top.retired
		top.retired = { live = top.live, prints = taken[top] }
		top.live = retired.live
		for instance, entry in retired.prints do
			checkpoint.prints[instance] = entry
			local stored = checkpoint.originals[instance] or checkpoint.copies[instance]
			if stored then checkpoint.currentOf[stored] = instance end
		end
	end
end

local function scan(checkpoint, limit, referrers)
	adoptUndone(checkpoint)
	local prints = checkpoint.prints
	local seen, addedSet, dirty, extras, missingRoots = {}, {}, {}, {}, {}
	local counts = { added = 0, removed = 0, modified = 0 }
	local added, removed, modified, services = {}, {}, {}, {}
	local truncated = false
	local function room(list)
		if #list < limit then return true end
		truncated = true
		return false
	end
	local function visit(instance, owner)
		breathe()
		-- A subtree moved under another root is reached twice.
		if seen[instance] or addedSet[instance] then return end
		if referrers then
			for _, property in referencesOf(checkpoint, instance) do
				local ok, target = pcall(get, instance, property)
				if ok and typeof(target) == "Instance" then
					table.insert(referrers, { instance = instance, property = property, live = target:IsDescendantOf(game) })
				end
			end
		end
		local entry = prints[instance]
		if entry == nil then
			counts.added += 1
			addedSet[instance] = true
			if owner then dirty[owner] = true end
			if not addedSet[instance.Parent] and room(added) then
				table.insert(added, { path = pathOf(instance), class = instance.ClassName })
			end
			return
		end
		seen[instance] = true
		local fields = changedFields(checkpoint, instance, entry)
		if fields or entry[TOP] ~= owner then
			dirty[entry[TOP]] = true
			if owner then dirty[owner] = true end
		end
		if fields then
			counts.modified += 1
			if room(modified) then table.insert(modified, { path = pathOf(instance), class = entry[CLASS], fields = fields }) end
		end
	end
	for _, root in checkpoint.roots do
		if not root.container:IsDescendantOf(game) then
			missingRoots[root] = true
			continue
		end
		if root.top then
			local live = root.top.live
			if live:IsDescendantOf(game) then
				visit(live, root.top)
				for _, instance in live:GetDescendants() do visit(instance, root.top) end
			end
			continue
		end
		for _, child in rootChildren(root) do
			local own = prints[child]
			local owner = if own ~= nil and own[TOP].live == child then own[TOP] else nil
			if owner == nil then table.insert(extras, { root = root, instance = child }) end
			visit(child, owner)
			for _, instance in child:GetDescendants() do visit(instance, owner) end
		end
	end
	for instance, entry in prints do
		if not seen[instance] then
			counts.removed += 1
			dirty[entry[TOP]] = true
			local parent = entry[PARENT]
			if (prints[parent] == nil or seen[parent]) and room(removed) then
				table.insert(removed, { path = snapshotPath(checkpoint, instance), class = entry[CLASS] })
			end
		end
		breathe()
	end
	for _, saved in checkpoint.services do
		for property, before in saved.values do
			local ok, now = pcall(get, saved.root.instance, property)
			if ok and not same(before, now) then
				table.insert(services, { service = saved.root.path, property = property, before = plain(before), after = plain(now) })
			end
		end
	end
	return {
		counts = counts, added = added, removed = removed, modified = modified, services = services,
		dirty = dirty, extras = extras, missingRoots = missingRoots, truncated = truncated,
	}
end

local function sortedDirty(found)
	local list = {}
	for top in found.dirty do table.insert(list, top) end
	table.sort(list, function(a, b) return a.path < b.path end)
	return list
end

local function livePath(instance)
	return if instance:IsDescendantOf(game) then pathOf(instance) else nil
end

-- Why a revert would leave a changed subtree alone, or nil when it can be replaced.
local function skipReason(prefixes, found, top)
	local example = syncedExample(prefixes, top.root, top.name)
	if example == nil and top.live.Name ~= top.name then example = syncedExample(prefixes, top.root, top.live.Name) end
	if example then return "contains scripts synced by Rojo, for example " .. example end
	if found.missingRoots[top.root] then return "its parent " .. top.root.containerPath .. " no longer exists" end
	if top.clone == nil then return "was not Archivable at checkpoint time, so no copy exists" end
	return nil
end
`;

function checkpointSnippet(body: string, args: Record<string, unknown>, walks = true): string {
  return withArgs(STORE_PRELUDE + (walks ? WALK_PRELUDE : '') + body, args);
}

export function checkpointCreateLuau(args: {
  id?: string;
  roots: string[];
  explicit_roots: boolean;
  include_terrain: boolean;
  max_instances: number;
}): string {
  return checkpointSnippet(String.raw`
-- Engine made folders that are restored child by child like services instead of being replaced whole.
local CONTAINERS = { StarterPlayerScripts = true, StarterCharacterScripts = true }

local function findRoot(path)
	local parts = parsePath(path)
	if parts == nil then return nil end
	if #parts == 0 then return game end
	-- FindService, unlike GetService, never adds a missing service to the place.
	local ok, current = pcall(game.FindService, game, parts[1])
	if not ok or current == nil then current = game:FindFirstChild(parts[1]) end
	for i = 2, #parts do
		if current == nil then return nil end
		current = current:FindFirstChild(parts[i])
	end
	return current
end

local id = ARGS.id
if id == nil then
	local n = 1
	while STORE["cp" .. n] ~= nil do n += 1 end
	id = "cp" .. n
elseif STORE[id] ~= nil then
	return { error = "checkpoint " .. id .. " already exists, drop it first or pick another id" }
end

-- Reserved before the first yield so a concurrent create cannot take the same id.
local placeholder = { id = id, busy = true }
STORE[id] = placeholder
local started = os.clock()
local okHeap, heapBefore = pcall(gcinfo)
local ok, result = pcall(function()
	local roots, missingRoots = {}, {}
	for _, path in ARGS.roots do
		local instance = findRoot(path)
		if instance == nil then
			table.insert(missingRoots, path)
		elseif instance == game then
			return { error = "game cannot be a root, name services or folders instead" }
		elseif instance:IsA("Terrain") then
			return { error = "Terrain cannot be a root, pass include_terrain instead" }
		else
			for _, other in roots do
				if instance == other.instance or instance:IsDescendantOf(other.instance) or other.instance:IsDescendantOf(instance) then
					return { error = "roots overlap: " .. path .. " and " .. other.path }
				end
			end
			local whole = instance.Parent ~= game and not CONTAINERS[instance.ClassName]
			local container = if whole then instance.Parent else instance
			local containerPath = pathOf(container)
			table.insert(roots, {
				path = pathOf(instance),
				instance = instance,
				whole = whole,
				container = container,
				containerPath = containerPath,
				key = table.concat(parsePath(containerPath), "\0"),
				isWorkspace = instance == Workspace,
			})
		end
	end
	if ARGS.explicit_roots and #missingRoots > 0 then return { error = "roots not found: " .. table.concat(missingRoots, ", ") } end
	if #roots == 0 then return { error = "none of the roots exist" } end

	local plan, total = {}, 0
	for _, root in roots do
		local children = if root.whole then { root.instance } else rootChildren(root)
		for _, child in children do
			local descendants = child:GetDescendants()
			total += 1 + #descendants
			table.insert(plan, { root = root, child = child, descendants = descendants })
		end
		breathe()
	end
	if total > ARGS.max_instances then
		return { error = ("%d instances under the roots exceed max_instances %d, narrow roots or raise max_instances"):format(total, ARGS.max_instances) }
	end

	local checkpoint = {
		id = id, format = FORMAT, createdAt = os.time(), roots = roots, tops = {}, prints = {}, classProperties = {}, classReferences = {},
		rootPaths = {}, originals = {}, copies = {}, currentOf = {}, services = {}, instances = total, subtrees = #plan,
	}
	for _, root in roots do checkpoint.rootPaths[root.container] = root.containerPath end

	-- Every copy is paired before any fingerprint, so references between subtrees already resolve to their copies.
	local unsnapshotted, nonArchivable, nonArchivableExamples = {}, 0, {}
	for _, item in plan do
		local child = item.child
		local top = { root = item.root, name = child.Name, path = item.root.containerPath .. segment(child.Name), live = child }
		if item.root.whole then item.root.top = top end
		table.insert(checkpoint.tops, top)
		item.top = top
		if child.Archivable then
			local cloned, clone = pcall(child.Clone, child)
			if cloned and clone ~= nil then
				top.clone = clone
				pairUp(child, clone, function(live, stored)
					checkpoint.originals[live] = stored
					checkpoint.currentOf[stored] = live
				end)
			end
		end
		if top.clone == nil then table.insert(unsnapshotted, top.path) end
	end
	for _, item in plan do
		checkpoint.prints[item.child] = fingerprint(checkpoint, item.child, item.top)
		for _, instance in item.descendants do
			breathe()
			checkpoint.prints[instance] = fingerprint(checkpoint, instance, item.top)
			if not instance.Archivable then
				nonArchivable += 1
				if #nonArchivableExamples < 5 then table.insert(nonArchivableExamples, pathOf(instance)) end
			end
		end
	end

	for _, root in roots do
		local names = if root.instance.Parent == game then SERVICE_PROPERTIES[root.instance.ClassName] else nil
		if names then
			local values = {}
			for _, property in names do
				local read, value = pcall(get, root.instance, property)
				if read then values[property] = value end
			end
			table.insert(checkpoint.services, { root = root, values = values })
		end
	end

	local terrainState = nil
	if ARGS.include_terrain then
		local terrain = Workspace:FindFirstChildOfClass("Terrain")
		if terrain == nil then
			terrainState = "no Terrain in Workspace"
		else
			local copied, region = pcall(function() return terrain:CopyRegion(terrain.MaxExtents) end)
			if copied then
				checkpoint.terrain = region
				terrainState = "captured"
			else
				terrainState = "copy failed: " .. tostring(region)
			end
		end
	end

	local rootPaths = {}
	for _, root in roots do table.insert(rootPaths, root.path) end
	local unsnapshottedCount = #unsnapshotted
	while #unsnapshotted > 50 do table.remove(unsnapshotted) end
	local okAfter, heapAfter = pcall(gcinfo)
	return {
		checkpoint = checkpoint,
		report = {
			id = id,
			createdAt = checkpoint.createdAt,
			roots = rootPaths,
			missingRoots = missingRoots,
			subtrees = #plan,
			instances = total,
			unsnapshotted = unsnapshotted,
			unsnapshottedCount = unsnapshottedCount,
			nonArchivable = nonArchivable,
			nonArchivableExamples = nonArchivableExamples,
			services = #checkpoint.services,
			terrain = terrainState,
			luaHeapMb = if okHeap and okAfter then round((heapAfter - heapBefore) / 1024, 1) else nil,
			seconds = round(os.clock() - started, 1),
		},
	}
end)
if STORE[id] == placeholder then STORE[id] = if ok then result.checkpoint else nil end
if not ok then return { error = tostring(result) } end
return result.report or result
`, args);
}

export function checkpointChangesLuau(args: { id?: string; synced: string[][]; max_items: number }): string {
  return checkpointSnippet(String.raw`
local checkpoint, problem = pick(ARGS.id)
if checkpoint == nil then return problem end
return guarded(checkpoint, function()
	local found = scan(checkpoint, ARGS.max_items)
	local prefixes = syncedIndex(ARGS.synced)
	local subtrees = {}
	local truncated = found.truncated
	for _, top in sortedDirty(found) do
		if #subtrees >= ARGS.max_items then
			truncated = true
			break
		end
		table.insert(subtrees, { path = top.path, change = "changed", skip = skipReason(prefixes, found, top) })
	end
	for _, extra in found.extras do
		if #subtrees >= ARGS.max_items then
			truncated = true
			break
		end
		local example = syncedExample(prefixes, extra.root, extra.instance.Name)
		table.insert(subtrees, {
			path = pathOf(extra.instance),
			change = "added",
			skip = if example then "synced by Rojo, for example " .. example else nil,
		})
	end
	local missingRoots = {}
	for root in found.missingRoots do table.insert(missingRoots, root.path) end
	local counts = found.counts
	return {
		id = checkpoint.id,
		ageSeconds = os.time() - checkpoint.createdAt,
		clean = counts.added == 0 and counts.removed == 0 and counts.modified == 0 and #found.services == 0 and #missingRoots == 0,
		counts = counts,
		added = found.added,
		removed = found.removed,
		modified = found.modified,
		services = found.services,
		subtrees = subtrees,
		missingRoots = missingRoots,
		terrain = if checkpoint.terrain then "captured, not compared" else nil,
		truncated = truncated,
	}
end)
`, args);
}

export function checkpointRevertLuau(args: { id?: string; paths?: string[]; synced: string[][] }): string {
  return checkpointSnippet(String.raw`
local ChangeHistoryService = game:GetService("ChangeHistoryService")

-- Replaced subtrees become the baseline, and the generation they replaced is kept so a Ctrl+Z of this revert stays understood.
local function adopt(checkpoint, kept)
	if next(kept) == nil then return end
	local taken = extract(checkpoint, kept)
	for top, item in kept do
		if top.retired then
			for instance in top.retired.prints do checkpoint.copies[instance] = nil end
		end
		top.retired = { live = top.live, prints = taken[top] }
		top.live = item.fresh
	end
	for top, item in kept do
		checkpoint.prints[item.fresh] = fingerprint(checkpoint, item.fresh, top)
		for _, instance in item.fresh:GetDescendants() do
			breathe()
			checkpoint.prints[instance] = fingerprint(checkpoint, instance, top)
		end
	end
end

local checkpoint, problem = pick(ARGS.id)
if checkpoint == nil then return problem end
return guarded(checkpoint, function()
	local referrers = {}
	local found = scan(checkpoint, 0, referrers)
	local prefixes = syncedIndex(ARGS.synced)
	local requested, matched = nil, {}
	if ARGS.paths then
		requested = {}
		-- Matching compares text, so each path is rewritten in the form pathOf prints.
		for _, path in ARGS.paths do
			local parts = parsePath(path)
			local wanted = "game"
			for _, part in parts or {} do wanted ..= segment(part) end
			requested[path] = if parts then wanted else path
		end
	end

	-- A requested path selects a subtree when either one contains the other.
	local function touches(candidates)
		if requested == nil then return true end
		local hit = false
		for path, wanted in requested do
			for _, candidate in candidates do
				if within(wanted, candidate) or within(candidate, wanted) then
					matched[path] = true
					hit = true
				end
			end
		end
		return hit
	end
	local function covers(target)
		if requested == nil then return true end
		local hit = false
		for path, wanted in requested do
			if within(target, wanted) then
				matched[path] = true
				hit = true
			end
		end
		return hit
	end

	local replace, detach, skipped = {}, {}, {}
	for _, top in sortedDirty(found) do
		if touches({ top.path, livePath(top.live) }) then
			local reason = skipReason(prefixes, found, top)
			if reason then
				table.insert(skipped, { path = top.path, reason = reason })
			else
				table.insert(replace, top)
			end
		end
	end
	for _, extra in found.extras do
		local path = pathOf(extra.instance)
		if touches({ path }) then
			local example = syncedExample(prefixes, extra.root, extra.instance.Name)
			if example then
				table.insert(skipped, { path = path, reason = "added after the checkpoint but synced by Rojo, for example " .. example })
			else
				table.insert(detach, { instance = extra.instance, path = path })
			end
		end
	end
	local restore = {}
	for _, saved in checkpoint.services do
		if covers(saved.root.path) then
			for property, value in saved.values do
				local ok, now = pcall(get, saved.root.instance, property)
				if ok and not same(value, now) then
					table.insert(restore, { saved = saved, property = property, value = value })
				end
			end
		end
	end
	local pasteTerrain = checkpoint.terrain ~= nil and covers("game.Workspace.Terrain")

	local unmatched = {}
	for path in requested or {} do
		if not matched[path] then table.insert(unmatched, path) end
	end
	table.sort(unmatched)

	-- Copies are made and paired before the recording starts, so the recording never yields.
	local prepared = {}
	for _, top in replace do
		local cloned, fresh = pcall(top.clone.Clone, top.clone)
		if cloned and fresh ~= nil then
			local links = {}
			pairUp(top.clone, fresh, function(stored, copy) table.insert(links, { stored, copy }) end)
			table.insert(prepared, { top = top, fresh = fresh, links = links })
		else
			table.insert(skipped, { path = top.path, reason = "its stored copy could not be cloned: " .. tostring(fresh) })
		end
	end

	-- A flat Workspace can have thousands of root children, so path lists are capped.
	local truncated = false
	local function trimmed(list)
		if #list <= 100 then return list end
		truncated = true
		return table.move(list, 1, 100, 1, {})
	end
	if #prepared == 0 and #detach == 0 and #restore == 0 and not pasteTerrain then
		return { id = checkpoint.id, unchanged = true, skipped = trimmed(skipped), unmatchedPaths = unmatched, truncated = truncated }
	end

	local function beginRecording(name)
		local began, recording = false, nil
		for _ = 1, 10 do
			began, recording = pcall(ChangeHistoryService.TryBeginRecording, ChangeHistoryService, name)
			if not began or recording ~= nil then break end
			-- A plugin holds one recording at a time, so another MCP edit may still be finishing its own.
			task.wait(0.2)
		end
		return began, recording
	end
	-- Studio folds edits made outside any recording, such as execute_luau ones, into the next recording. Committing
	-- them as their own step first keeps Ctrl+Z or a Cancel of the revert from also undoing them.
	local began, recording = beginRecording("MCP: changes before revert " .. checkpoint.id)
	if began and recording ~= nil then
		pcall(ChangeHistoryService.FinishRecording, ChangeHistoryService, recording, Enum.FinishRecordingOperation.Commit)
		began, recording = beginRecording("MCP: revert checkpoint " .. checkpoint.id)
	end
	if not began then
		return { error = "revert could not start an undo recording, so nothing was changed: " .. tostring(recording) }
	end
	if recording == nil then
		return { error = "revert could not start an undo recording while another edit by this plugin is still recording, so nothing was changed, retry shortly" }
	end

	local replaced, removed, restored, failed, dangling = {}, {}, {}, {}, {}
	local relinked, danglingCount = 0, 0
	local terrainState = nil
	local ok, err = pcall(function()
		for _, item in prepared do
			local old = item.top.live
			-- Unparenting instead of Destroy keeps Ctrl+Z able to bring the old subtree back.
			pcall(function() old.Parent = nil end)
			item.fresh.Parent = item.top.root.container
			item.mapped = true
			for _, link in item.links do
				link[3] = checkpoint.currentOf[link[1]]
				checkpoint.currentOf[link[1]] = link[2]
				checkpoint.copies[link[2]] = link[1]
			end
			table.insert(replaced, item.top.path)
		end
		for _, extra in detach do
			extra.instance.Parent = nil
			table.insert(removed, extra.path)
		end

		-- Clone() only remaps references inside the copied subtree, so links between subtrees are repointed here.
		local function relink(instance, property, report)
			local read, target = pcall(get, instance, property)
			if not read or typeof(target) ~= "Instance" then return end
			local stored = checkpoint.originals[target] or checkpoint.copies[target]
			local current = if stored then checkpoint.currentOf[stored] else nil
			if current ~= nil and current ~= target and current:IsDescendantOf(game) then
				if pcall(function() (instance :: any)[property] = current end) then
					relinked += 1
					target = current
				end
			end
			if report and not target:IsDescendantOf(game) then
				danglingCount += 1
				if #dangling < 20 then table.insert(dangling, { path = pathOf(instance), property = property, target = pathOf(target) }) end
			end
		end
		for _, item in prepared do
			for _, link in item.links do
				for _, property in referencesOf(checkpoint, link[2]) do relink(link[2], property, true) end
			end
		end
		for _, referrer in referrers do
			if referrer.instance:IsDescendantOf(game) then relink(referrer.instance, referrer.property, referrer.live) end
		end

		for _, item in restore do
			local name = item.saved.root.path .. "." .. item.property
			local set, message = pcall(function() item.saved.root.instance[item.property] = item.value end)
			if set then table.insert(restored, name) else table.insert(failed, { property = name, error = tostring(message) }) end
		end
		if pasteTerrain then
			local terrain = Workspace:FindFirstChildOfClass("Terrain")
			if terrain == nil then
				terrainState = "no Terrain in Workspace"
			else
				terrain:PasteRegion(checkpoint.terrain, terrain.MaxExtents.Min, true)
				terrainState = "restored"
			end
		end
	end)
	local cancelled = false
	if ok then
		pcall(ChangeHistoryService.FinishRecording, ChangeHistoryService, recording, Enum.FinishRecordingOperation.Commit)
	else
		cancelled = pcall(ChangeHistoryService.FinishRecording, ChangeHistoryService, recording, Enum.FinishRecordingOperation.Cancel)
	end

	-- What is actually in the place decides, since a failed Cancel leaves some copies attached.
	local kept, keptPaths = {}, {}
	for _, item in prepared do
		if item.mapped and item.fresh:IsDescendantOf(game) then
			kept[item.top] = item
			table.insert(keptPaths, item.top.path)
		elseif item.mapped then
			for _, link in item.links do
				checkpoint.currentOf[link[1]] = link[3]
				checkpoint.copies[link[2]] = nil
			end
		end
	end
	adopt(checkpoint, kept)

	if not ok then
		if cancelled and #keptPaths == 0 then
			return { error = "revert failed and Studio cancelled its partial changes, so the place is as before: " .. tostring(err) }
		end
		local shown = table.concat(table.move(keptPaths, 1, math.min(#keptPaths, 10), 1, {}), ", ")
		return {
			error = ("revert failed part way and Studio %s, %d subtrees stay replaced (%s), run changes to see the rest: %s"):format(
				if cancelled then "cancelled only part of it" else "could not cancel it", #keptPaths, shown, tostring(err)),
		}
	end

	return {
		id = checkpoint.id,
		counts = { replaced = #replaced, removed = #removed, skipped = #skipped, relinked = relinked, dangling = danglingCount },
		replaced = trimmed(replaced),
		removed = trimmed(removed),
		restoredProperties = restored,
		failedProperties = if #failed > 0 then failed else nil,
		danglingReferences = if #dangling > 0 then dangling else nil,
		terrain = terrainState,
		skipped = trimmed(skipped),
		unmatchedPaths = unmatched,
		truncated = truncated,
	}
end)
`, args);
}

export function checkpointListLuau(): string {
  return checkpointSnippet(String.raw`
local list = {}
for id, checkpoint in STORE do
	local rootPaths = nil
	if checkpoint.roots then
		rootPaths = {}
		for _, root in checkpoint.roots do table.insert(rootPaths, root.path) end
	end
	table.insert(list, {
		id = id,
		createdAt = checkpoint.createdAt,
		ageSeconds = if checkpoint.createdAt then os.time() - checkpoint.createdAt else nil,
		roots = rootPaths,
		instances = checkpoint.instances,
		subtrees = checkpoint.subtrees,
		terrain = checkpoint.terrain ~= nil,
		busy = checkpoint.busy,
	})
end
table.sort(list, function(a, b) return (a.createdAt or math.huge) < (b.createdAt or math.huge) end)
return { checkpoints = list }
`, {}, false);
}

export function checkpointDropLuau(args: { id: string }): string {
  return checkpointSnippet(String.raw`
local checkpoint = STORE[ARGS.id]
if checkpoint == nil then return { missing = true, id = ARGS.id, existing = ids() } end
if checkpoint.busy then return { error = "checkpoint " .. ARGS.id .. " is busy with another call, retry when it finishes" } end
STORE[ARGS.id] = nil
return { id = ARGS.id, dropped = true }
`, args, false);
}
