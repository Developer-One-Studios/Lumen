import { withArgs } from '../fork-luau.js';

// One undo step per call. Studio folds edits made outside any recording into the next one, so those are committed
// as their own step first, and a plugin holds one recording at a time, so a busy recorder is retried briefly.
export const RECORDING = String.raw`
local ChangeHistoryService = game:GetService("ChangeHistoryService")

local function beginRecording(name)
	local began, recording = false, nil
	for _ = 1, 10 do
		began, recording = pcall(ChangeHistoryService.TryBeginRecording, ChangeHistoryService, name)
		if not began or recording ~= nil then break end
		task.wait(0.2)
	end
	return began, recording
end

local function openRecording(action)
	local began, recording = beginRecording("MCP: edits before " .. action)
	if began and recording ~= nil then
		pcall(ChangeHistoryService.FinishRecording, ChangeHistoryService, recording, Enum.FinishRecordingOperation.Commit)
		began, recording = beginRecording("MCP: " .. action)
	end
	if not began then
		return nil, action .. " could not start an undo recording, so nothing was changed: " .. tostring(recording)
	end
	if recording == nil then
		return nil, action .. " could not start an undo recording while another edit by this plugin is still recording, so nothing was changed, retry shortly"
	end
	return recording, nil
end

local function closeRecording(recording, keep)
	local operation = if keep then Enum.FinishRecordingOperation.Commit else Enum.FinishRecordingOperation.Cancel
	return (pcall(ChangeHistoryService.FinishRecording, ChangeHistoryService, recording, operation))
end

local function point(vector)
	return { round(vector.X, 3), round(vector.Y, 3), round(vector.Z, 3) }
end
`;

export type CopyInstancesArgs = {
  base64: string;
  parent_path: string;
  name?: string;
};

export function copyInstancesLuau(args: CopyInstancesArgs): string {
  return withArgs(String.raw`${RECORDING}
local SerializationService = game:GetService("SerializationService")
local EncodingService = game:GetService("EncodingService")

local parent = resolve(ARGS.parent_path)
if parent == nil then
	return { error = "copy_instances found no destination parent at " .. tostring(ARGS.parent_path) }
end

local decoded, bytes = pcall(function()
	return EncodingService:Base64Decode(buffer.fromstring(ARGS.base64))
end)
if not decoded then
	return { error = "copy_instances could not decode the copied data: " .. tostring(bytes) }
end
local read, instances = pcall(function()
	return SerializationService:DeserializeInstancesAsync(bytes)
end)
if not read then
	return { error = "copy_instances could not rebuild the copied instances: " .. tostring(instances) }
end

local function discard()
	for _, instance in instances do
		pcall(function() instance:Destroy() end)
	end
end

if ARGS.name ~= nil then
	if #instances ~= 1 then
		discard()
		return { error = "name renames a single copy, but " .. #instances .. " instances were copied" }
	end
	instances[1].Name = ARGS.name
end

local recording, message = openRecording("copy instances")
if recording == nil then
	discard()
	return { error = message }
end
local parented, failure = pcall(function()
	for _, instance in instances do
		instance.Parent = parent
	end
end)
if not parented then
	closeRecording(recording, false)
	discard()
	return { error = "copy_instances could not place the copies under " .. pathOf(parent) .. ", so nothing was added: " .. tostring(failure) }
end
closeRecording(recording, true)

local copied = {}
for index, instance in instances do
	if index > 50 then break end
	local same = 0
	for _, sibling in parent:GetChildren() do
		if sibling.Name == instance.Name then same += 1 end
	end
	table.insert(copied, {
		path = pathOf(instance),
		class = instance.ClassName,
		descendants = #instance:GetDescendants(),
		same_named_siblings = if same > 1 then same - 1 else nil,
	})
end
return {
	parent = pathOf(parent),
	count = #instances,
	copied = copied,
	truncated = if #instances > 50 then true else nil,
}
`, args);
}

export type MoveInstancesArgs = {
  paths: string[];
  offset?: number[];
  to?: number[];
  rotation?: number[];
  origin?: number[];
};

export function moveInstancesLuau(args: MoveInstancesArgs): string {
  return withArgs(String.raw`${RECORDING}
local function vector(value)
	return Vector3.new(value[1], value[2], value[3])
end

local roots, missing, refused = {}, {}, {}
for _, path in ARGS.paths do
	local instance = resolve(path)
	if instance == nil then
		table.insert(missing, path)
	elseif instance == game or instance.Parent == game or instance:IsA("Terrain") or instance:IsA("Camera") then
		table.insert(refused, pathOf(instance))
	elseif not table.find(roots, instance) then
		table.insert(roots, instance)
	end
end
if #missing > 0 then
	return { error = "move_instances found nothing at " .. table.concat(missing, ", ") }
end
if #refused > 0 then
	return { error = "move_instances cannot move services, Terrain or cameras: " .. table.concat(refused, ", ") }
end

-- A root inside another root already moves with it.
local top = {}
for _, root in roots do
	local nested = false
	for _, other in roots do
		if other ~= root and root:IsDescendantOf(other) then
			nested = true
			break
		end
	end
	if not nested then table.insert(top, root) end
end

local parts, models = {}, {}
local function collect(instance)
	if instance:IsA("BasePart") then
		table.insert(parts, instance)
	elseif instance:IsA("Model") then
		table.insert(models, instance)
	end
end
for _, root in top do
	collect(root)
	for _, descendant in root:GetDescendants() do
		collect(descendant)
	end
end
if #parts == 0 then
	return { error = "move_instances found no parts to move under those instances" }
end

local function bounds()
	local low, high = Vector3.one * math.huge, -Vector3.one * math.huge
	for _, part in parts do
		local frame, size = part.CFrame, part.Size
		local half = ((frame.RightVector * size.X):Abs() + (frame.UpVector * size.Y):Abs() + (frame.LookVector * size.Z):Abs()) / 2
		low = low:Min(frame.Position - half)
		high = high:Max(frame.Position + half)
	end
	return low, high
end

local low, high = bounds()
local center = (low + high) / 2
local origin = if ARGS.origin ~= nil then vector(ARGS.origin) else center
local turn = if ARGS.rotation ~= nil
	then CFrame.fromOrientation(math.rad(ARGS.rotation[1]), math.rad(ARGS.rotation[2]), math.rad(ARGS.rotation[3]))
	else CFrame.identity
local spin = CFrame.new(origin) * turn * CFrame.new(-origin)
local shift = if ARGS.to ~= nil then vector(ARGS.to) - spin * center elseif ARGS.offset ~= nil then vector(ARGS.offset) else Vector3.zero
local transform = CFrame.new(shift) * spin

local recording, message = openRecording("move instances")
if recording == nil then
	return { error = message }
end

-- Every target is read before any is written, since setting a part's CFrame can carry parts welded to it along.
-- Models with a PrimaryPart follow it, the rest keep an absolute WorldPivot that moves with them here.
local frames = table.create(#parts)
for index, part in parts do
	frames[index] = transform * part.CFrame
end
local pivots = {}
for _, model in models do
	if model.PrimaryPart == nil then
		pivots[model] = transform * model.WorldPivot
	end
end
local moved, failure = pcall(function()
	for model, pivot in pivots do
		model.WorldPivot = pivot
	end
	for index, part in parts do
		part.CFrame = frames[index]
	end
end)
if not moved then
	local cancelled = closeRecording(recording, false)
	return { error = "move_instances failed part way, " .. (if cancelled then "and Studio cancelled its changes: " else "and Studio could not cancel its changes, check with Ctrl+Z: ") .. tostring(failure) }
end
closeRecording(recording, true)

local after = { bounds() }
local names = {}
for index, root in top do
	if index > 20 then break end
	table.insert(names, pathOf(root))
end
return {
	moved = names,
	roots = #top,
	parts = #parts,
	shift = point(shift),
	before = { min = point(low), max = point(high) },
	after = { min = point(after[1]), max = point(after[2]) },
}
`, args);
}
