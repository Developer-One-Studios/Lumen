import { lookup } from 'node:dns/promises';
import { open } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import { resolve } from 'node:path';
import { HTTP_BODY_LIMIT_BYTES } from './http-body-limits.js';
import { MAX_STUDIO_FRAME_BYTES } from './studio-transport.js';

// Use the smaller proxy/Studio limit so the same import works in either mode.
// Reserve space for routing IDs and the bridge's request envelope. The bridge
// still performs its exact serialized-frame admission check before dispatch.
const ENVELOPE_RESERVE_BYTES = 16 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

export type HostResolver = (hostname: string) => Promise<string[]>;

const defaultResolver: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

// Loopback, LAN and link-local hosts are refused so a tool argument cannot reach services that only trust this machine.
const LOCAL_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) LOCAL_ADDRESSES.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) LOCAL_ADDRESSES.addSubnet(network, prefix, 'ipv6');

function isLocalAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return LOCAL_ADDRESSES.check(mapped[1], 'ipv4');
  return LOCAL_ADDRESSES.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

async function assertPublicUrl(url: URL, resolveHost: HostResolver): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`import_rbxm url must use http(s); got ${url.protocol}`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname);
  if (addresses.length === 0 || addresses.some(isLocalAddress)) {
    throw new Error(`import_rbxm refuses ${url.host}: it resolves to a loopback, private or link-local address.`);
  }
}

export function rbxmInputByteLimit(parentPath: string, sourceLabel: string): number {
  const metadataBytes = Buffer.byteLength(JSON.stringify({
    base64: '', parent_path: parentPath, source_label: sourceLabel,
  }));
  const encodedBytes = Math.min(HTTP_BODY_LIMIT_BYTES, MAX_STUDIO_FRAME_BYTES)
    - ENVELOPE_RESERVE_BYTES - metadataBytes;
  if (encodedBytes < 4) throw new Error('RBXM import metadata exceeds the transport byte budget.');
  return Math.floor(encodedBytes / 4) * 3;
}

function tooLarge(limit: number): Error {
  return new Error(`RBXM input exceeds the ${limit}-byte limit after allowing for base64 and transport overhead.`);
}

export async function readBoundedResponse(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw tooLarge(limit);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw tooLarge(limit);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    // Cancel on errors as well as success, including a lying Content-Length.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readRbxmInput(
  source: { path?: string; url?: string; base64?: string },
  parentPath: string,
  signal?: AbortSignal,
  resolveHost: HostResolver = defaultResolver,
): Promise<{ bytes: Buffer; sourceLabel: string }> {
  const modes = ['path', 'url', 'base64'] as const;
  const provided = modes.filter((key) => source[key] !== undefined);
  if (provided.length !== 1 || typeof source[provided[0]] !== 'string') {
    throw new Error('source must contain exactly one string: path, url, or base64');
  }
  signal?.throwIfAborted();
  if (source.path !== undefined) {
    // Relative paths read from the artifact folder when one is set, where export_rbxm writes the same name.
    const root = process.env.ROBLOX_MCP_ARTIFACT_DIR?.trim();
    const sourceLabel = root ? resolve(root, source.path) : resolve(source.path);
    const limit = rbxmInputByteLimit(parentPath, sourceLabel);
    const file = await open(sourceLabel, 'r');
    try {
      const stats = await file.stat();
      if (!stats.isFile()) throw new Error('RBXM source must be a regular file.');
      if (stats.size > limit) throw tooLarge(limit);
      const chunks: Buffer[] = [];
      let size = 0;
      // Read through the opened descriptor; a growing file cannot escape the cap.
      for (;;) {
        signal?.throwIfAborted();
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - size + 1));
        const { bytesRead } = await file.read(chunk);
        if (bytesRead === 0) break;
        size += bytesRead;
        if (size > limit) throw tooLarge(limit);
        chunks.push(chunk.subarray(0, bytesRead));
      }
      return { bytes: Buffer.concat(chunks, size), sourceLabel };
    } finally {
      await file.close();
    }
  }
  if (source.url !== undefined) {
    let url = new URL(source.url);
    const limit = rbxmInputByteLimit(parentPath, source.url);
    const deadline = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    const fetchSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    // Redirects are followed by hand so every hop gets the same host check.
    let response: Response;
    for (let hop = 0; ; hop++) {
      await assertPublicUrl(url, resolveHost);
      response = await fetch(url, { signal: fetchSignal, redirect: 'manual' });
      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || !location) break;
      await response.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new Error('RBXM download exceeded the redirect limit.');
      url = new URL(location, url);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`RBXM download returned HTTP ${response.status}`);
    }
    return { bytes: await readBoundedResponse(response, limit), sourceLabel: source.url };
  }
  const limit = rbxmInputByteLimit(parentPath, 'base64(9999999999B)');
  const maxEncoded = 4 * Math.ceil(limit / 3);
  // Check encoded length before validation or allocation. Wrapped encoder
  // output (`base64` wraps at 76 columns, PEM at 64) adds at most one CRLF per
  // 64 characters; strip that whitespace, then apply the exact bound. Padding
  // is optional, but reject malformed input that Buffer.from would truncate.
  if (source.base64!.length > maxEncoded + 2 * Math.ceil(maxEncoded / 64)) throw tooLarge(limit);
  const encoded = source.base64!.replace(/[\t\n\r ]+/g, '');
  if (encoded.length > maxEncoded) throw tooLarge(limit);
  if (encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    || (encoded.includes('=') && encoded.length % 4 !== 0)) {
    throw new Error('RBXM base64 must be valid base64.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > limit) throw tooLarge(limit);
  if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new Error('RBXM base64 is not canonical.');
  }
  return { bytes, sourceLabel: `base64(${bytes.length}B)` };
}
