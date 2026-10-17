import { withArgs } from '../fork-luau.js';
import { RECORDING } from './transfer-luau.js';

export type StageArgs = {
  paths: string[];
  at: number[];
  settle_s: number;
};

export type StagedCopy = {
  index: number;
  path: string;
  center: number[];
  size: number[];
  front: number[];
};

const STAGE_SHARED = String.raw`
local Workspace = game:GetService("Workspace")
local STAGE_NAME = "__LumenStage"

-- The recording stays open while the views are shot, and cancelling it takes the copies back out without leaving
-- an undo step. A stage a failed call left behind is cleared the same way first.
local function clearStage()
	local held = _G.__lumenStage
	_G.__lumenStage = nil
	local cancelled = false
	if held ~= nil then
		if held.recording ~= nil then
			cancelled = closeRecording(held.recording, false)
		end
		if held.folder ~= nil and held.folder.Parent ~= nil then
			pcall(function() held.folder:Destroy() end)
		end
	end
	local stray = Workspace:FindFirstChild(STAGE_NAME)
	if stray ~= nil then
		pcall(function() stray:Destroy() end)
	end
	return held ~= nil, cancelled
end
`;

/** Copies instances into one non-archivable Folder in an empty spot and holds an undo recording open over them. */
export function stageLuau(args: StageArgs): string {
  return withArgs(String.raw`${RECORDING}
${STAGE_SHARED}
clearStage()

local GAP = 4
local PRELOAD_LIMIT = 10

-- Corner by corner, so a rotated part widens the box as much as it really does.
local function bounds(root)
	local low, high = nil, nil
	for _, part in root:GetDescendants() do
		if part:IsA("BasePart") then
			local half = part.Size / 2
			for _, x in { -1, 1 } do
				for _, y in { -1, 1 } do
					for _, z in { -1, 1 } do
						local corner = part.CFrame:PointToWorldSpace(Vector3.new(half.X * x, half.Y * y, half.Z * z))
						low = if low == nil then corner else low:Min(corner)
						high = if high == nil then corner else high:Max(corner)
					end
				end
			end
		end
	end
	return low, high
end

local function frontOf(copy)
	if copy:IsA("Model") then
		local frame = if copy.PrimaryPart ~= nil then copy.PrimaryPart.CFrame else copy:GetPivot()
		return frame.LookVector
	end
	if copy:IsA("BasePart") then return copy.CFrame.LookVector end
	return Vector3.new(0, 0, -1)
end

local folder = Instance.new("Folder")
folder.Name = STAGE_NAME
-- Never saved with the place, even if a crash leaves it behind.
folder.Archivable = false

local staged = {}
local built, failure = pcall(function()
	local cursor = Vector3.new(ARGS.at[1], ARGS.at[2], ARGS.at[3])
	for index, path in ARGS.paths do
		local source = resolve(path)
		if source == nil then error("stage found nothing at " .. path, 0) end
		local copy = source:Clone()
		if copy == nil then error(path .. " cannot be copied because it is not Archivable", 0) end
		local holder = Instance.new("Model")
		holder.Name = "Stage" .. index
		copy.Parent = holder
		local low, high = bounds(holder)
		if low == nil then
			holder:Destroy()
			error(path .. " has no parts to show", 0)
		end
		local size = high - low
		local bottom = Vector3.new((low.X + high.X) / 2, low.Y, (low.Z + high.Z) / 2)
		local slot = cursor + Vector3.new(size.X / 2, 0, 0)
		holder:PivotTo(holder:GetPivot() + (slot - bottom))
		holder.Parent = folder
		cursor += Vector3.new(size.X + math.max(GAP, size.X / 4), 0, 0)
		table.insert(staged, {
			index = index,
			path = pathOf(source),
			center = point(slot + Vector3.new(0, size.Y / 2, 0)),
			size = point(size),
			front = point(frontOf(copy)),
		})
	end
end)
if not built then
	folder:Destroy()
	return { error = tostring(failure) }
end

-- Without a recording the copies still come and go, and Studio folds that net zero change into the next undo step.
local recording = openRecording("capture_views stage")
folder.Parent = Workspace
_G.__lumenStage = { folder = folder, recording = recording }

-- Models kept in storage were never drawn, so their meshes and textures load only now, and a shot taken before
-- that shows bare parts. Loading has a cap so a stuck asset cannot hold the call.
local ContentProvider = game:GetService("ContentProvider")
local preloaded = false
task.spawn(function()
	pcall(ContentProvider.PreloadAsync, ContentProvider, { folder })
	preloaded = true
end)
local loadStarted = os.clock()
while not preloaded and os.clock() - loadStarted < PRELOAD_LIMIT do
	task.wait(0.05)
end
if ARGS.settle_s > 0 then task.wait(ARGS.settle_s) end

local camera = Workspace.CurrentCamera
local viewport = if camera ~= nil then camera.ViewportSize else Vector2.new(16, 9)
return {
	staged = staged,
	recorded = recording ~= nil,
	preloaded = preloaded,
	fov = if camera ~= nil then round(camera.FieldOfView, 3) else 70,
	aspect = round(viewport.X / math.max(1, viewport.Y), 4),
}
`, args);
}

/** Takes the stage out again, by cancelling its recording where there is one. */
export function unstageLuau(): string {
  return withArgs(String.raw`${RECORDING}
${STAGE_SHARED}
local held, cancelled = clearStage()
return { removed = held, cancelled = cancelled, left = Workspace:FindFirstChild(STAGE_NAME) ~= nil }
`, {});
}
