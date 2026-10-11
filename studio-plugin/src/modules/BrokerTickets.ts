import { HttpService } from "@rbxts/services";

// The broker RemoteFunction is reachable by any Script in the place, and a
// LocalScript can even sit in front of it, so nothing in an envelope can be
// trusted. Plugin settings are shared by every DataModel running the plugin
// and unreadable from game code: the server peer writes the whole request
// there under a single use ticket, and the client runs only what it reads
// back. A stolen ticket can at most replay the request it was issued for.

const KEY_PREFIX = "MCP_BROKER_TICKET_V1_";
const GUID_PATTERN = "^%x+%-%x+%-%x+%-%x+%-%x+$";
// Multiplayer clients are other Studio processes, and a write there can be lost to another window's write.
const REPUBLISH_SECONDS = 0.5;
const REDEEM_WAIT_SECONDS = 2;
const REDEEM_POLL_SECONDS = 0.1;

const PRIVILEGED_ENDPOINTS = new Set<string>(["/api/execute-luau", "/api/eval-runtime", "/api/breakpoints"]);

interface TicketRecord {
	endpoint: string;
	data?: Record<string, unknown>;
}

let pluginRef: Plugin | undefined;
const active = new Set<string>();

function init(p: Plugin): void {
	pluginRef = p;
}

function isPrivileged(endpoint: string): boolean {
	return PRIVILEGED_ENDPOINTS.has(endpoint);
}

function issue(endpoint: string, data: Record<string, unknown> | undefined): string | undefined {
	if (pluginRef === undefined) return undefined;
	const ticket = HttpService.GenerateGUID(false);
	const [encodedOk, encoded] = pcall(() => HttpService.JSONEncode({ endpoint, data }));
	if (!encodedOk) return undefined;
	const key = KEY_PREFIX + ticket;
	const [ok] = pcall(() => pluginRef!.SetSetting(key, encoded));
	if (!ok) return undefined;
	active.add(ticket);
	task.spawn(() => {
		while (active.has(ticket)) {
			task.wait(REPUBLISH_SECONDS);
			if (active.has(ticket)) pcall(() => pluginRef!.SetSetting(key, encoded));
		}
	});
	return ticket;
}

function revoke(ticket: string): void {
	active.delete(ticket);
	if (pluginRef === undefined) return;
	pcall(() => pluginRef!.SetSetting(KEY_PREFIX + ticket, undefined));
}

/** The request data the server peer issued under this ticket, or undefined when it did not issue one for this endpoint. */
function redeem(ticket: unknown, endpoint: string): Record<string, unknown> | undefined {
	if (pluginRef === undefined || !typeIs(ticket, "string") || ticket.match(GUID_PATTERN)[0] === undefined) {
		return undefined;
	}
	const key = KEY_PREFIX + ticket;
	const deadline = os.clock() + REDEEM_WAIT_SECONDS;
	let stored: unknown;
	for (;;) {
		const [ok, value] = pcall(() => pluginRef!.GetSetting(key));
		if (ok && typeIs(value, "string")) {
			stored = value;
			break;
		}
		if (os.clock() >= deadline) return undefined;
		task.wait(REDEEM_POLL_SECONDS);
	}
	pcall(() => pluginRef!.SetSetting(key, undefined));
	const [decodedOk, decoded] = pcall(() => HttpService.JSONDecode(stored as string) as TicketRecord);
	if (!decodedOk || !typeIs(decoded, "table") || decoded.endpoint !== endpoint) return undefined;
	return decoded.data ?? {};
}

export = { init, isPrivileged, issue, revoke, redeem };
