import { withArgs } from '../fork-luau.js';

export type InspectRbxmArgs = {
  base64: string;
  root?: string;
  depth: number;
  limit: number;
  assets: boolean;
  match_in?: string;
};

// Reads the file into instances that are never parented, so the place is untouched and nothing reaches undo history.
export function inspectRbxmLuau(args: InspectRbxmArgs): string {
  return withArgs(String.raw`
local SerializationService = game:GetService("SerializationService")
local EncodingService = game:GetService("EncodingService")

local decoded, bytes = pcall(function()
	return EncodingService:Base64Decode(buffer.fromstring(ARGS.base64))
end)
if not decoded then
	return { error = "inspect_rbxm could not decode the file: " .. tostring(bytes) }
end
local read, roots = pcall(function()
	return SerializationService:DeserializeInstancesAsync(bytes)
end)
if not read then
	return { error = "inspect_rbxm could not read the file as a model: " .. tostring(roots) }
end

local function discard()
	for _, instance in roots do
		pcall(function() instance:Destroy() end)
	end
end

local ASSET_PROPERTIES = {
	MeshPart = { "MeshId", "TextureID" },
	SpecialMesh = { "MeshId", "TextureId" },
	SurfaceAppearance = { "ColorMap", "NormalMap", "RoughnessMap", "MetalnessMap" },
	Decal = { "Texture" },
	Texture = { "Texture" },
	ParticleEmitter = { "Texture" },
	Beam = { "Texture" },
	Trail = { "Texture" },
	Sound = { "SoundId" },
	Animation = { "AnimationId" },
	Shirt = { "ShirtTemplate" },
	Pants = { "PantsTemplate" },
	ImageLabel = { "Image" },
	ImageButton = { "Image" },
}
-- What a model is built from, its meshes and their textures. Effect textures are shared by many effects, so they
-- would match unrelated models.
local IDENTITY = { MeshId = true, TextureID = true, TextureId = true, ColorMap = true }
local MAX_ATTRIBUTES = 8
local MAX_IDS = 40
local MAX_MATCH_ITEMS = 50

local function assetId(value)
	if typeof(value) == "Content" then
		local ok, uri = pcall(function() return value.Uri end)
		value = if ok then uri else nil
	end
	if type(value) ~= "string" or value == "" then return nil end
	return string.match(value, "^rbxassetid://(%d+)") or string.match(value, "[?&][iI][dD]=(%d+)") or value
end

local function eachAsset(instance, visit)
	local properties = ASSET_PROPERTIES[instance.ClassName]
	if properties == nil then return end
	for _, property in properties do
		local id = assetId(readable(instance, property))
		if id ~= nil then visit(property, id) end
	end
end

local function each(root, visit)
	visit(root)
	for _, descendant in root:GetDescendants() do
		visit(descendant)
	end
end

local function filePath(instance)
	local parts = {}
	local current = instance
	while current ~= nil do
		table.insert(parts, 1, current.Name)
		current = current.Parent
	end
	return table.concat(parts, "/")
end

local function attributes(instance)
	local out, count = nil, 0
	for key, value in instance:GetAttributes() do
		count += 1
		if count > MAX_ATTRIBUTES then
			out["(more)"] = count - MAX_ATTRIBUTES
			continue
		end
		local kind = type(value)
		local shown = if kind == "number" or kind == "boolean" then value else string.sub(tostring(value), 1, 80)
		out = out or {}
		out[key] = shown
	end
	return out
end

local function classSummary(instance)
	local counts = {}
	for _, descendant in instance:GetDescendants() do
		counts[descendant.ClassName] = (counts[descendant.ClassName] or 0) + 1
	end
	local list = {}
	for class, count in counts do
		table.insert(list, { class, count })
	end
	table.sort(list, function(a, b)
		if a[2] ~= b[2] then return a[2] > b[2] end
		return a[1] < b[1]
	end)
	local out = {}
	for index = 1, math.min(6, #list) do
		table.insert(out, list[index][1] .. "=" .. list[index][2])
	end
	if #list > 6 then table.insert(out, "+" .. (#list - 6) .. " classes") end
	return table.concat(out, ", ")
end

local focus = roots
if ARGS.root ~= nil and ARGS.root ~= "" then
	local segments = string.split(ARGS.root, "/")
	local node = nil
	for _, root in roots do
		if root.Name == segments[1] then
			node = root
			break
		end
	end
	for index = 2, #segments do
		if node == nil then break end
		node = node:FindFirstChild(segments[index])
	end
	if node == nil then
		local names = {}
		for index, root in roots do
			if index > 20 then break end
			table.insert(names, root.Name)
		end
		discard()
		return { error = "root " .. ARGS.root .. " is not in the file, whose top level holds: " .. table.concat(names, ", ") }
	end
	focus = { node }
end

local nodes, truncated = {}, false
local function visit(instance, level)
	if #nodes >= ARGS.limit then
		truncated = true
		return
	end
	local children = instance:GetChildren()
	local entry = { path = filePath(instance), class = instance.ClassName }
	if #children > 0 then entry.children = #children end
	entry.attributes = attributes(instance)
	-- Below the listed depth only a class count stands for what is inside.
	if level >= ARGS.depth and #children > 0 then entry.inside = classSummary(instance) end
	table.insert(nodes, entry)
	if level < ARGS.depth then
		for _, child in children do
			visit(child, level + 1)
		end
	end
end
for _, root in focus do
	visit(root, 0)
end

local assets = nil
if ARGS.assets then
	local byProperty = {}
	for _, root in focus do
		each(root, function(instance)
			eachAsset(instance, function(property, id)
				local counts = byProperty[property] or {}
				byProperty[property] = counts
				counts[id] = (counts[id] or 0) + 1
			end)
		end)
	end
	assets = {}
	for property, counts in byProperty do
		local list = {}
		for id, count in counts do
			table.insert(list, { id, count })
		end
		table.sort(list, function(a, b)
			if a[2] ~= b[2] then return a[2] > b[2] end
			return a[1] < b[1]
		end)
		local shown = {}
		for index = 1, math.min(MAX_IDS, #list) do
			table.insert(shown, list[index])
		end
		assets[property] = { distinct = #list, ids = shown, truncated = if #list > MAX_IDS then true else nil }
	end
end

local matches = nil
if ARGS.match_in ~= nil and ARGS.match_in ~= "" then
	local container = resolve(ARGS.match_in)
	if container == nil then
		discard()
		return { error = "match_in found nothing at " .. ARGS.match_in }
	end
	local function identity(root)
		local ids, count = {}, 0
		each(root, function(instance)
			eachAsset(instance, function(property, id)
				if IDENTITY[property] and not ids[id] then
					ids[id] = true
					count += 1
				end
			end)
		end)
		return ids, count
	end
	local candidates = {}
	for _, child in container:GetChildren() do
		local ids, count = identity(child)
		if count > 0 then table.insert(candidates, { path = pathOf(child), ids = ids, count = count }) end
	end
	-- One container is a delivery of several models, so its children are what gets matched.
	local items = if #focus == 1 then focus[1]:GetChildren() else focus
	matches = {}
	for index, item in items do
		if index > MAX_MATCH_ITEMS then break end
		local ids, count = identity(item)
		local scored = {}
		for _, candidate in candidates do
			local shared = 0
			for id in ids do
				if candidate.ids[id] then shared += 1 end
			end
			if shared > 0 then table.insert(scored, { path = candidate.path, shared = shared, ids = candidate.count }) end
		end
		table.sort(scored, function(a, b)
			if a.shared ~= b.shared then return a.shared > b.shared end
			return a.path < b.path
		end)
		local best = {}
		for rank = 1, math.min(3, #scored) do
			table.insert(best, scored[rank])
		end
		table.insert(matches, { item = filePath(item), ids = count, best = best })
	end
end

discard()
return {
	roots = #roots,
	nodes = nodes,
	truncated = if truncated then true else nil,
	assets = assets,
	matches = matches,
}
`, args);
}
