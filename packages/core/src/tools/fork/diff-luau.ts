import { withArgs } from '../fork-luau.js';

// Both passes describe an instance the same way: every serialized property ReflectionService lists for its class,
// plus its attributes, each as a stable string. The first pass only sends a fingerprint of that description per
// instance, so two large trees cost two short lists, and the second pass sends full descriptions for the instances
// whose fingerprints differ.
const DESCRIBE = String.raw`
local ReflectionService = game:GetService("ReflectionService")

-- ScriptGuid is new for every script made separately, so two places never agree on it.
local ignoreClasses, ignoreNames, ignoreProperties = {}, {}, { Parent = true, Name = true, ScriptGuid = true }
for _, name in ARGS.ignore_classes do ignoreClasses[name] = true end
for _, name in ARGS.ignore_names do ignoreNames[name] = true end
for _, name in ARGS.ignore_properties do ignoreProperties[name] = true end

local root = resolve(ARGS.root_path)
if root == nil then
	return { error = "diff_instances found nothing at " .. tostring(ARGS.root_path) }
end

local function skipped(instance)
	if instance == root then return false end
	if ignoreNames[instance.Name] then return true end
	for className in ignoreClasses do
		if instance:IsA(className) then return true end
	end
	return false
end

-- Same-named siblings are told apart by their order among each other, which survives a copy between places.
local function segmentOf(instance)
	local parent = instance.Parent
	local index, count = 0, 0
	for _, sibling in parent:GetChildren() do
		if sibling.Name == instance.Name and not skipped(sibling) then
			count += 1
			if sibling == instance then index = count end
		end
	end
	return if count > 1 then instance.Name .. "#" .. index else instance.Name
end

local relativePaths = {}
local function relativeOf(instance)
	if instance == root then return "" end
	local cached = relativePaths[instance]
	if cached then return cached end
	local parentPath = relativeOf(instance.Parent)
	local path = if parentPath == "" then segmentOf(instance) else parentPath .. "/" .. segmentOf(instance)
	relativePaths[instance] = path
	return path
end

local propertyLists = {}
local function propertiesOf(className)
	local list = propertyLists[className]
	if list then return list end
	list = {}
	local ok, entries = pcall(function() return ReflectionService:GetPropertiesOfClass(className) end)
	if ok then
		for _, entry in entries do
			if entry.Serialized ~= false and not ignoreProperties[entry.Name] then table.insert(list, entry.Name) end
		end
	end
	table.sort(list)
	propertyLists[className] = list
	return list
end

local function component(value)
	return tostring(round(value, 3))
end

local function stringOf(value)
	local kind = typeof(value)
	if kind == "nil" then return "nil" end
	if kind == "number" then return if finite(value) then tostring(round(value, 4)) else tostring(value) end
	if kind == "string" or kind == "boolean" then return tostring(value) end
	if kind == "EnumItem" then return value.Name end
	if kind == "Vector3" then return component(value.X) .. ", " .. component(value.Y) .. ", " .. component(value.Z) end
	if kind == "Vector2" then return component(value.X) .. ", " .. component(value.Y) end
	if kind == "Color3" then
		return math.round(value.R * 255) .. ", " .. math.round(value.G * 255) .. ", " .. math.round(value.B * 255)
	end
	if kind == "CFrame" then
		local parts = { value:GetComponents() }
		for i, part in parts do parts[i] = component(part) end
		return table.concat(parts, ", ")
	end
	if kind == "Instance" then
		if value == root or value:IsDescendantOf(root) then return "<" .. relativeOf(value) .. ">" end
		return pathOf(value)
	end
	return tostring(value)
end

-- FNV-1a. The prime is 2^24 + 403, so the multiply is split to stay exact in a double.
local function hashText(text)
	local hash = 2166136261
	local length = #text
	local i = 1
	while i <= length do
		local bytes = { string.byte(text, i, math.min(i + 63, length)) }
		for _, byte in bytes do
			hash = bit32.bxor(hash, byte)
			hash = (bit32.lshift(hash, 24) + hash * 403) % 4294967296
		end
		i += 64
	end
	return string.format("%08x", hash)
end

local function describe(instance)
	local out = {}
	for _, name in propertiesOf(instance.ClassName) do
		local ok, value = pcall(function() return (instance :: any)[name] end)
		if ok then out[name] = stringOf(value) end
	end
	-- ReflectionService keeps Source from plugins, so scripts are compared by their source's length and fingerprint.
	if instance:IsA("LuaSourceContainer") and not ignoreProperties.Source then
		local ok, source = pcall(function() return (instance :: any).Source end)
		if ok and type(source) == "string" then
			local _, newlines = string.gsub(source, "\n", "")
			out.Source = (newlines + 1) .. " lines, " .. hashText(source)
		end
	end
	for name, value in instance:GetAttributes() do
		out["@" .. name] = stringOf(value)
	end
	return out
end

local function sortedKeys(map)
	local keys = {}
	for key in map do table.insert(keys, key) end
	table.sort(keys)
	return keys
end

local function fingerprint(map)
	local parts = {}
	for _, key in sortedKeys(map) do
		table.insert(parts, key .. "=" .. map[key])
	end
	return hashText(table.concat(parts, "\n"))
end
`;

export type DiffArgs = {
  root_path: string;
  ignore_classes: string[];
  ignore_names: string[];
  ignore_properties: string[];
};

/** Every instance under the root: its path relative to the root, its class and a fingerprint of its description. */
export function diffIndexLuau(args: DiffArgs & { max_instances: number }): string {
  return withArgs(String.raw`${DESCRIBE}
local entries = {}
local truncated = false
local function walk(instance)
	if #entries >= ARGS.max_instances then
		truncated = true
		return
	end
	table.insert(entries, { relativeOf(instance), instance.ClassName, fingerprint(describe(instance)) })
	for _, child in instance:GetChildren() do
		if not skipped(child) then walk(child) end
	end
end
walk(root)
return { root = pathOf(root), entries = entries, truncated = if truncated then true else nil }
`, args);
}

/** Full descriptions of the instances at the given relative paths, with long values cut. */
export function diffDetailLuau(args: DiffArgs & { paths: string[] }): string {
  return withArgs(String.raw`${DESCRIBE}
local byPath = {}
local function walk(instance)
	byPath[relativeOf(instance)] = instance
	for _, child in instance:GetChildren() do
		if not skipped(child) then walk(child) end
	end
end
walk(root)

local function clipped(text)
	if utf8.len(text) == nil then text = string.gsub(text, "[\128-\255]", "?") end
	local cut = utf8.offset(text, 161)
	if cut == nil or cut > #text then return text end
	return string.sub(text, 1, cut - 1) .. "..."
end

local details = {}
for _, path in ARGS.paths do
	local instance = byPath[path]
	if instance then
		local described = {}
		for key, value in describe(instance) do described[key] = clipped(value) end
		details[path] = described
	end
end
return { details = details }
`, args);
}
