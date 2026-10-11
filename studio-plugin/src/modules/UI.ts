import { RunService, TweenService } from "@rbxts/services";
import State from "./State";
import ServerUrlSettings from "./ServerUrlSettings";

interface UIElements {
	screenGui: DockWidgetPluginGui;
	mainFrame: Frame;
	contentFrame: ScrollingFrame;
	statusLabel: TextLabel;
	detailStatusLabel: TextLabel;
	statusIndicator: Frame;
	statusPulse: Frame;
	statusText: TextLabel;
	connectButton: TextButton;
	connectStroke: UIStroke;
	urlInput: TextBox;
	step1Dot: Frame;
	step1Label: TextLabel;
	step2Dot: Frame;
	step2Label: TextLabel;
	step3Dot: Frame;
	step3Label: TextLabel;
	troubleshootLabel: TextLabel;
	placeValue: TextLabel;
	peerValue: TextLabel;
	requestsValue: TextLabel;
	lastValue: TextLabel;
}

let elements: UIElements = undefined!;
let buttonHover = false;

interface ToolbarIcons {
	disconnected: string;
	connecting: string;
	connected: string;
}
let toolbarButton: PluginToolbarButton | undefined;
let toolbarIcons: ToolbarIcons | undefined;
let lastToolbarIcon: string | undefined;

function setToolbarButton(btn: PluginToolbarButton, icons: ToolbarIcons) {
	toolbarButton = btn;
	toolbarIcons = icons;
	lastToolbarIcon = undefined;
	updateToolbarIcon();
}

function updateToolbarIcon() {
	if (!toolbarButton || !toolbarIcons) return;
	const conn = State.getActiveConnection();
	let nextIcon: string;
	if (!conn || !conn.isActive) {
		nextIcon = toolbarIcons.disconnected;
	} else if (conn.lastHttpOk && conn.lastMcpOk) {
		nextIcon = toolbarIcons.connected;
	} else {
		nextIcon = toolbarIcons.connecting;
	}
	if (nextIcon !== lastToolbarIcon) {
		(toolbarButton as unknown as { Icon: string }).Icon = nextIcon;
		lastToolbarIcon = nextIcon;
	}
}

const TWEEN_QUICK = new TweenInfo(0.15, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);

function tweenProp(instance: Instance, props: Record<string, unknown>) {
	TweenService.Create(instance, TWEEN_QUICK, props as unknown as { [key: string]: unknown }).Play();
}

const C = {
	bg: Color3.fromRGB(16, 16, 18),
	card: Color3.fromRGB(24, 24, 27),
	surface: Color3.fromRGB(34, 34, 38),
	border: Color3.fromRGB(44, 44, 48),
	subtle: Color3.fromRGB(56, 56, 60),
	muted: Color3.fromRGB(112, 112, 120),
	dim: Color3.fromRGB(150, 150, 158),
	label: Color3.fromRGB(196, 196, 204),
	white: Color3.fromRGB(240, 240, 244),
	accent: Color3.fromRGB(255, 194, 51),
	green: Color3.fromRGB(52, 211, 153),
	yellow: Color3.fromRGB(251, 191, 36),
	red: Color3.fromRGB(248, 113, 113),
	gray: Color3.fromRGB(96, 96, 104),
};

const CORNER = new UDim(0, 6);
const BRAND_MARK = "rbxassetid://__BRAND_MARK__";

function corner(parent: Instance, radius: UDim = CORNER) {
	const c = new Instance("UICorner");
	c.CornerRadius = radius;
	c.Parent = parent;
}

function text(parent: Instance, props: Partial<WritableInstanceProperties<TextLabel>>): TextLabel {
	const label = new Instance("TextLabel");
	label.BackgroundTransparency = 1;
	label.Font = Enum.Font.GothamMedium;
	label.TextColor3 = C.label;
	label.TextSize = 11;
	label.TextXAlignment = Enum.TextXAlignment.Left;
	for (const [key, value] of pairs(props)) {
		(label as unknown as Record<string, unknown>)[key as string] = value;
	}
	label.Parent = parent;
	return label;
}

function setButtonConnect(btn: TextButton, stroke: UIStroke) {
	btn.Text = "Connect";
	btn.TextColor3 = C.bg;
	btn.BackgroundColor3 = C.accent;
	stroke.Color = C.accent;
}

function setButtonDisconnect(btn: TextButton, stroke: UIStroke) {
	btn.Text = "Disconnect";
	btn.TextColor3 = C.red;
	btn.BackgroundColor3 = C.bg;
	stroke.Color = Color3.fromRGB(90, 36, 36);
}

function stopPulseAnimation() {
	elements.statusPulse.BackgroundTransparency = 1;
}

function startPulseAnimation() {
	elements.statusPulse.BackgroundTransparency = 0.6;
}

function card(parent: Instance, title: string, order: number): Frame {
	const frame = new Instance("Frame");
	frame.Size = new UDim2(1, 0, 0, 0);
	frame.AutomaticSize = Enum.AutomaticSize.Y;
	frame.BackgroundColor3 = C.card;
	frame.BorderSizePixel = 0;
	frame.LayoutOrder = order;
	frame.Parent = parent;
	corner(frame);

	const stroke = new Instance("UIStroke");
	stroke.Color = C.border;
	stroke.Thickness = 1;
	stroke.Parent = frame;

	const padding = new Instance("UIPadding");
	padding.PaddingLeft = new UDim(0, 12);
	padding.PaddingRight = new UDim(0, 12);
	padding.PaddingTop = new UDim(0, 10);
	padding.PaddingBottom = new UDim(0, 12);
	padding.Parent = frame;

	const layout = new Instance("UIListLayout");
	layout.Padding = new UDim(0, 7);
	layout.SortOrder = Enum.SortOrder.LayoutOrder;
	layout.Parent = frame;

	text(frame, {
		Size: new UDim2(1, 0, 0, 12),
		Text: title,
		TextColor3: C.muted,
		TextSize: 10,
		Font: Enum.Font.GothamBold,
		LayoutOrder: 0,
	});
	return frame;
}

function init(pluginRef: Plugin) {
	const CURRENT_VERSION = State.CURRENT_VERSION;

	const screenGui = pluginRef.CreateDockWidgetPluginGuiAsync(
		"LumenInterface",
		// 3rd arg (initialEnabledShouldOverrideRestore=true) forces the dock closed
		// at every Studio launch. User can still open via the toolbar button.
		new DockWidgetPluginGuiInfo(Enum.InitialDockState.Float, false, true, 310, 380, 270, 240),
	);
	(screenGui as unknown as { Title: string }).Title = `Lumen v${CURRENT_VERSION}`;

	const mainFrame = new Instance("Frame");
	mainFrame.Size = new UDim2(1, 0, 1, 0);
	mainFrame.BackgroundColor3 = C.bg;
	mainFrame.BorderSizePixel = 0;
	mainFrame.Parent = screenGui;

	const header = new Instance("Frame");
	header.Size = new UDim2(1, 0, 0, 54);
	header.BackgroundTransparency = 1;
	header.Parent = mainFrame;

	const logo = new Instance("ImageLabel");
	logo.Size = new UDim2(0, 30, 0, 30);
	logo.Position = new UDim2(0, 12, 0, 12);
	logo.BackgroundTransparency = 1;
	logo.Image = BRAND_MARK;
	logo.ScaleType = Enum.ScaleType.Fit;
	logo.Parent = header;

	text(header, {
		Size: new UDim2(1, -150, 0, 18),
		Position: new UDim2(0, 50, 0, 10),
		RichText: true,
		Text: `<font color="#F0F0F4">Lumen</font> <font color="#707078" size="11">v${CURRENT_VERSION}</font>`,
		TextSize: 16,
		Font: Enum.Font.GothamBold,
	});
	text(header, {
		Size: new UDim2(1, -150, 0, 14),
		Position: new UDim2(0, 50, 0, 29),
		Text: "Roblox Studio for AI agents",
		TextColor3: C.muted,
		TextSize: 10,
	});

	// Sized to its content with even padding, so every label sits centered whatever its length.
	const pill = new Instance("Frame");
	pill.AutomaticSize = Enum.AutomaticSize.X;
	pill.Size = new UDim2(0, 0, 0, 22);
	pill.AnchorPoint = new Vector2(1, 0);
	pill.Position = new UDim2(1, -12, 0, 16);
	pill.BackgroundColor3 = C.surface;
	pill.BorderSizePixel = 0;
	pill.Parent = header;
	corner(pill, new UDim(1, 0));

	const pillPadding = new Instance("UIPadding");
	pillPadding.PaddingLeft = new UDim(0, 10);
	pillPadding.PaddingRight = new UDim(0, 10);
	pillPadding.Parent = pill;

	const pillLayout = new Instance("UIListLayout");
	pillLayout.FillDirection = Enum.FillDirection.Horizontal;
	pillLayout.VerticalAlignment = Enum.VerticalAlignment.Center;
	pillLayout.Padding = new UDim(0, 6);
	pillLayout.SortOrder = Enum.SortOrder.LayoutOrder;
	pillLayout.Parent = pill;

	const statusIndicator = new Instance("Frame");
	statusIndicator.Size = new UDim2(0, 8, 0, 8);
	statusIndicator.BackgroundColor3 = C.red;
	statusIndicator.BorderSizePixel = 0;
	statusIndicator.LayoutOrder = 1;
	statusIndicator.Parent = pill;
	corner(statusIndicator, new UDim(1, 0));

	const statusPulse = new Instance("Frame");
	statusPulse.Size = new UDim2(0, 14, 0, 14);
	statusPulse.Position = new UDim2(0.5, -7, 0.5, -7);
	statusPulse.BackgroundColor3 = C.red;
	statusPulse.BackgroundTransparency = 1;
	statusPulse.BorderSizePixel = 0;
	statusPulse.ZIndex = 0;
	statusPulse.Parent = statusIndicator;
	corner(statusPulse, new UDim(1, 0));

	const statusText = text(pill, {
		AutomaticSize: Enum.AutomaticSize.X,
		Size: new UDim2(0, 0, 1, 0),
		Text: "Offline",
		TextColor3: C.label,
		TextSize: 11,
		Font: Enum.Font.GothamBold,
		LayoutOrder: 2,
	});

	const headerLine = new Instance("Frame");
	headerLine.Size = new UDim2(1, -24, 0, 1);
	headerLine.Position = new UDim2(0, 12, 1, -1);
	headerLine.BackgroundColor3 = C.border;
	headerLine.BorderSizePixel = 0;
	headerLine.Parent = header;

	const contentY = 62;
	const contentFrame = new Instance("ScrollingFrame");
	contentFrame.Size = new UDim2(1, -20, 1, -(contentY + 10));
	contentFrame.Position = new UDim2(0, 10, 0, contentY);
	contentFrame.BackgroundTransparency = 1;
	contentFrame.BorderSizePixel = 0;
	contentFrame.ScrollBarThickness = 3;
	contentFrame.ScrollBarImageColor3 = C.subtle;
	contentFrame.CanvasSize = new UDim2(0, 0, 0, 0);
	contentFrame.AutomaticCanvasSize = Enum.AutomaticSize.Y;
	contentFrame.Parent = mainFrame;

	const contentLayout = new Instance("UIListLayout");
	contentLayout.Padding = new UDim(0, 10);
	contentLayout.SortOrder = Enum.SortOrder.LayoutOrder;
	contentLayout.Parent = contentFrame;

	const connection = card(contentFrame, "CONNECTION", 1);

	const urlInput = new Instance("TextBox");
	urlInput.Size = new UDim2(1, 0, 0, 28);
	urlInput.BackgroundColor3 = C.bg;
	urlInput.BorderSizePixel = 0;
	urlInput.Text = State.getActiveConnection().serverUrl;
	urlInput.TextColor3 = C.label;
	urlInput.TextSize = 12;
	urlInput.Font = Enum.Font.Code;
	urlInput.ClearTextOnFocus = false;
	urlInput.PlaceholderText = "http://localhost:58761";
	urlInput.PlaceholderColor3 = C.muted;
	urlInput.TextXAlignment = Enum.TextXAlignment.Left;
	urlInput.LayoutOrder = 1;
	urlInput.Parent = connection;
	corner(urlInput);

	const urlPadding = new Instance("UIPadding");
	urlPadding.PaddingLeft = new UDim(0, 10);
	urlPadding.PaddingRight = new UDim(0, 10);
	urlPadding.Parent = urlInput;

	urlInput.FocusLost.Connect(() => {
		const conn = State.getActiveConnection();
		if (!conn || conn.isActive) return;
		const normalizedUrl = ServerUrlSettings.normalizeServerUrl(urlInput.Text);
		if (normalizedUrl === "") {
			urlInput.Text = conn.serverUrl;
			return;
		}
		conn.serverUrl = normalizedUrl;
		urlInput.Text = normalizedUrl;
		const port = ServerUrlSettings.extractPort(conn.serverUrl);
		if (port !== undefined) conn.port = port;
	});

	const statusLabel = text(connection, {
		Size: new UDim2(1, 0, 0, 16),
		Text: "Disconnected",
		TextColor3: C.red,
		TextSize: 13,
		Font: Enum.Font.GothamBold,
		TextWrapped: true,
		LayoutOrder: 2,
	});

	const detailStatusLabel = text(connection, {
		Size: new UDim2(1, 0, 0, 0),
		AutomaticSize: Enum.AutomaticSize.Y,
		Text: "",
		TextColor3: C.muted,
		TextSize: 11,
		TextWrapped: true,
		LayoutOrder: 3,
	});

	const stepsFrame = new Instance("Frame");
	stepsFrame.Size = new UDim2(1, 0, 0, 0);
	stepsFrame.AutomaticSize = Enum.AutomaticSize.Y;
	stepsFrame.BackgroundTransparency = 1;
	stepsFrame.LayoutOrder = 4;
	stepsFrame.Parent = connection;

	const stepsLayout = new Instance("UIListLayout");
	stepsLayout.Padding = new UDim(0, 3);
	stepsLayout.SortOrder = Enum.SortOrder.LayoutOrder;
	stepsLayout.Parent = stepsFrame;

	function createStepRow(label: string, order: number): [Frame, TextLabel] {
		const row = new Instance("Frame");
		row.Size = new UDim2(1, 0, 0, 16);
		row.BackgroundTransparency = 1;
		row.LayoutOrder = order;
		row.Parent = stepsFrame;

		const dot = new Instance("Frame");
		dot.Size = new UDim2(0, 6, 0, 6);
		dot.Position = new UDim2(0, 2, 0.5, -3);
		dot.BackgroundColor3 = C.gray;
		dot.BorderSizePixel = 0;
		dot.Parent = row;
		corner(dot, new UDim(1, 0));

		const lbl = text(row, {
			Size: new UDim2(1, -16, 1, 0),
			Position: new UDim2(0, 16, 0, 0),
			Text: label,
			TextColor3: C.dim,
			TextSize: 11,
		});
		return [dot, lbl];
	}

	const [step1Dot, step1Label] = createStepRow("Listener", 1);
	const [step2Dot, step2Label] = createStepRow("Agent link", 2);
	const [step3Dot, step3Label] = createStepRow("Commands", 3);

	const troubleshootLabel = text(connection, {
		Size: new UDim2(1, 0, 0, 0),
		AutomaticSize: Enum.AutomaticSize.Y,
		TextWrapped: true,
		Visible: false,
		Text: "No agent has connected yet. Reconnect Lumen in your agent, for example with /mcp in Claude Code.",
		TextColor3: C.yellow,
		TextSize: 11,
		LayoutOrder: 5,
	});

	const connectButton = new Instance("TextButton");
	connectButton.Size = new UDim2(1, 0, 0, 30);
	connectButton.BackgroundColor3 = C.accent;
	connectButton.BorderSizePixel = 0;
	connectButton.AutoButtonColor = false;
	connectButton.Text = "Connect";
	connectButton.TextColor3 = C.bg;
	connectButton.TextSize = 12;
	connectButton.Font = Enum.Font.GothamBold;
	connectButton.LayoutOrder = 6;
	connectButton.Parent = connection;
	corner(connectButton);

	const connectStroke = new Instance("UIStroke");
	connectStroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
	connectStroke.Color = C.accent;
	connectStroke.Thickness = 1;
	connectStroke.Parent = connectButton;

	connectButton.MouseEnter.Connect(() => {
		buttonHover = true;
		const conn = State.getActiveConnection();
		if (conn && conn.isActive) {
			tweenProp(connectButton, { BackgroundColor3: C.surface });
			tweenProp(connectStroke, { Color: Color3.fromRGB(120, 44, 44) });
		} else {
			tweenProp(connectButton, { BackgroundColor3: Color3.fromRGB(255, 210, 100) });
		}
	});

	connectButton.MouseLeave.Connect(() => {
		buttonHover = false;
		const conn = State.getActiveConnection();
		if (conn && conn.isActive) {
			setButtonDisconnect(connectButton, connectStroke);
		} else {
			setButtonConnect(connectButton, connectStroke);
		}
	});

	const session = card(contentFrame, "SESSION", 2);

	function infoRow(key: string, order: number): TextLabel {
		const row = new Instance("Frame");
		row.Size = new UDim2(1, 0, 0, 16);
		row.BackgroundTransparency = 1;
		row.LayoutOrder = order;
		row.Parent = session;
		text(row, {
			Size: new UDim2(0, 86, 1, 0),
			Text: key,
			TextColor3: C.muted,
			TextSize: 11,
		});
		return text(row, {
			Size: new UDim2(1, -86, 1, 0),
			Position: new UDim2(0, 86, 0, 0),
			Text: "-",
			TextColor3: C.label,
			TextSize: 11,
			TextTruncate: Enum.TextTruncate.AtEnd,
		});
	}

	const placeValue = infoRow("Place", 1);
	const peerValue = infoRow("Peer", 2);
	const requestsValue = infoRow("Requests", 3);
	const lastValue = infoRow("Last request", 4);

	elements = {
		screenGui, mainFrame, contentFrame, statusLabel, detailStatusLabel,
		statusIndicator, statusPulse, statusText, connectButton, connectStroke,
		urlInput, step1Dot, step1Label, step2Dot, step2Label, step3Dot, step3Label,
		troubleshootLabel, placeValue, peerValue, requestsValue, lastValue,
	};

	updateActivity();
	// Ages such as "4s ago" only stay true if the open panel refreshes on its own.
	task.spawn(() => {
		while (true) {
			task.wait(1);
			if (screenGui.Enabled) updateActivity();
		}
	});
}

function peerRole(): string {
	if (!RunService.IsRunning()) return "edit";
	return RunService.IsServer() ? "server" : "client";
}

function ago(seconds: number): string {
	if (seconds < 2) return "just now";
	if (seconds < 60) return `${math.floor(seconds)}s ago`;
	return `${math.floor(seconds / 60)}m ago`;
}

function updateActivity() {
	if (!elements) return;
	const activity = State.getActivity();
	elements.placeValue.Text = game.Name;
	elements.peerValue.Text = peerRole();
	elements.requestsValue.Text = tostring(activity.requests);
	if (activity.lastEndpoint !== undefined && activity.lastAt !== undefined) {
		const [name] = string.gsub(activity.lastEndpoint, "^/api/", "");
		elements.lastValue.Text = `${name}, ${ago(tick() - activity.lastAt)}`;
	} else {
		elements.lastValue.Text = "none yet";
	}
}

function setPill(color: Color3, label: string) {
	elements.statusIndicator.BackgroundColor3 = color;
	elements.statusPulse.BackgroundColor3 = color;
	elements.statusText.Text = label;
	elements.statusText.TextColor3 = color;
}

function setStep(dot: Frame, label: TextLabel, color: Color3, value: string) {
	dot.BackgroundColor3 = color;
	label.Text = value;
}

function updateUIState() {
	updateToolbarIcon();
	const conn = State.getActiveConnection();
	if (!conn) return;
	const el = elements;
	const diagnostics = State.getTransportDiagnostics(tick());
	el.statusLabel.Text = diagnostics.status;
	el.detailStatusLabel.Text = diagnostics.detail;

	if (!conn.isActive) {
		el.statusLabel.TextColor3 = C.dim;
		el.detailStatusLabel.TextColor3 = C.muted;
		setPill(C.red, "Offline");
		stopPulseAnimation();
		setStep(el.step1Dot, el.step1Label, C.gray, "Listener");
		setStep(el.step2Dot, el.step2Label, C.gray, "Agent link");
		setStep(el.step3Dot, el.step3Label, C.gray, "Commands");
		el.troubleshootLabel.Visible = false;
		if (!buttonHover) setButtonConnect(el.connectButton, el.connectStroke);
		el.urlInput.TextEditable = true;
		el.urlInput.BackgroundColor3 = C.bg;
		return;
	}

	if (!buttonHover) setButtonDisconnect(el.connectButton, el.connectStroke);
	el.urlInput.TextEditable = false;
	el.urlInput.BackgroundColor3 = C.surface;

	if (conn.lastHttpOk && conn.lastMcpOk) {
		el.statusLabel.TextColor3 = C.green;
		el.detailStatusLabel.TextColor3 = C.dim;
		setPill(C.green, "Online");
		setStep(el.step1Dot, el.step1Label, C.green, "Listener ready");
		setStep(el.step2Dot, el.step2Label, C.green, "Agent connected");
		setStep(el.step3Dot, el.step3Label, C.green, "Commands flowing");
		el.troubleshootLabel.Visible = false;
		stopPulseAnimation();
	} else if (conn.lastHttpOk && !conn.lastMcpOk) {
		el.statusLabel.TextColor3 = C.yellow;
		el.detailStatusLabel.TextColor3 = C.dim;
		setPill(C.yellow, "Waiting");
		setStep(el.step1Dot, el.step1Label, C.green, "Listener ready");
		setStep(el.step2Dot, el.step2Label, C.yellow, "Waiting for your agent");
		setStep(el.step3Dot, el.step3Label, C.gray, "Commands");
		const elapsed = conn.mcpWaitStartTime !== undefined ? tick() - conn.mcpWaitStartTime : 0;
		el.troubleshootLabel.Visible = elapsed > 8;
		startPulseAnimation();
	} else {
		const retrying = conn.nextRetryAt !== undefined;
		el.statusLabel.TextColor3 = C.yellow;
		el.detailStatusLabel.TextColor3 = C.dim;
		setPill(C.yellow, retrying ? "Retrying" : "Connecting");
		setStep(el.step1Dot, el.step1Label, C.yellow, retrying ? "Listener lost, retrying" : "Reaching the listener");
		setStep(el.step2Dot, el.step2Label, C.gray, "Agent link");
		setStep(el.step3Dot, el.step3Label, C.gray, "Commands");
		el.troubleshootLabel.Visible = false;
		startPulseAnimation();
	}
}

export = {
	elements: undefined as unknown as UIElements,
	init,
	updateUIState,
	updateActivity,
	stopPulseAnimation,
	startPulseAnimation,
	setToolbarButton,
	updateToolbarIcon,
	getElements: () => elements,
};
