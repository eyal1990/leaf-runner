import { lookup as dnsLookup } from 'node:dns/promises';
import { get as httpsGet } from 'node:https';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3]]) blocked.addSubnet(address, prefix, 'ipv4');

export function publicAddress(address) {
  if (isIP(address) === 4) return !blocked.check(address, 'ipv4');
  if (isIP(address) !== 6) return false;
  const canonical = new URL(`https://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  const first = parseInt(canonical.split(':')[0], 16);
  return (first & 0xe000) === 0x2000 && !canonical.startsWith('2001:db8:') &&
    !canonical.startsWith('2002:') && !canonical.startsWith('2001:0:') && !canonical.startsWith('2001::');
}

// Resolve once and pin that public address for TLS; redirects are checked afresh.
// No credentials, cookies, API headers, scripts, or archive extraction are used.
export async function downloadResearchResource(value, { signal, maxBytes = 4 * 1024 * 1024,
  lookup = dnsLookup, get = httpsGet } = {}) {
  const timeout = AbortSignal.timeout(30000);
  signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let url = new URL(value);
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') {
      throw new Error('Research resources require public HTTPS URLs without credentials');
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let addresses, aborted;
    try {
      addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
        : await Promise.race([lookup(hostname, { all: true }), new Promise((_resolve, reject) => {
          aborted = () => reject(signal.reason);
          signal.addEventListener('abort', aborted, { once: true });
        })]);
    } finally { if (aborted) signal.removeEventListener('abort', aborted); }
    signal.throwIfAborted();
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('Research resource resolves to a non-public address');
    const pinned = addresses[0];
    const response = await new Promise((resolve, reject) => {
      const request = get(url, { signal, headers: { 'User-Agent': 'Prove2Me-mission-research' },
        lookup: (_hostname, options, callback) => options?.all
          ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family) }, resolve);
      request.on('error', reject);
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      response.destroy();
      if (!response.headers.location || redirects === 3) throw new Error('Research resource redirect limit exceeded');
      url = new URL(response.headers.location, url); continue;
    }
    if (response.statusCode !== 200) { response.destroy(); throw new Error(`Research resource HTTP ${response.statusCode}`); }
    const chunks = []; let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > maxBytes) { response.destroy(); throw new Error('Research resource exceeds size limit'); }
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks), url: url.href, content_type: response.headers['content-type'] ?? '' };
  }
}
