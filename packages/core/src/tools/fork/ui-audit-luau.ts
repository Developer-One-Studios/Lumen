import { withArgs } from '../fork-luau.js';

export const UI_AUDIT_CHECKS = ['offscreen', 'clipped', 'overlap', 'text_overflow', 'small_text', 'small_touch', 'under_topbar'] as const;
export type UiAuditCheck = (typeof UI_AUDIT_CHECKS)[number];

export type UiAuditArgs = {
  root?: string;
  checks: UiAuditCheck[];
  /** null lets the peer decide from UserInputService.TouchEnabled. */
  touch: boolean | null;
  min_touch_px: number;
  min_text_px: number;
  max_findings: number;
  max_interactive: number;
  previous_viewport?: [number, number];
  /** Only checks that the root, PlayerGui and camera exist, so a bad call fails before any device switch. */
  validate?: boolean;
};

// Rects are [x, y, w, h] in viewport pixels, the space screenshots and mouse input use.
export function uiAuditLuau(args: UiAuditArgs): string {
  return withArgs(String.raw`
local Players = game:GetService("Players")
local GuiService = game:GetService("GuiService")
local UserInputService = game:GetService("UserInputService")
local StarterGui = game:GetService("StarterGui")
local player = Players.LocalPlayer
local base = if player then player:FindFirstChildOfClass("PlayerGui") else StarterGui
if base == nil then return { error = "PlayerGui not loaded yet" } end
local root = base
if ARGS.root then
	local relative = if player then string.match(ARGS.root, "^PlayerGui(.*)$") else nil
	root = if relative then resolve(pathOf(base) .. relative) else resolve(ARGS.root)
	if root == nil then return { error = "root not found: " .. ARGS.root } end
	if root ~= base and not root:IsDescendantOf(base) then
		return { error = "root must be inside " .. (if player then "PlayerGui" else "StarterGui") }
	end
end
local camera = game:GetService("Workspace").CurrentCamera
if camera == nil then return { error = "no CurrentCamera to read the viewport from" } end
if ARGS.validate then return { valid = true } end
-- The PlayerModule builds TouchGui for its thumbstick and jump button, which is Roblox UI rather than the place's own.
local touchGui = if ARGS.root == nil and player then base:FindFirstChild("TouchGui") else nil

-- The simulator applies a device over a few frames, so wait for the viewport to move and the layout to stop changing.
local function fingerprint()
	local size = camera.ViewportSize
	local sum = size.X * 7 + size.Y * 13
	local seen = 0
	for _, object in root:GetDescendants() do
		if object:IsA("GuiObject") then
			local p, s = object.AbsolutePosition, object.AbsoluteSize
			sum += p.X + p.Y * 3 + s.X * 5 + s.Y * 11
			seen += 1
			if seen >= 400 then break end
		end
	end
	return sum
end
local previous = ARGS.previous_viewport
if previous then
	local waited = 0
	while waited < 1.5 do
		local size = camera.ViewportSize
		if math.abs(size.X - previous[1]) >= 1 or math.abs(size.Y - previous[2]) >= 1 then break end
		waited += task.wait()
	end
end
local settled = false
do
	local last, steady, waited = nil, 0, 0
	while waited < 2 do
		waited += task.wait()
		local current = fingerprint()
		if current == last then
			steady += 1
			if steady >= 3 then
				settled = true
				break
			end
		else
			steady = 0
		end
		last = current
	end
end

local inset = GuiService:GetGuiInset()
local W, H = camera.ViewportSize.X, camera.ViewportSize.Y
local SCREEN = { 0, 0, W, H }
local TOL = 1
local OVERLAP = 0.1
local okTop, topRect = pcall(function() return GuiService.TopbarInset end)
local topbar = if okTop and typeof(topRect) == "Rect" and topRect.Width > 0 and topRect.Height > 0 then topRect else nil
local touch = ARGS.touch
if touch == nil then touch = UserInputService.TouchEnabled end

local simulated = {}
local okSim, simulator = pcall(game.GetService, game, "StudioDeviceSimulatorService")
if okSim and simulator then
	local okId, id = pcall(function() return simulator:GetDeviceAsync() end)
	if okId then simulated.device = tostring(id) end
	local okOrientation, orientation = pcall(function() return simulator:GetOrientationAsync() end)
	if okOrientation and typeof(orientation) == "EnumItem" then simulated.orientation = orientation.Name end
end

local CHECK = {}
local counts = {}
for _, name in ARGS.checks do
	CHECK[name] = true
	counts[name] = 0
end
local findings = {}
local function add(finding)
	counts[finding.kind] += 1
	if #findings < ARGS.max_findings then table.insert(findings, finding) end
	return finding
end

local basePath = pathOf(base)
local function display(object)
	local full = pathOf(object)
	if player and string.sub(full, 1, #basePath) == basePath then return "PlayerGui" .. string.sub(full, #basePath + 1) end
	return full
end

-- Cut on a character boundary, JSONEncode rejects a split or invalid multibyte character.
local function shorten(text)
	if utf8.len(text) == nil then return "<invalid utf8>" end
	local cut = utf8.offset(text, 41)
	return if cut and cut <= #text then string.sub(text, 1, cut - 1) .. "..." else text
end

local function rectOf(object)
	local p, s = object.AbsolutePosition, object.AbsoluteSize
	local x, y = p.X + inset.X, p.Y + inset.Y
	return { x, y, x + s.X, y + s.Y }
end
local function area(r)
	return math.max(0, r[3] - r[1]) * math.max(0, r[4] - r[2])
end
local function intersect(a, b)
	return { math.max(a[1], b[1]), math.max(a[2], b[2]), math.min(a[3], b[3]), math.min(a[4], b[4]) }
end
local function plainRect(r)
	return { math.floor(r[1] + 0.5), math.floor(r[2] + 0.5), math.floor(r[3] - r[1] + 0.5), math.floor(r[4] - r[2] + 0.5) }
end

-- Fully transparent containers draw nothing, so overhanging or clipped ones are not layout bugs.
local function draws(object)
	if object.BackgroundTransparency < 1 then return true end
	if object:IsA("TextLabel") or object:IsA("TextButton") or object:IsA("TextBox") then
		if object.TextTransparency < 1 and (object.Text ~= "" or (object:IsA("TextBox") and object.PlaceholderText ~= "")) then return true end
	end
	if (object:IsA("ImageLabel") or object:IsA("ImageButton")) and object.ImageTransparency < 1 and object.Image ~= "" then return true end
	if object:IsA("ViewportFrame") or object:IsA("VideoFrame") then return true end
	local stroke = object:FindFirstChildWhichIsA("UIStroke")
	return stroke ~= nil and stroke.Enabled and stroke.Transparency < 1
end

local infos = {}
infos[base] = { shown = true, scale = 1 }
local function infoOf(object)
	local known = infos[object]
	if known then return known end
	local parent = object.Parent
	local up = if parent then infoOf(parent) else infos[base]
	local info = {
		up = up, shown = up.shown, screen = up.screen, world = up.world, scale = up.scale,
		clip = up.childClip, clipBy = up.childClipBy, scrolled = up.childScrolled,
	}
	if object:IsA("LayerCollector") then
		if not object.Enabled then info.shown = false end
		if object:IsA("ScreenGui") then info.screen = object else info.world = true end
	elseif object:IsA("GuiObject") then
		if not object.Visible then info.shown = false end
		if object:IsA("CanvasGroup") and object.GroupTransparency >= 1 then info.shown = false end
	end
	local uiScale = object:FindFirstChildWhichIsA("UIScale")
	if uiScale then info.scale *= uiScale.Scale end
	info.childClip, info.childClipBy, info.childScrolled = info.clip, info.clipBy, info.scrolled
	if object:IsA("GuiObject") and (object.ClipsDescendants or object:IsA("ScrollingFrame")) then
		local r = rectOf(object)
		info.childClip = if info.clip then intersect(info.clip, r) else r
		info.childClipBy = object
		if object:IsA("ScrollingFrame") then info.childScrolled = true end
	end
	infos[object] = info
	return info
end

-- Descendants fold into the nearest reported ancestor's nested count unless clearly less visible than it.
local FOLD_GAP = 0.5
local FOLD_GAP_INTERACTIVE = 0.1
local function folds(info, key, field, fraction, interactive)
	local current = info.up
	while current do
		local outer = current[key]
		if outer then
			if fraction < outer[field] - (if interactive then FOLD_GAP_INTERACTIVE else FOLD_GAP) then return false end
			outer.nested = (outer.nested or 0) + 1
			return true
		end
		current = current.up
	end
	return false
end

-- TextBounds is in unscaled offsets, so UIScale is applied on top.
local function renderedTextSize(object, scale)
	if not object.TextScaled then return object.TextSize * scale, false end
	local height = object.TextBounds.Y
	if not finite(height) or height <= 0 then return nil, true end
	local lines = 1
	for _ in string.gmatch(object.Text, "\n") do lines += 1 end
	local lineHeight = if object.LineHeight > 0 then object.LineHeight else 1
	-- Wrapped lines are unknown, so this is an upper bound that only proves text is small.
	return height * scale / (lines * lineHeight), true
end

local candidates = {}
local interactiveTruncated = false
local elements = 0
local scanned = 0
local list = root:GetDescendants()
if root:IsA("GuiObject") then table.insert(list, 1, root) end
for _, object in list do
	scanned += 1
	if scanned % 1000 == 0 then task.wait() end
	if not object:IsA("GuiObject") or (touchGui and object:IsDescendantOf(touchGui)) then continue end
	local info = infoOf(object)
	if not info.shown or info.world or info.screen == nil then continue end
	local r = rectOf(object)
	if not (finite(r[1]) and finite(r[2]) and finite(r[3]) and finite(r[4])) or area(r) <= 0 then continue end
	elements += 1
	local whole = area(r)
	-- A button with Interactable off takes no input, so it cannot be blocked or mistapped.
	local interactive = (object:IsA("GuiButton") or object:IsA("TextBox")) and readable(object, "Interactable") ~= false
	local drawn = draws(object)
	local inside = if info.clip then intersect(r, info.clip) else r
	local visibleRect = intersect(inside, SCREEN)
	local path = display(object)

	-- Judged on the part ancestors' clipping leaves, since the clipped kind already reports what they cut.
	if CHECK.offscreen and drawn and not info.scrolled and area(inside) > 0 then
		local sides = {}
		if inside[1] < -TOL then table.insert(sides, "left") end
		if inside[2] < -TOL then table.insert(sides, "top") end
		if inside[3] > W + TOL then table.insert(sides, "right") end
		if inside[4] > H + TOL then table.insert(sides, "bottom") end
		if #sides > 0 then
			local onScreen = round(area(visibleRect) / area(inside), 2)
			if not folds(info, "off", "onScreen", onScreen, interactive) then
				info.off = add({
					kind = "offscreen", path = path, class = object.ClassName, rect = plainRect(r),
					onScreen = onScreen, sides = table.concat(sides, ","), interactive = interactive or nil,
				})
			end
		end
	end

	if CHECK.clipped and drawn and not info.scrolled and info.clip then
		local cut = inside[1] > r[1] + TOL or inside[2] > r[2] + TOL or inside[3] < r[3] - TOL or inside[4] < r[4] - TOL
		if cut then
			local shown = round(area(inside) / whole, 2)
			if not folds(info, "cut", "shown", shown, interactive) then
				info.cut = add({
					kind = "clipped", path = path, class = object.ClassName, rect = plainRect(r),
					by = display(info.clipBy), shown = shown, interactive = interactive or nil,
				})
			end
		end
	end

	local isText = object:IsA("TextLabel") or object:IsA("TextButton") or object:IsA("TextBox")
	if isText and object.Text ~= "" and object.TextTransparency < 1 then
		if CHECK.text_overflow and object.TextFits == false then
			add({
				kind = "text_overflow", path = path, class = object.ClassName, rect = plainRect(r), text = shorten(object.Text),
				bounds = { math.floor(object.TextBounds.X + 0.5), math.floor(object.TextBounds.Y + 0.5) },
				scaled = object.TextScaled or nil, wrapped = object.TextWrapped or nil,
				truncate = if object.TextTruncate ~= Enum.TextTruncate.None then object.TextTruncate.Name else nil,
			})
		end
		if CHECK.small_text then
			local size, estimated = renderedTextSize(object, info.scale)
			if size and finite(size) and size < ARGS.min_text_px then
				add({
					kind = "small_text", path = path, class = object.ClassName, rect = plainRect(r), text = shorten(object.Text),
					size = round(size, 1), estimated = estimated or nil,
				})
			end
		end
	end

	if CHECK.small_touch and touch and interactive then
		local size = object.AbsoluteSize
		if size.X < ARGS.min_touch_px - 0.5 or size.Y < ARGS.min_touch_px - 0.5 then
			add({ kind = "small_touch", path = path, class = object.ClassName, rect = plainRect(r) })
		end
	end

	if CHECK.under_topbar and interactive and inset.Y > 0 then
		local band = intersect(visibleRect, { 0, 0, W, inset.Y })
		if area(band) > 0 then
			-- TopbarInset is the stretch of the bar Roblox leaves free for game UI.
			local free = topbar ~= nil and band[1] >= topbar.Min.X - TOL and band[3] <= topbar.Max.X + TOL
			if not free then
				add({ kind = "under_topbar", path = path, class = object.ClassName, rect = plainRect(r), band = math.floor(inset.Y + 0.5) })
			end
		end
	end

	if CHECK.overlap and interactive and area(visibleRect) > 0 then
		if #candidates < ARGS.max_interactive then
			table.insert(candidates, { object = object, rect = visibleRect, screen = info.screen, drawn = drawn, path = path })
		else
			interactiveTruncated = true
		end
	end
end

-- Render order: ScreenGui DisplayOrder first, then ZIndex globally or between the branches under the common ancestor.
local function above(a, b)
	local sa, sb = a.screen, b.screen
	if sa ~= sb then
		if sa.DisplayOrder ~= sb.DisplayOrder then
			return (if sa.DisplayOrder > sb.DisplayOrder then a else b), "DisplayOrder"
		end
		return nil, "same DisplayOrder"
	end
	local x, y = a.object, b.object
	if sa.ZIndexBehavior == Enum.ZIndexBehavior.Global then
		if x.ZIndex ~= y.ZIndex then return (if x.ZIndex > y.ZIndex then a else b), "ZIndex" end
		return nil, "same ZIndex"
	end
	local branch = {}
	local current = x
	while current ~= sa and current.Parent do
		branch[current.Parent] = current
		current = current.Parent
	end
	current = y
	while current ~= sb and current.Parent do
		local mine = branch[current.Parent]
		if mine then
			local za, zb = readable(mine, "ZIndex"), readable(current, "ZIndex")
			if type(za) == "number" and type(zb) == "number" and za ~= zb then
				return (if za > zb then a else b), "sibling ZIndex"
			end
			return nil, "same sibling ZIndex"
		end
		current = current.Parent
	end
	return nil, "unknown"
end

if CHECK.overlap then
	local compared = 0
	for i = 1, #candidates do
		local a = candidates[i]
		for j = i + 1, #candidates do
			local b = candidates[j]
			compared += 1
			if compared % 5000 == 0 then task.wait() end
			local shared = area(intersect(a.rect, b.rect))
			if shared > 0 then
				local ratio = shared / math.min(area(a.rect), area(b.rect))
				if ratio >= OVERLAP and not a.object:IsAncestorOf(b.object) and not b.object:IsAncestorOf(a.object) then
					local top, why = above(a, b)
					add({
						kind = "overlap", path = a.path, other = b.path,
						rect = plainRect(a.rect), otherRect = plainRect(b.rect), overlap = round(ratio, 2),
						top = if top then top.path else nil, order = why,
						invisible = if not a.drawn and not b.drawn then "both" elseif not a.drawn then a.path elseif not b.drawn then b.path else nil,
					})
				end
			end
		end
	end
end

return {
	root = display(root),
	viewport = { math.floor(W + 0.5), math.floor(H + 0.5) },
	inset = { math.floor(inset.X + 0.5), math.floor(inset.Y + 0.5) },
	topbarFree = if topbar then { math.floor(topbar.Min.X + 0.5), math.floor(topbar.Min.Y + 0.5), math.floor(topbar.Width + 0.5), math.floor(topbar.Height + 0.5) } else nil,
	touch = touch,
	settled = settled,
	simulatedDevice = simulated.device,
	simulatedOrientation = simulated.orientation,
	elements = elements,
	counts = counts,
	findings = findings,
	interactiveTruncated = interactiveTruncated or nil,
	developmentGuiHidden = if player == nil and StarterGui.ShowDevelopmentGui == false then true else nil,
}
`, args);
}
