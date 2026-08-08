import { timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const DISCOGS_SEARCH_URL = 'https://api.discogs.com/database/search';
const USER_AGENT = 'dj-discovery-router/0.0.0 (+https://dj-router.pages.dev)';
const UPSTREAM_TIMEOUT_MS = 7_000;
const DEFAULT_PER_PAGE = 25;
const ALLOWED_QUERY_PARAMS = ['q', 'artist', 'label', 'release_title', 'type', 'per_page', 'page'];
const RATE_LIMIT_HEADERS = ['x-discogs-ratelimit', 'x-discogs-ratelimit-used', 'x-discogs-ratelimit-remaining'];

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function buildDiscogsUrl(requestUrl) {
  const incoming = new URL(requestUrl, 'http://discogs-proxy.invalid');
  const upstream = new URL(DISCOGS_SEARCH_URL);

  // Forward only search fields so clients cannot smuggle arbitrary upstream options.
  for (const name of ALLOWED_QUERY_PARAMS) {
    if (!incoming.searchParams.has(name)) continue;
    const value = incoming.searchParams.get(name);
    if (value === null) continue;

    if (name === 'per_page') {
      upstream.searchParams.set(name, String(Math.min(Math.max(positiveInteger(value, DEFAULT_PER_PAGE), 1), 100)));
    } else if (name === 'page') {
      upstream.searchParams.set(name, String(positiveInteger(value, 1)));
    } else {
      upstream.searchParams.set(name, value);
    }
  }

  return upstream;
}

function isAuthorized(request, expectedSecret) {
  if (!expectedSecret) return false;
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;

  const provided = Buffer.from(authorization.slice('Bearer '.length));
  const expected = Buffer.from(expectedSecret);
  // timingSafeEqual throws for different lengths, so guard before comparing.
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function handleSearch(request, response, config) {
  if (!isAuthorized(request, config.proxySecret)) {
    sendJson(response, 401, { error: 'Unauthorized' });
    return;
  }

  if (!config.discogsToken) {
    sendJson(response, 503, { error: 'Discogs proxy is not configured' });
    return;
  }

  try {
    const upstream = await config.fetchImpl(buildDiscogsUrl(request.url), {
      headers: {
        Authorization: `Discogs token=${config.discogsToken}`,
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const body = await upstream.text();
    const headers = {
      'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
    };

    for (const name of RATE_LIMIT_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) headers[name] = value;
    }

    response.writeHead(upstream.status, headers);
    response.end(body);
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError'
      ? 'Discogs upstream request timed out'
      : 'Discogs upstream request failed';
    console.error('discogs proxy upstream request failed', reason);
    sendJson(response, 504, { error: reason });
  }
}

async function handleRequest(request, response, config) {
  const requestUrl = new URL(request.url ?? '/', 'http://discogs-proxy.invalid');

  if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method !== 'GET' || requestUrl.pathname !== '/search') {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  await handleSearch(request, response, config);
}

/**
 * Create the Discogs proxy HTTP server without starting its listener.
 *
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {import('node:http').Server}
 */
export function createDiscogsProxyServer({ env = process.env, fetchImpl = fetch, timeoutMs = UPSTREAM_TIMEOUT_MS } = {}) {
  const config = {
    proxySecret: env.PROXY_SECRET ?? '',
    discogsToken: env.DISCOGS_TOKEN?.trim() ?? '',
    fetchImpl,
    timeoutMs,
  };

  return createHttpServer((request, response) => {
    handleRequest(request, response, config).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: 'Proxy request failed' });
      else response.destroy();
    });
  });
}

/**
 * Start the proxy on all interfaces using the configured PORT.
 *
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {import('node:http').Server}
 */
export function startServer(options = {}) {
  const env = options.env ?? process.env;
  const parsedPort = Number.parseInt(env.PORT ?? '8080', 10);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 8080;
  const server = createDiscogsProxyServer(options);
  server.listen(port, '0.0.0.0', () => {
    console.log(`discogs proxy listening on ${port}`);
  });
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  startServer();
}
