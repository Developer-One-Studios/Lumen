import { LogService, ReplicatedStorage, RunService, ServerScriptService } from "@rbxts/services";
import { BRIDGE_NAMES, ensureRuntimeBridgeInstalled } from "../EvalBridges";
import LuauExec from "../LuauExec";

const PAYLOAD_INSTANCE_NAME = "__LumenEvalPayload";

interface BridgeInvokeResult {
	ok?: boolean;
	value?: unknown;
}

interface WrapperResult {
	ok?: boolean;
	value?: unknown;
	output?: unknown;
}

function findBridge(config: { service: Instance; bridgeName: string }): BindableFunction | undefined {
	const bridge = config.service.FindFirstChild(config.bridgeName);
	return bridge && bridge.IsA("BindableFunction") ? bridge : undefined;
}

function waitForBridge(config: { service: Instance; bridgeName: string }, timeoutSec = 2): BindableFunction | undefined {
	const deadline = tick() + timeoutSec;
	let bridge = findBridge(config);
	while (!bridge && tick() < deadline) {
		task.wait(0.05);
		bridge = findBridge(config);
	}
	return bridge;
}

function getBridgeConfig() {
	if (!RunService.IsRunning()) {
		return {
			error: "eval_*_runtime requires a running playtest.",
		};
	}
	if (RunService.IsServer()) {
		return {
			service: ServerScriptService,
			bridgeName: BRIDGE_NAMES.serverLocal,
			missingError: "ServerEvalBridge not found. The bridge runs inside the play DM, so a playtest must be running. The bridge installs automatically in the runtime server peer, including for manually-started playtests.",
		};
	}
	return {
		service: ReplicatedStorage,
		bridgeName: BRIDGE_NAMES.clientLocal,
		missingError: "ClientEvalBridge not found. The bridge runs inside the play DM, so a playtest must be running. The bridge installs automatically in the runtime client peer, including for manually-started playtests.",
	};
}

function evalRuntime(requestData: Record<string, unknown>) {
	const code = requestData.code as string;
	if (!code || code === "") return { error: "Code is required" };

	const config = getBridgeConfig();
	if (config.error !== undefined) {
		return { bridge: "missing", error: config.error };
	}

	let bridge = findBridge(config);
	if (!bridge) {
		const install = ensureRuntimeBridgeInstalled();
		if (!install.installed) {
			return {
				bridge: "missing",
				error: `${config.missingError} Runtime bridge install failed: ${install.error}`,
			};
		}
		bridge = waitForBridge(config);
	}
	if (!bridge) {
		return {
			bridge: "missing",
			error: `${config.missingError} Runtime bridge was installed but did not become ready.`,
		};
	}

	const m = new Instance("ModuleScript");
	m.Name = PAYLOAD_INSTANCE_NAME;
	const userLines = LuauExec.countLines(code);
	const wrapped = LuauExec.buildWrapper(code, PAYLOAD_INSTANCE_NAME, LuauExec.deadlineOf(requestData));

	const [okSet, setErr] = pcall(() => {
		(m as unknown as { Source: string }).Source = wrapped;
	});
	if (!okSet) {
		m.Destroy();
		return {
			bridge: "ok",
			ok: false,
			error: `ModuleScript Source set failed: ${tostring(setErr)}`,
		};
	}

	m.Parent = game.GetService("Workspace");
	const historyStart = LogService.GetLogHistory().size();
	const [invokeOk, invokeResult] = pcall(() => bridge.Invoke(m) as BridgeInvokeResult);
	m.Destroy();

	if (!invokeOk) {
		return {
			bridge: "ok",
			ok: false,
			error: tostring(invokeResult),
		};
	}

	if (!typeIs(invokeResult, "table")) {
		return {
			bridge: "ok",
			ok: false,
			error: `Eval bridge returned invalid result: ${tostring(invokeResult)}`,
		};
	}

	const bridgeResult = invokeResult as BridgeInvokeResult;
	if (bridgeResult.ok !== true) {
		return {
			bridge: "ok",
			ok: false,
			error: LuauExec.recoverPayloadRequireError(bridgeResult.value, userLines, PAYLOAD_INSTANCE_NAME, historyStart),
		};
	}

	const inner = bridgeResult.value;
	if (!typeIs(inner, "table")) {
		return {
			bridge: "ok",
			ok: true,
			result: inner === undefined ? undefined : LuauExec.formatReturnValue(inner),
		};
	}

	const r = inner as WrapperResult;
	const ok = r.ok === true;
	return {
		bridge: "ok",
		ok,
		result: ok && r.value !== undefined ? LuauExec.formatReturnValue(r.value) : undefined,
		error: !ok ? tostring(r.value) : undefined,
		output: r.output ?? [],
	};
}

export = {
	evalRuntime,
};
