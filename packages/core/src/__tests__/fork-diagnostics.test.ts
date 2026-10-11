import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SourcemapResolver } from '../sourcemap.js';
import { TOOL_HANDLERS } from '../http-server.js';
import type { ForkHost, PeerTarget } from '../tools/fork-tools.js';
import { FUZZY_MATCH_LUAU, multiEditLuau } from '../tools/fork-luau.js';
import { collectOccurrences, diagnosticsFeature, getErrors, groupKey, splitStack } from '../tools/fork/diagnostics.js';
import { applySpans, closestWindow, fuzzyMatch, normalizeWhitespace, retryEditIgnoringWhitespace } from '../tools/fork/fuzzy-edit.js';

const has = (binary: string) => !spawnSync(binary, ['--help']).error;
const compiler = has('luau-compile');
const vm = has('luau');

function text(body: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(body) }] };
}

const body = (result: { content: Array<{ text?: string }> }) => JSON.parse(result.content[0].text!);

function scratch(name: string, contents: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fork-diagnostics-')), name);
  fs.writeFileSync(file, contents);
  return file;
}

// A double-quoted Luau literal, since long brackets fold CRLF to LF.
function luauString(value: string): string {
  let out = '"';
  for (const byte of Buffer.from(value, 'utf8')) {
    out += byte >= 32 && byte <= 126 && byte !== 34 && byte !== 92 ? String.fromCharCode(byte) : `\\${String(byte).padStart(3, '0')}`;
  }
  return `${out}"`;
}

function luauValue(value: unknown): string {
  if (typeof value === 'string') return luauString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `{ ${value.map(luauValue).join(', ')} }`;
  if (value && typeof value === 'object') {
    return `{ ${Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => `[${luauString(key)}] = ${luauValue(item)}`).join(', ')} }`;
  }
  return 'nil';
}

const LUAU_ENCODE = String.raw`
local function encode(value)
	local kind = type(value)
	if kind == "string" then
		return '"' .. string.gsub(value, '[%c"\\]', function(c) return string.format("\\u%04x", string.byte(c)) end) .. '"'
	elseif kind == "number" or kind == "boolean" then
		return tostring(value)
	elseif kind == "table" then
		local parts = {}
		if #value > 0 then
			for _, item in ipairs(value) do table.insert(parts, encode(item)) end
			return "[" .. table.concat(parts, ",") .. "]"
		end
		for key, item in value do table.insert(parts, encode(tostring(key)) .. ":" .. encode(item)) end
		return "{" .. table.concat(parts, ",") .. "}"
	end
	return "null"
end
`;

function runLuau(code: string): unknown {
  const result = spawnSync('luau', [scratch('run.luau', code)], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

const INDENTED = 'local function f()\n\tif ready then\n\t\treturn 1\n\tend\nend\n';

describe('whitespace-tolerant matching', () => {
  test('normalization collapses runs, drops trailing whitespace and CR, and maps back to the original', () => {
    const normalized = normalizeWhitespace('a \t b  \r\nc ');
    expect(normalized.text).toBe('a b\nc');
    // The newline owns the "  \r" before it, the collapsed space owns " \t ".
    expect(normalized.starts).toEqual([0, 1, 4, 5, 9]);
    expect(normalized.ends).toEqual([1, 4, 5, 9, 10]);
  });

  test('indentation width and tabs versus spaces do not matter', () => {
    const match = fuzzyMatch(INDENTED, '    if ready then\n        return 1\n    end');
    expect(match.ok).toBe(true);
    if (!match.ok) return;
    const [span] = match.spans;
    expect(INDENTED.slice(span.start, span.end)).toBe('\tif ready then\n\t\treturn 1\n\tend');
    expect([span.startLine, span.endLine]).toEqual([2, 4]);
    expect(applySpans(INDENTED, match.spans, '\tif ready then\n\t\treturn 2\n\tend'))
      .toBe('local function f()\n\tif ready then\n\t\treturn 2\n\tend\nend\n');
  });

  test('trailing whitespace in the script is ignored and stays outside a span that ends mid-line', () => {
    const source = 'local a = 1   \nlocal b = 2  \nprint(a)\n';
    const match = fuzzyMatch(source, 'local a = 1\nlocal b = 2');
    expect(match.ok && source.slice(match.spans[0].start, match.spans[0].end)).toBe('local a = 1   \nlocal b = 2');
  });

  test('CRLF scripts match LF text and a matched newline takes its CR with it', () => {
    const source = 'x()\r\ny()\r\nz()\r\n';
    const match = fuzzyMatch(source, 'x()\ny()\n');
    expect(match.ok).toBe(true);
    if (!match.ok) return;
    expect(source.slice(match.spans[0].start, match.spans[0].end)).toBe('x()\r\ny()\r\n');
    expect([match.spans[0].startLine, match.spans[0].endLine]).toEqual([1, 2]);
    expect(applySpans(source, match.spans, 'w()\n')).toBe('w()\nz()\r\n');
  });

  test('runs inside a line collapse and a match may start mid-line', () => {
    const source = 'if ready then  start(a,  b)   end\n';
    const match = fuzzyMatch(source, 'start(a, b) end');
    expect(match.ok && source.slice(match.spans[0].start, match.spans[0].end)).toBe('start(a,  b)   end');
  });

  test('whitespace that is missing entirely still has to match', () => {
    const match = fuzzyMatch('foo(a,b)\n', 'foo(a, b)');
    expect(match.ok).toBe(false);
    if (match.ok) return;
    expect(match.error).toMatch(/^old_string not found, even ignoring whitespace\. Closest text is line 1 \(\d+% similar\):\n1: foo\(a,b\)$/);
  });

  test('several matches fail and quote each candidate, unless every match is wanted', () => {
    const source = '\tprint(1)\nx()\n    print(1)\n';
    const match = fuzzyMatch(source, '  print(1)');
    expect(match).toEqual({
      ok: false,
      error: 'old_string is not exact and matches 2 places ignoring whitespace (lines 1, 3). '
        + 'Include more surrounding lines to make it unique:\n1: \tprint(1)\n--\n3:     print(1)',
    });
    const all = fuzzyMatch(source, '  print(1)', { all: true });
    expect(all.ok && applySpans(source, all.spans, '\tprint(2)')).toBe('\tprint(2)\nx()\n\tprint(2)\n');
  });

  test('a trailing space or tab in old_string still needs whitespace after the match', () => {
    const missed = fuzzyMatch('local xy = 2\nprint(xy)\n', 'local x ');
    expect(!missed.ok && missed.error).toMatch(/^old_string not found, even ignoring whitespace\./);
    const source = 'local count\t= 0\ncounter += 1\nprint(count)\n';
    const all = fuzzyMatch(source, 'count ', { all: true });
    expect(all.ok && applySpans(source, all.spans, 'total ')).toBe('local total = 0\ncounter += 1\nprint(count)\n');
  });

  test('a candidate that fails the trailing boundary does not hide an overlapping one', () => {
    const source = 'local xxx\t= 1\n';
    const match = fuzzyMatch(source, 'xx ');
    expect(match.ok && applySpans(source, match.spans, 'yy ')).toBe('local xyy = 1\n');
  });

  test('a line end or the end of the script also meets a trailing boundary, and stays untouched', () => {
    const crlf = 'local  x\t\r\nfoo\r\n';
    const match = fuzzyMatch(crlf, 'local x ');
    expect(match.ok && applySpans(crlf, match.spans, 'local z ')).toBe('local z \t\r\nfoo\r\n');
    const eof = fuzzyMatch('local  x', 'local x ');
    expect(eof.ok && applySpans('local  x', eof.spans, 'local z ')).toBe('local z ');
  });

  test('a line anchor picks the match that starts there', () => {
    const source = '\tprint(1)\nx()\n    print(1)\n';
    const anchored = fuzzyMatch(source, '  print(1)', { line: 3 });
    expect(anchored.ok && anchored.spans.map((span) => span.startLine)).toEqual([3]);
    expect(fuzzyMatch(source, '  print(1)', { line: 2 })).toEqual({
      ok: false,
      error: 'old_string does not match at line 2, even ignoring whitespace. Text there is line 2 (0% similar):\n2: x()\n'
        + 'It does match at lines 1, 3 ignoring whitespace.',
    });
  });

  test('a line anchor finds a match that overlaps an earlier one', () => {
    const source = '\tend\n\tend\n\tend\n';
    const match = fuzzyMatch(source, '  end\n  end', { line: 2 });
    expect(match.ok && match.spans.map((span) => [span.startLine, span.endLine])).toEqual([[2, 3]]);
    expect(match.ok && applySpans(source, match.spans, '\tdone\n\tdone')).toBe('\tend\n\tdone\n\tdone\n');
  });

  test('an anchored miss quotes the anchored lines, then the closest text elsewhere', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `local value${i} = compute(${i})`);
    lines[19] = 'local function damage(target, amount)';
    const needle = 'local function damage(target, amout)';
    const elsewhere = fuzzyMatch(lines.join('\n'), needle, { line: 5 });
    expect(!elsewhere.ok && elsewhere.error.split('\n')).toEqual([
      expect.stringMatching(/^old_string does not match at line 5, even ignoring whitespace\. Text there is line 5 \(\d+% similar\):$/),
      '5: local value4 = compute(4)',
      expect.stringMatching(/^Closest text is line 20 \(\d+% similar\):$/),
      '20: local function damage(target, amount)',
    ]);
    const here = fuzzyMatch(lines.join('\n'), needle, { line: 20 });
    expect(!here.ok && here.error.split('\n')).toEqual([
      expect.stringMatching(/^old_string does not match at line 20, even ignoring whitespace\. Text there is line 20 \(\d+% similar\):$/),
      '20: local function damage(target, amount)',
    ]);
  });

  test('an old_string of only whitespace never matches loosely', () => {
    expect(fuzzyMatch('a\n\n  \nb', ' \t ')).toEqual({ ok: false, error: 'old_string not found, and it is only whitespace.' });
  });

  test('the closest window is the most similar run of lines, quoted with line numbers', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `local value${i} = compute(${i})`);
    lines[19] = 'local function damage(target, amount)';
    lines[20] = '\ttarget.Health -= amount';
    lines[21] = 'end';
    const match = fuzzyMatch(lines.join('\n'), 'local function damage(target, amout)\n  target.Health = amount\nend');
    expect(match.ok).toBe(false);
    if (match.ok) return;
    const [head, ...quoted] = match.error.split('\n');
    expect(head).toMatch(/^old_string not found, even ignoring whitespace\. Closest text is lines 20-22 \((\d+)% similar\):$/);
    expect(Number(/\((\d+)%/.exec(head)![1])).toBeGreaterThan(80);
    expect(quoted).toEqual(['20: local function damage(target, amount)', '21: \ttarget.Health -= amount', '22: end']);
  });

  test('quotes are bounded in line length and height', () => {
    const long = `print("${'x'.repeat(300)}")`;
    const source = [long, ...Array.from({ length: 20 }, (_, i) => `line${i}()`)].join('\n');
    const needle = [`print("${'x'.repeat(299)}y")`, ...Array.from({ length: 19 }, (_, i) => `line${i}()`)].join('\n');
    const match = fuzzyMatch(source, needle);
    expect(match.ok).toBe(false);
    if (match.ok) return;
    const quoted = match.error.split('\n').slice(1);
    expect(quoted[0]).toBe(`1: ${long.slice(0, 160)}...`);
    expect(quoted).toHaveLength(13);
    expect(quoted[12]).toBe('... 8 more lines');
  });

  test('a huge script stays within the comparison budget and still finds the planted lines', () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `local filler${i} = ${i}`);
    const wanted = Array.from({ length: 40 }, (_, i) => `planted.call${i}(alpha, beta)`);
    lines.splice(12_345, 40, ...wanted);
    const started = Date.now();
    const closest = closestWindow(lines.join('\n'), wanted.map((line) => line.replace('alpha', 'alfa')).join('\n'));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(closest.startLine).toBe(12_346);
    expect(closest.endLine).toBe(12_385);
  });
});

const PARITY_CASES: Array<{ name: string; source: string; needle: string; replacement: string; all?: boolean }> = [
  { name: 'indentation', source: INDENTED, needle: '    if ready then\n        return 1\n    end', replacement: 'R' },
  { name: 'trailing', source: 'local a = 1   \nlocal b = 2  \nprint(a)\n', needle: 'local a = 1\nlocal b = 2', replacement: 'R' },
  { name: 'crlf', source: 'x()\r\ny()\r\nz()\r\n', needle: 'x()\ny()\n', replacement: 'w()\n' },
  { name: 'mid-line', source: 'if ready then  start(a,  b)   end\n', needle: 'start(a, b) end', replacement: 'go()' },
  { name: 'missing space', source: 'foo(a,b)\nbar()\n', needle: 'foo(a, b)', replacement: 'R' },
  { name: 'ambiguous', source: '\tprint(1)\nx()\n    print(1)\n', needle: '  print(1)', replacement: 'R' },
  { name: 'replace all', source: '\tprint(1)\nx()\n    print(1)\n', needle: '  print(1)', replacement: '\tprint(2)', all: true },
  { name: 'whitespace only', source: 'a\n\n  \nb', needle: ' \t ', replacement: 'R' },
  {
    name: 'closest',
    source: Array.from({ length: 30 }, (_, i) => (i === 20 ? '\ttarget.Health -= amount' : `local value${i} = compute(${i})`)).join('\n'),
    needle: 'local value19 = compute(19)\n  target.Health = amount\nlocal value21 = compute(21)',
    replacement: 'R',
  },
  { name: 'long lines', source: `print("${'x'.repeat(300)}")\n${'a()\n'.repeat(20)}`, needle: `print("${'x'.repeat(299)}y")\n${'b()\n'.repeat(15)}`, replacement: 'R' },
  { name: 'many matches', source: 'x = 1\n'.repeat(14), needle: 'x  =  1', replacement: 'R' },
  { name: 'empty source', source: '', needle: 'anything', replacement: 'R' },
  { name: 'boundary miss', source: 'local xy = 2\nprint(xy)\n', needle: 'local x ', replacement: 'local z ' },
  { name: 'boundary all', source: 'local count\t= 0\ncounter += 1\nprint(count)\n', needle: 'count ', replacement: 'total ', all: true },
  { name: 'boundary overlap', source: 'local xxx\t= 1\n', needle: 'xx ', replacement: 'yy ' },
  { name: 'boundary line end', source: 'local  x\t\r\nfoo\r\n', needle: 'local x ', replacement: 'local z ' },
  { name: 'boundary eof', source: 'local  x', needle: 'local x ', replacement: 'local z ' },
  { name: 'boundary leading newline', source: 'a\nx  \nx\n', needle: '\nx ', replacement: '\ny', all: true },
];

(vm ? describe : describe.skip)('Luau port of the matcher', () => {
  test('agrees with the TypeScript matcher on spans, replacements and errors', () => {
    const driver = [
      'task = { wait = function() end }',
      FUZZY_MATCH_LUAU,
      LUAU_ENCODE,
      `local cases = ${luauValue(PARITY_CASES)}`,
      'local out = {}',
      'for i, case in ipairs(cases) do',
      '\tlocal spans, problem = fuzzyMatch(case.source, case.needle, case.all == true)',
      '\tif spans == nil then',
      '\t\tout[i] = { error = problem }',
      '\telse',
      '\t\tlocal list = {}',
      '\t\tfor j, span in ipairs(spans) do list[j] = { span.first, span.last, span.startLine, span.endLine } end',
      '\t\tout[i] = { spans = list, replaced = fuzzyReplace(case.source, spans, case.replacement) }',
      '\tend',
      'end',
      'print(encode(out))',
    ].join('\n');
    const luau = runLuau(driver) as Array<Record<string, unknown>>;
    const typescript = PARITY_CASES.map((entry) => {
      const match = fuzzyMatch(entry.source, entry.needle, { all: entry.all });
      if (!match.ok) return { error: match.error };
      return {
        spans: match.spans.map((span) => [span.start + 1, span.end, span.startLine, span.endLine]),
        replaced: applySpans(entry.source, match.spans, entry.replacement),
      };
    });
    expect(luau).toEqual(typescript);
  });
});

// The real multi_edit snippet against a stub DataModel holding one script.
function runMultiEdit(source: string, edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }>) {
  const args = { path: 'game.ServerScriptService.Main', parent_path: 'game.ServerScriptService', name: 'Main', edits };
  const harness = String.raw`
task = { wait = function() end }
Enum = { FinishRecordingOperation = { Commit = "Commit", Cancel = "Cancel" } }
local SOURCE = ${luauString(source)}
local written = nil
local recorded = nil
local scriptStub = { Name = "Main", ClassName = "Script" }
function scriptStub:IsA(class) return class == "LuaSourceContainer" end
local folder = { Name = "ServerScriptService", ClassName = "ServerScriptService" }
function folder:FindFirstChild(name) return if name == "Main" then scriptStub else nil end
scriptStub.Parent = folder
local services = {
	HttpService = { JSONDecode = function() return ${luauValue(args)} end },
	ScriptEditorService = {
		GetEditorSource = function() return SOURCE end,
		UpdateSourceAsync = function(_, _, update) written = update(SOURCE) end,
	},
	ChangeHistoryService = {
		TryBeginRecording = function() return "recording" end,
		FinishRecording = function(_, _, operation) recorded = operation end,
	},
	RunService = { IsRunning = function() return false end },
	ServerScriptService = folder,
}
game = {
	GetService = function(_, name) return services[name] or error("no service " .. name) end,
	FindFirstChild = function() return nil end,
}
folder.Parent = game
${LUAU_ENCODE}
local result = (function()
${multiEditLuau(args)}
end)()
print(encode({ result = result, written = written or false, recorded = recorded or false }))
`;
  return runLuau(harness) as { result: Record<string, unknown>; written: string | false; recorded: string | false };
}

describe('multi_edit snippet', () => {
  test.each([
    ['fuzzy', multiEditLuau({ path: 'game.ServerScriptService.A', edits: [{ old_string: 'a', new_string: 'b', replace_all: true }] })],
    ['matcher', `task = { wait = function() end }\n${FUZZY_MATCH_LUAU}\nreturn fuzzyMatch, fuzzyReplace, fuzzyRange`],
  ])('%s compiles as Luau', (name, code) => {
    if (!compiler) return;
    const result = spawnSync('luau-compile', ['--null', scratch(`${name}.luau`, code)], { encoding: 'utf8' });
    expect(result.stderr + result.stdout).not.toMatch(/error/i);
    expect(result.status).toBe(0);
  });

  (vm ? test : test.skip)('applies exact and whitespace-drifted edits together and reports the fuzzy ones', () => {
    const source = 'local a = 1\nlocal function f()\n\tif a then\n\t\tprint(a)\n\tend\nend\n';
    const run = runMultiEdit(source, [
      { old_string: 'local a = 1', new_string: 'local a = 2' },
      { old_string: '    if a then\n        print(a)\n    end', new_string: '\tif a then\n\t\twarn(a)\n\tend' },
    ]);
    expect(run.written).toBe('local a = 2\nlocal function f()\n\tif a then\n\t\twarn(a)\n\tend\nend\n');
    expect(run.recorded).toBe('Commit');
    expect(run.result).toMatchObject({ path: 'game.ServerScriptService.Main', edits: 2, fuzzy: true, fuzzyEdits: [{ edit: 2, lines: '3-5', matches: 1 }] });
  });

  (vm ? test : test.skip)('writes nothing when a later edit matches nowhere, even loosely', () => {
    const run = runMultiEdit('local a = 1\nprint(a)\n', [
      { old_string: 'local a = 1', new_string: 'local a = 2' },
      { old_string: 'print(b)', new_string: 'print(c)' },
    ]);
    expect(run.written).toBe(false);
    expect(run.result.error).toMatch(/^edit 2: old_string not found, even ignoring whitespace\. Closest text is line 2 \(\d+% similar\):\n2: print\(a\)$/);
  });

  (vm ? test : test.skip)('replace_all applies to every whitespace-insensitive match', () => {
    const run = runMultiEdit('\tprint(1)\nx()\n    print(1)\n', [{ old_string: '\t\tprint(1)', new_string: '\tprint(2)', replace_all: true }]);
    expect(run.written).toBe('\tprint(2)\nx()\n\tprint(2)\n');
    expect(run.result.fuzzyEdits).toEqual([{ edit: 1, lines: '1, 3', matches: 2 }]);
  });

  (vm ? test : test.skip)('a fuzzy replace_all lists a bounded number of line ranges', () => {
    const run = runMultiEdit('x = 1\n'.repeat(14), [{ old_string: 'x  =  1', new_string: 'y = 1', replace_all: true }]);
    expect(run.written).toBe('y = 1\n'.repeat(14));
    expect(run.result.fuzzyEdits).toEqual([{ edit: 1, lines: '1, 2, 3, 4, 5, 6, 7, 8, 9, 10, ...', matches: 14 }]);
  });

  (vm ? test : test.skip)('fuzzy line ranges are where the match stood when that edit ran', () => {
    const run = runMultiEdit('a()\n\tb()\n', [
      { old_string: '  b()', new_string: '\tc()' },
      { old_string: 'a()', new_string: '-- one\n-- two\na()' },
    ]);
    expect(run.written).toBe('-- one\n-- two\na()\n\tc()\n');
    expect(run.result.fuzzyEdits).toEqual([{ edit: 1, lines: '2', matches: 1 }]);
  });

  (vm ? test : test.skip)('a trailing space in old_string never matches the start of a longer word', () => {
    const run = runMultiEdit('local xy = 2\nprint(xy)\n', [{ old_string: 'local x ', new_string: 'local z ' }]);
    expect(run.written).toBe(false);
    expect(run.result.error).toMatch(/^edit 1: old_string not found, even ignoring whitespace\./);
  });

  (vm ? test : test.skip)('exact edits report no fuzzy fields', () => {
    const run = runMultiEdit('local a = 1\n', [{ old_string: 'a = 1', new_string: 'a = 2' }]);
    expect(run.written).toBe('local a = 2\n');
    expect(run.result.fuzzy).toBeUndefined();
    expect(run.result.fuzzyEdits).toBeUndefined();
  });
});

describe('log digests', () => {
  test('trailing frames are split off a message, and plain messages are left whole', () => {
    expect(splitStack('ServerScriptService.Main:12: boom\nServerScriptService.Main:12 function explode\nServerScriptService.Main:30\n')).toEqual({
      message: 'ServerScriptService.Main:12: boom',
      stack: ['ServerScriptService.Main:12 function explode', 'ServerScriptService.Main:30'],
    });
    expect(splitStack("boom\nStack Begin\nScript 'Workspace.Part.Script', Line 3\nStack End")).toEqual({
      message: 'boom',
      stack: ["Script 'Workspace.Part.Script', Line 3"],
    });
    expect(splitStack('Players.Alice.PlayerGui.Hud:4: attempt to index nil with \'Text\'')).toEqual({
      message: 'Players.Alice.PlayerGui.Hud:4: attempt to index nil with \'Text\'',
      stack: [],
    });
  });

  test('separately logged stack entries attach to the error before them', () => {
    const found = collectOccurrences([
      { seq: 1, ts: 1, level: 'ERR', message: 'ServerScriptService.Main:12: boom' },
      { seq: 2, ts: 1, level: 'INFO', message: 'Stack Begin' },
      { seq: 3, ts: 1, level: 'INFO', message: "Script 'ServerScriptService.Main', Line 12 - function explode" },
      { seq: 4, ts: 1, level: 'INFO', message: "Script 'ServerScriptService.Main', Line 30" },
      { seq: 5, ts: 1, level: 'INFO', message: 'Stack End' },
      { seq: 6, ts: 2, level: 'OUT', message: 'hello' },
      // Frames logged without the Begin and End markers.
      { seq: 7, ts: 3, level: 'WARN', message: 'Infinite yield possible on \'Workspace:WaitForChild("Door")\'' },
      { seq: 8, ts: 3, level: 'INFO', message: "Script 'Workspace.Door.Script', Line 1" },
      { seq: 9, ts: 4, level: 'OUT', message: 'unrelated print' },
      { seq: 10, ts: 4, level: 'INFO', message: "Script 'Workspace.Stray', Line 2" },
      { seq: 11, ts: 5, level: 'ERR', message: 'Workspace.Lost:9: third' },
      { seq: 12, ts: 5, level: 'INFO', message: 'Stack Begin' },
      { seq: 13, ts: 5, level: 'INFO', message: "Script 'Workspace.Lost', Line 9" },
      // The Stack End of this block was never logged.
      { seq: 14, ts: 6, level: 'ERR', message: 'Workspace.Next:2: second' },
    ], 'server');
    expect(found.map(({ level, message, stack }) => ({ level, message, stack }))).toEqual([
      {
        level: 'ERR',
        message: 'ServerScriptService.Main:12: boom',
        stack: ["Script 'ServerScriptService.Main', Line 12 - function explode", "Script 'ServerScriptService.Main', Line 30"],
      },
      { level: 'WARN', message: 'Infinite yield possible on \'Workspace:WaitForChild("Door")\'', stack: ["Script 'Workspace.Door.Script', Line 1"] },
      { level: 'ERR', message: 'Workspace.Lost:9: third', stack: ["Script 'Workspace.Lost', Line 9"] },
      { level: 'ERR', message: 'Workspace.Next:2: second', stack: [] },
    ]);
  });
});

type Buffers = Record<string, Array<Record<string, unknown>>>;

// Each peer serves its buffer the way RuntimeLogBuffer.query does: entries after since, and the newest seq.
function logHost(peers: PeerTarget[], buffers: Buffers, failing = new Set<string>()) {
  const requests: Array<{ peerId: string; data: Record<string, unknown> }> = [];
  const targets: Array<[string | undefined, string | undefined]> = [];
  const host: ForkHost = {
    peerTargets: async (target, instanceId) => {
      targets.push([target, instanceId]);
      return peers;
    },
    requestPeer: async (endpoint, data, peerId) => {
      expect(endpoint).toBe('/api/get-runtime-logs');
      requests.push({ peerId, data: data as Record<string, unknown> });
      if (failing.has(peerId)) throw new Error('peer timed out');
      const since = (data as { since?: number }).since;
      const entries = buffers[peerId] ?? [];
      const last = entries[entries.length - 1];
      return {
        entries: since === undefined ? entries : entries.filter((entry) => (entry.seq as number) > since),
        totalDropped: 0,
        nextSince: last ? last.seq : (since ?? 0),
      };
    },
    soloPlaytest: async () => text({}),
    getRuntimeLogs: async () => text({}),
  };
  return { host, requests, targets };
}

const PEERS = [{ role: 'client-1', peerId: 'c1' }, { role: 'edit', peerId: 'e' }, { role: 'server', peerId: 's' }];

function crash(seq: number, ts: number, line = 12): Array<Record<string, unknown>> {
  return [
    { seq, ts, level: 'ERR', message: `ServerScriptService.Main:${line}: attempt to index nil with 'Health'` },
    { seq: seq + 1, ts, level: 'INFO', message: 'Stack Begin' },
    { seq: seq + 2, ts, level: 'INFO', message: `Script 'ServerScriptService.Main', Line ${line}` },
    { seq: seq + 3, ts, level: 'INFO', message: 'Stack End' },
  ];
}

function decode(cursor: string) {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).peers;
}

describe('get_errors', () => {
  test('groups repeats across peers with counts, roles, times and the stack, oldest first', async () => {
    const buffers: Buffers = {
      e: [{ seq: 1, ts: 5, level: 'OUT', message: 'edit noise' }],
      s: [
        ...crash(1, 10),
        { seq: 5, ts: 11, level: 'WARN', message: 'Infinite yield possible' },
        ...crash(6, 12),
        { seq: 10, ts: 13, level: 'ERR', message: 'ServerScriptService.Loot:3: bad drop' },
      ],
      c1: [{ seq: 1, ts: 9, level: 'ERR', message: "ServerScriptService.Main:12: attempt to index nil with 'Health'" }],
    };
    const { host, targets } = logHost(PEERS, buffers);
    const result = body(await getErrors(host, 'inst-group', {}));
    expect(targets).toEqual([['all', 'inst-group']]);
    expect(result.from).toBe('start');
    expect(result.peers).toEqual(['edit', 'server', 'client-1']);
    expect(result.totals).toEqual({ errors: 4, warnings: 1 });
    expect(result.groups).toEqual([
      {
        level: 'error',
        message: "ServerScriptService.Main:12: attempt to index nil with 'Health'",
        count: 3,
        peers: ['server', 'client-1'],
        firstTs: 9,
        lastTs: 12,
        stack: ["Script 'ServerScriptService.Main', Line 12"],
      },
      { level: 'error', message: 'ServerScriptService.Loot:3: bad drop', count: 1, peers: ['server'], firstTs: 13, lastTs: 13 },
    ]);
    expect(decode(result.cursor)).toEqual({ c1: 1, e: 1, s: 10 });
  });

  test('a bare call continues from the previous one, a cursor from its point, and all from the start', async () => {
    const buffers: Buffers = { s: crash(1, 10), e: [] };
    const { host, requests } = logHost([{ role: 'edit', peerId: 'e' }, { role: 'server', peerId: 's' }], buffers);
    const first = body(await getErrors(host, 'inst-cursor', {}));
    expect(first.groups).toHaveLength(1);

    buffers.s.push({ seq: 5, ts: 20, level: 'ERR', message: 'Workspace.Trap:7: new failure' });
    requests.length = 0;
    const second = body(await getErrors(host, 'inst-cursor', {}));
    expect(second.from).toBe('last_call');
    expect(requests.find((request) => request.peerId === 's')!.data).toEqual({ since: 4 });
    expect(second.groups.map((group: { message: string }) => group.message)).toEqual(['Workspace.Trap:7: new failure']);

    const replay = body(await getErrors(host, 'inst-cursor', { since: first.cursor }));
    expect(replay.from).toBe('cursor');
    expect(replay.groups.map((group: { message: string }) => group.message)).toEqual(['Workspace.Trap:7: new failure']);

    const all = body(await getErrors(host, 'inst-cursor', { since: 'all' }));
    expect(all.totals.errors).toBe(2);
    expect(body(await getErrors(host, 'inst-cursor', {})).groups).toEqual([]);
  });

  test('bare calls with and without instance_id share one cursor per peer, and new peers start fresh', async () => {
    const buffers: Buffers = { e: crash(1, 10), s: [] };
    const peers: PeerTarget[] = [{ role: 'edit', peerId: 'e' }];
    const { host, requests } = logHost(peers, buffers);
    expect(body(await getErrors(host, undefined, {})).groups).toHaveLength(1);

    peers.push({ role: 'server', peerId: 's' });
    buffers.s.push(...crash(1, 20, 40));
    requests.length = 0;
    const second = body(await getErrors(host, 'studio-1', {}));
    expect(second.from).toBe('last_call');
    expect(requests).toEqual([{ peerId: 'e', data: { since: 4 } }, { peerId: 's', data: {} }]);
    expect(second.groups.map((group: { message: string }) => group.message)).toEqual(["ServerScriptService.Main:40: attempt to index nil with 'Health'"]);
  });

  test('get_errors is read-only but not idempotent, since a bare call advances the cursor', () => {
    expect(diagnosticsFeature.definitions[0].annotations).toMatchObject({ readOnlyHint: true, idempotentHint: false });
  });

  test('levels select errors, warnings or both, and limit reports what it left out', async () => {
    const entries = [
      { seq: 1, ts: 1, level: 'WARN', message: 'slow' },
      { seq: 2, ts: 2, level: 'ERR', message: 'one' },
      { seq: 3, ts: 3, level: 'ERR', message: 'two' },
      { seq: 4, ts: 4, level: 'ERR', message: 'three' },
    ];
    const { host } = logHost([{ role: 'server', peerId: 's' }], { s: entries });
    const warnings = body(await getErrors(host, 'inst-level', { since: 'all', level: 'warnings' }));
    expect(warnings.groups.map((group: { message: string }) => group.message)).toEqual(['slow']);
    const both = body(await getErrors(host, 'inst-level', { since: 'all', level: 'both', limit: 2 }));
    expect(both.groups.map((group: { level: string; message: string }) => `${group.level}:${group.message}`)).toEqual(['error:one', 'error:two']);
    expect(both).toMatchObject({ truncated: true, omittedGroups: 2 });
    const all = body(await getErrors(host, 'inst-level', { since: 'all', level: 'both' }));
    expect(all.groups.map((group: { level: string; message: string }) => `${group.level}:${group.message}`)).toEqual(['error:one', 'error:two', 'error:three', 'warning:slow']);
    await expect(getErrors(host, 'inst-level', { level: 'fatal' })).rejects.toThrow(/level must be/);
    await expect(getErrors(host, 'inst-level', { since: 'bm90IGEgY3Vyc29y' })).rejects.toThrow(/since must be a cursor/);
    await expect(getErrors(host, 'inst-level', { since: 12 })).rejects.toThrow(/since must be a cursor/);
  });

  test('numbers in a message do not split a group, but a different script line does', async () => {
    const entries = [
      ...Array.from({ length: 20 }, (_, i) => ({ seq: i + 1, ts: i + 1, level: 'WARN', message: `ammo was nil for slot ${i + 1}` })),
      { seq: 21, ts: 30, level: 'ERR', message: 'Workspace.Gun:12: reload took 0.25 s' },
      { seq: 22, ts: 31, level: 'ERR', message: 'Workspace.Gun:12: reload took 1.5 s' },
      { seq: 23, ts: 32, level: 'ERR', message: 'Workspace.Gun:40: reload took 1.5 s' },
    ];
    const { host } = logHost([{ role: 'server', peerId: 's' }], { s: entries });
    const result = body(await getErrors(host, 'inst-numbers', { since: 'all', level: 'both', limit: 3 }));
    expect(result.groups.map((group: { message: string; count: number; variants?: number }) => [group.message, group.count, group.variants])).toEqual([
      ['Workspace.Gun:12: reload took 0.25 s', 2, 2],
      ['Workspace.Gun:40: reload took 1.5 s', 1, undefined],
      ['ammo was nil for slot 1', 20, 20],
    ]);
    expect(result.truncated).toBeUndefined();
    expect(groupKey('ERR', 'Players.Player12.PlayerGui:7: bad 3')).toBe('ERR\nPlayers.Player#.PlayerGui:7: bad #');
  });

  test('a failing peer is reported and keeps its old cursor while the others advance', async () => {
    const buffers: Buffers = { s: crash(1, 10), c1: [] };
    const peers = [{ role: 'server', peerId: 's' }, { role: 'client-1', peerId: 'c1' }];
    const cursor = Buffer.from(JSON.stringify({ v: 1, peers: { s: 0, c1: 7 } })).toString('base64url');
    const { host } = logHost(peers, buffers, new Set(['c1']));
    const result = body(await getErrors(host, 'inst-fail', { since: cursor }));
    expect(result.peerErrors).toEqual([{ peer: 'client-1', error: 'peer timed out' }]);
    expect(result.groups).toHaveLength(1);
    expect(decode(result.cursor)).toEqual({ s: 4, c1: 7 });
  });

  test('a restarted buffer is read from the start and a gap between calls is reported as lost', async () => {
    const buffers: Buffers = {
      s: [{ seq: 1, ts: 1, level: 'ERR', message: 'after reload' }],
      c1: [{ seq: 15, ts: 2, level: 'ERR', message: 'after overflow' }],
    };
    const peers = [{ role: 'server', peerId: 's' }, { role: 'client-1', peerId: 'c1' }];
    const cursor = Buffer.from(JSON.stringify({ v: 1, peers: { s: 50, c1: 10 } })).toString('base64url');
    const { host, requests } = logHost(peers, buffers);
    const result = body(await getErrors(host, 'inst-reset', { since: cursor }));
    expect(requests.filter((request) => request.peerId === 's').map((request) => request.data)).toEqual([{ since: 50 }, {}]);
    expect(result.groups.map((group: { message: string }) => group.message)).toEqual(['after reload', 'after overflow']);
    expect(result.lost).toEqual({ 'client-1': 4 });
  });

  test('messages and frames gain Rojo file locations', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-diagnostics-map-'));
    fs.writeFileSync(path.join(root, 'sourcemap.json'), JSON.stringify({
      name: 'Game',
      className: 'DataModel',
      children: [{
        name: 'ServerScriptService',
        className: 'ServerScriptService',
        children: [{ name: 'Main', className: 'Script', filePaths: ['src/server/Main.server.luau'] }],
      }],
    }));
    const { host } = logHost([{ role: 'server', peerId: 's' }], { s: crash(1, 10) });
    const result = body(await getErrors(host, 'inst-map', {}, new SourcemapResolver(() => root)));
    expect(result.groups[0].message).toContain('ServerScriptService.Main:12 [src/server/Main.server.luau:12]');
    expect(result.groups[0].stack[0]).toContain('[src/server/Main.server.luau:12]');
  });

  test('the registered handler routes by instance_id', async () => {
    const { host, targets } = logHost([{ role: 'edit', peerId: 'e' }], { e: [] });
    const result = body(await diagnosticsFeature.handlers.get_errors({ forkHost: host } as never, { instance_id: 'studio-7' }));
    expect(targets).toEqual([['all', 'studio-7']]);
    expect(result.groups).toEqual([]);
  });
});

// Mirrors the plugin's edit-script-lines handler: plain find with a uniqueness check, or a compare at a line start.
function pluginScript(initial: string, options: { truncated?: boolean; foldCr?: boolean } = {}) {
  let source = initial;
  const edits: Array<{ oldString: string; newString: string; startLine?: number; instanceId?: string }> = [];
  const reads: Array<Record<string, unknown>> = [];
  const fail = (message: string) => text({ error: `Failed to edit script: ScriptHandlers:194: ${message}` });
  const tools = {
    editScriptLines: async (instancePath: string, oldString: string, newString: string, startLine?: number, instanceId?: string) => {
      edits.push({ oldString, newString, startLine, instanceId });
      let at: number;
      if (startLine !== undefined) {
        let lineStart = 0;
        for (let line = 1; line < startLine; line++) lineStart = source.indexOf('\n', lineStart) + 1;
        if (source.slice(lineStart, lineStart + oldString.length) !== oldString) {
          return fail(`old_string does not match at line ${startLine}. Use get_script_source to verify the exact text at that line.`);
        }
        at = lineStart;
      } else {
        at = source.indexOf(oldString);
        if (at < 0) return fail('old_string not found in script. If old_string contains repeated patterns (e.g. closing braces), pass startLine to anchor the edit.');
        if (source.indexOf(oldString, at + oldString.length) >= 0) {
          return fail('old_string matches multiple locations. Provide more surrounding context, or pass startLine to anchor the edit to a specific line.');
        }
      }
      source = source.slice(0, at) + newString + source.slice(at + oldString.length);
      return text({ success: true, instancePath, method: 'UpdateSourceAsync', message: 'Script edited successfully' });
    },
    forkHost: {
      peerTargets: async (target: string | undefined) => (target === undefined ? [{ role: 'edit', peerId: 'e' }] : []),
      requestPeer: async (endpoint: string, data: unknown) => {
        expect(endpoint).toBe('/api/get-script-source');
        const request = data as Record<string, unknown>;
        reads.push(request);
        const ranged = request.startLine !== undefined;
        const returned = ranged && options.foldCr ? source.replace(/\r\n/g, '\n') : source;
        return {
          source: options.truncated && !ranged ? returned.split('\n').slice(0, 2).join('\n') : returned,
          sourceLength: Buffer.byteLength(source, 'utf8'),
          truncated: options.truncated === true && !ranged,
        };
      },
    },
  };
  return { tools, edits, reads, current: () => source };
}

const handle = (tools: unknown, request: Record<string, unknown>) =>
  TOOL_HANDLERS.edit_script_lines(tools as never, { instancePath: 'game.ServerScriptService.Main', ...request });

describe('edit_script_lines whitespace retry', () => {
  test('a drifted old_string is replaced through the plugin, anchored at its line', async () => {
    const plugin = pluginScript('local function f()\n\tif ready then\n\t\treturn 1\n\tend\nend\n');
    const result = body(await handle(plugin.tools, {
      old_string: 'if ready then\n        return 1\n    end',
      new_string: 'if ready then\n\t\treturn 2\n\tend',
      instance_id: 'studio-1',
    }));
    expect(result).toMatchObject({ success: true, fuzzy: true, lines: '2-4' });
    expect(plugin.current()).toBe('local function f()\n\tif ready then\n\t\treturn 2\n\tend\nend\n');
    expect(plugin.edits[1]).toEqual({
      oldString: '\tif ready then\n\t\treturn 1\n\tend',
      newString: '\tif ready then\n\t\treturn 2\n\tend',
      startLine: 2,
      instanceId: 'studio-1',
    });
  });

  test('a match at the very start of the script anchors at line 1', async () => {
    const plugin = pluginScript('print(  1 )\nprint(2)\n');
    const result = body(await handle(plugin.tools, { old_string: 'print( 1 )', new_string: 'print(3)' }));
    expect(result).toMatchObject({ success: true, fuzzy: true, lines: '1' });
    expect(plugin.current()).toBe('print(3)\nprint(2)\n');
  });

  test('a line_range anchor chooses between whitespace-insensitive matches', async () => {
    const plugin = pluginScript('\tprint(1)\nx()\n    print(1)\n');
    const result = body(await handle(plugin.tools, { old_string: '\t\tprint(1)', new_string: '\tprint(2)', line_range: '3' }));
    expect(result).toMatchObject({ success: true, fuzzy: true, lines: '3' });
    expect(plugin.current()).toBe('\tprint(1)\nx()\n\tprint(2)\n');
  });

  test('an anchored retry finds a match that overlaps an earlier one', async () => {
    const plugin = pluginScript('\tend\n\tend\n\tend\n');
    const result = body(await handle(plugin.tools, { old_string: '  end\n  end', new_string: '\tdone\n\tdone', line_range: '2' }));
    expect(result).toMatchObject({ success: true, fuzzy: true, lines: '2-3' });
    expect(plugin.current()).toBe('\tend\n\tdone\n\tdone\n');
    expect(plugin.edits[1]).toMatchObject({ oldString: '\tend\n\tend', startLine: 2 });
  });

  test('a trailing space never lets the retry cut into a longer word', async () => {
    const plugin = pluginScript('local xy = 2\nprint(xy)\n');
    const result = body(await handle(plugin.tools, { old_string: 'local x ', new_string: 'local z ' }));
    expect(result.error).toMatch(/^Failed to edit script: old_string not found, even ignoring whitespace\./);
    expect(plugin.current()).toBe('local xy = 2\nprint(xy)\n');
  });

  test('no match quotes the closest lines and changes nothing', async () => {
    const plugin = pluginScript('local a = 1\nprint(a)\n');
    const result = body(await handle(plugin.tools, { old_string: 'print(b)', new_string: 'print(c)' }));
    expect(result.error).toMatch(/^Failed to edit script: old_string not found, even ignoring whitespace\. Closest text is line 2 \(\d+% similar\):\n2: print\(a\)$/);
    expect(plugin.current()).toBe('local a = 1\nprint(a)\n');
    expect(plugin.edits).toHaveLength(1);
  });

  test('other plugin errors pass through without reading the source', async () => {
    const plugin = pluginScript('end\nend\n');
    const result = body(await handle(plugin.tools, { old_string: 'end', new_string: 'finish' }));
    expect(result.error).toMatch(/matches multiple locations/);
    expect(plugin.reads).toEqual([]);
  });

  test('a long script is read in full with a ranged read before matching', async () => {
    const plugin = pluginScript('a()\nb()\nc()\n\td()\n', { truncated: true });
    const result = body(await handle(plugin.tools, { old_string: '  d()', new_string: '\te()' }));
    expect(plugin.reads).toEqual([{ instancePath: 'game.ServerScriptService.Main' }, { instancePath: 'game.ServerScriptService.Main', startLine: 1 }]);
    expect(result).toMatchObject({ success: true, fuzzy: true, lines: '4' });
    expect(plugin.current()).toBe('a()\nb()\nc()\n\te()\n');
  });

  test('a long CRLF script whose read lost its CRs keeps the plain miss instead of guessing', async () => {
    const plugin = pluginScript('a()\r\nb()\r\nc()\r\n', { truncated: true, foldCr: true });
    const result = body(await handle(plugin.tools, { old_string: 'b( )', new_string: 'x()' }));
    expect(result.error).toMatch(/old_string not found in script/);
    expect(plugin.edits).toHaveLength(1);
  });

  test('retry is a no-op for a successful edit', async () => {
    const plugin = pluginScript('a()\n');
    const first = text({ success: true });
    expect(await retryEditIgnoringWhitespace(plugin.tools as never, first, { path: 'x', oldString: 'a', newString: 'b' })).toBe(first);
    expect(plugin.reads).toEqual([]);
  });
});
