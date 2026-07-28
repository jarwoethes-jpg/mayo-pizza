# mayo.pizza

mayo.pizza is a capability-URL transfer tool: the browser creates a short-lived room, peers negotiate through a small Fastify + `ws` signaling service, and the file travels over an encrypted WebRTC data channel. The service keeps room state in memory and does not need Redis; a process restart therefore drops active rooms.

## Architecture

The browser pair uses Fastify + `ws` only for signaling, then sends data over a WebRTC data channel. coturn is the relay fallback when a direct path cannot be established. Receivers choose File System Access, service-worker streaming, or a bounded in-memory Blob sink. The `/privacy` and `/terms` views are part of the web application; this operations guide does not recreate them.

Caddy 2's `reverse_proxy` transparently forwards the WebSocket upgrade for `/ws`; no legacy `websocket` directive is used.

## Local development

The repo's local checks are:

```bash
pnpm install
pnpm check
pnpm test
pnpm --filter web build
pnpm --filter server build
```

Vite copies `packages/web/public` into `dist`; the existing build output contains `download.sw.js` and `fonts/`. After changing public files, verify the new robots copy on a host that can run the build:

```bash
pnpm --filter web build && test -f packages/web/dist/robots.txt
```

The Playwright configuration starts the server on port 3100 and `vite preview` on port 5173. Between runs, release both ports:

```bash
fuser -k 3100/tcp 5173/tcp
pnpm e2e
```

The e2e config supplies the local TURN secret and signaling host. To run its forced-relay mode, use the same environment style in any shell:

```bash
env MAYO_FORCE_RELAY=1 pnpm e2e
```

For a fish shell, use `env VAR=value command` rather than Bash-style assignment syntax. The direct commands used by the Playwright configuration are:

```bash
pnpm --filter shared build && pnpm --filter server build
env PORT=3100 HOST=127.0.0.1 TURN_STATIC_SECRET=playwright-turn-secret STUN_HOST=127.0.0.1 TURN_HOST=127.0.0.1 pnpm --filter server start
pnpm --filter web build
pnpm --filter web preview --host 127.0.0.1 --port 5173 --strictPort
```

Run the e2e suite on a host with TCP bind permission and installed browser binaries. The restricted executor used for this change cannot run that browser/network gate.

Regenerate the Caddy header snippet after changing `infra/headers.json`:

```bash
pnpm generate:headers
```

## Environment variables

The defaults below are the effective compose defaults unless marked as a standalone-server default.

| Variable | Default | Required | If wrong |
| --- | --- | --- | --- |
| `HOST` | `0.0.0.0` | No | The server may bind only to an inaccessible interface. |
| `PORT` | `3000` in compose; `3000` in server | No | Caddy, health checks, or local clients can reach the wrong port. |
| `NODE_ENV` | `production` in compose/Dockerfile | No | The server's environment-dependent logging default changes. |
| `WEB_ROOT` | `/app/web-dist` in compose; server dist path standalone | No | Static assets and the web shell are not served. |
| `PUBLIC_HOSTNAME` | `mayo.pizza` | No | TURN defaults can advertise the wrong hostname. |
| `STUN_HOST` | `mayo.pizza` | No | ICE discovery can target the wrong STUN host. |
| `TURN_HOST` | `mayo.pizza` | No | Relay candidates can target the wrong TURN host. |
| `STUN_PORT` | `3478` | No | ICE discovery can target the wrong port. |
| `TURN_PORT` | `3478` | No | UDP TURN relay fallback can fail. |
| `TURNS_PORT` | `5349` | No | TLS/TCP TURN fallback can fail. |
| `TRUSTED_PROXIES` | `172.30.0.2` in compose; `127.0.0.1,::1` standalone | No | A wrong value either collapses all clients to Caddy's IP for rate limiting or permits spoofed forwarded addresses. |
| `TURN_STATIC_SECRET` | None | Yes in compose | App-minted TURN credentials and coturn will not agree; compose refuses to interpolate without it. |
| `RATE_LIMIT_CREATE` | `10` per hour/IP | No | Invalid values fall back to 10; a valid value that is too low throttles room creation, while a high value weakens abuse protection. |
| `RATE_LIMIT_JOIN` | `60` per hour/IP | No | Invalid values fall back to 60; a valid value that is too low throttles joins. |
| `RATE_LIMIT_MESSAGE` | `100` per minute/IP | No | Invalid values fall back to 100; a valid value that is too low throttles signaling. |
| `ROOM_TTL_MS` | `1800000` (30 minutes) | No | Invalid values fall back to 30 minutes; a value that is too short reaps idle rooms sooner, while a long value retains more in-memory state. |
| `LOG_LEVEL` | `info` in compose; `silent` under tests and `info` otherwise | No | Logs become too noisy or too quiet; use a Fastify-supported level. |
| `METRICS_TOKEN` | None | Yes in compose | Compose refuses to start without it; a wrong bearer token receives 404 from `/metrics`. |
| `VITEST` | unset | Test-only | Setting `VITEST=true` makes the server use its silent test logging default. |

`TURN_STATIC_SECRET` is also passed to the coturn container. The `VITEST` row is included because the server reads it for its test logging branch; it is not a deployment setting.

## Deploy via a Portainer stack

Before first boot:

- Create DNS A and/or AAAA records for `mayo.pizza` pointing to the host.
- If Cloudflare fronts the name, use DNS-only / the grey cloud. Caddy's ACME HTTP challenge must reach the host directly, and WebRTC/TURN traffic must not be sent through Cloudflare's HTTP proxy.
- Make ports 80 and 443 reachable by Caddy, and expose the TURN listener and relay range required by `infra/docker-compose.yml` (3478, 5349, and UDP 49160–49200).
- Set `TURN_STATIC_SECRET` and `METRICS_TOKEN` as Portainer stack environment values. Keep both out of git. Change the hostname/ICE values only when the DNS and firewall plan also changes.

Validate interpolation before deploying:

```bash
env TURN_STATIC_SECRET=replace-me METRICS_TOKEN=replace-me docker compose -f infra/docker-compose.yml config
```

Then build and start the stack through Portainer, or from the host with the compose file:

```bash
docker compose -f infra/docker-compose.yml up -d --build
```

Confirm first boot with the app health check and Caddy logs. Caddy's `caddy_data` volume stores its ACME state and certificates; inspect the volume in Portainer or with the host's Docker volume tooling.

The compose network fixes Caddy at `172.30.0.2` and defaults `TRUSTED_PROXIES` to that address because the server's parser accepts exact proxy addresses, not CIDR notation. If the address or subnet is changed, update both values. Verify the live address with:

```bash
docker compose -f infra/docker-compose.yml ps
docker inspect "$(docker compose -f infra/docker-compose.yml ps -q caddy)"
```

## Certificate renewal

Caddy renews certificates automatically. Renewal fails when the ACME challenge is blocked by a proxy, port 80 is closed, DNS points elsewhere, or the CA rate limit is reached. Inspect the failure and retry context with:

```bash
docker compose -f infra/docker-compose.yml logs caddy
```

Do not delete `caddy_data` while diagnosing: it contains the certificate state. If Cloudflare was changed from DNS-only, restore DNS-only before retrying the challenge.

## coturn credential rotation

1. Generate a new `TURN_STATIC_SECRET` and update the Portainer stack environment.
2. Recreate the app and coturn services together, or restart app first and coturn immediately after so newly minted credentials and coturn converge quickly.
3. Confirm app health and a new relay-capable connection.

Rotation invalidates the old shared secret. In-flight relayed sessions break and must reconnect; this is expected.

## Logs, retention, and privacy

The app writes structured JSON logs to stdout. Docker's `json-file` driver keeps seven 10 MiB files for the app container, a size-based cap of about 70 MiB rather than a guaranteed seven calendar days. Tune the size/file count after observing the host's log rate if a seven-day policy is mandatory. Caddy and coturn logs are available through `docker compose logs caddy` and `docker compose logs coturn`; their host-side retention is not configured by this stack.

The privacy guarantee is that app logs do not contain room slugs, uploader tokens, or filenames. Phase 8a enforces the slug/filename rule with a test. Rooms and transfer state remain in memory only.

## Metrics and uptime

Use `/healthz` for uptime checks. The edge returns 404 for `/metrics`, so a public Caddy request cannot expose metrics. An internal scraper on the Docker network may request `http://app:3000/metrics` with `Authorization: Bearer $METRICS_TOKEN`; keep the bearer token secret. If remote scraping is required, remove the edge block only after retaining bearer authentication and adding an explicit network access policy.

For coturn bandwidth alerting, check the actual image before configuring a scraper:

```bash
docker compose -f infra/docker-compose.yml exec coturn turnserver -h | grep -i prometheus
```

If that prints a supported Prometheus option or endpoint, follow that image's help output to enable it and scrape the resulting endpoint. If it prints nothing, use host/network accounting instead: coturn uses `network_mode: host`, so inspect the host firewall's byte counters for TCP/UDP 3478, TCP/UDP 5349, and UDP relay ports 49160–49200, then poll the counters and alert on the measured byte-rate/cost budget. Verify the available accounting stack first:

```bash
sudo nft --version
sudo nft -j list ruleset
sudo iptables -L -v -n -x
```

Use the active firewall stack's existing TURN allow chain and persist counter-only rules; do not add an unreviewed broad `ACCEPT` rule. The exact firewall rule/persistence command is host-specific and must be verified on the host.

The checked-in `turnserver.conf` uses `total-quota=100` and `bps-capacity=10485760` (10 MiB/s). These option names were verified against coturn 4.6.1 on the development host; verify the pinned `coturn/coturn:4.6.2` image with `turnserver -h` before deployment.

## Rollback

Keep an immutable, previously known-good Mayo image tag. To roll back, set the stack's `image` from `mayo-pizza:latest` to that previous tag, then pull and recreate:

```bash
docker compose -f infra/docker-compose.yml pull app
docker compose -f infra/docker-compose.yml up -d app
```

Rooms are in memory, so any app restart drops all active transfers. That is the deliberate operational tradeoff of running without Redis.

## Load test

The Phase 8a harness defaults to 50 rooms and 100 WebSockets, samples `/metrics`, and writes `/tmp/mayo-loadtest.jsonl`. Start a local server on port 3100 with a metrics token if one is configured, then run:

```bash
env URL=ws://127.0.0.1:3100/ws SERVER_PID=<server-pid> METRICS_TOKEN=<matching-token> node packages/server/scripts/loadtest.mjs
```

For the room-reaper gate, also set a short positive `ROOM_TTL_MS` in the server and harness environment. The harness passes when it reports no fatal/error condition, all rooms are reaped when the reaper check is enabled, and final RSS is no more than 1.5 times the warm-up RSS. Review the JSON summary and `/tmp/mayo-loadtest.jsonl`; do not treat a run with a metrics error as a pass.
