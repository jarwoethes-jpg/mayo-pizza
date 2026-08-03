# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately to **abuse@mayo.pizza**, or open a
[private security advisory](https://github.com/jarwoethes-jpg/mayo-pizza/security/advisories/new)
on this repository. Please do not open a public issue for an unfixed vulnerability.

Include what you need to reproduce it: affected version or commit, the browsers involved, and
whether the transfer used a direct peer connection or the TURN relay. A proof of concept helps
more than a description.

There is no bug bounty. This is a personal project run by one maintainer, so expect a first
response within a week rather than within a day.

## Scope

In scope:

- The signaling service in `packages/server` — room lifecycle, capability URLs, rate limiting,
  password-protected rooms.
- The browser application in `packages/web` — the transfer protocol, integrity checks, and the
  download sinks.
- The deployment configuration in `infra/` — Caddy security headers, the CSP, and the coturn
  relay policy.
- The live deployment at https://mayo.pizza.

Out of scope:

- Denial of service and volumetric load testing against the live host.
- Findings that require a compromised endpoint, a malicious browser extension, or physical
  access to a peer's device.
- Anyone who legitimately holds a room URL reading that room. The URL **is** the capability;
  that is the documented design, not a flaw.
- Missing hardening with no demonstrated impact, straight from an automated scanner.

## Supported versions

Only the current `master` branch and the running deployment are supported. There are no
maintained release branches or backports.
