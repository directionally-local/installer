# Portable services: the name service and the approvals page

Status: design. Nothing in this document is built yet, except the `site/`
portability check described in [§8](#8-the-site-worker-today).

Part of [directionally-local/installer#29](https://github.com/directionally-local/installer/issues/29).

## 1. Summary

Directionally Local still needs two services:

- a **name service** that assigns `<name>.directionallylocal.run` and answers
  DNS-01 challenges for each server's certificates (Phase 1);
- an **approvals page** for approving GitHub App tasks and laptop pairings from
  a browser (Phase 2).

Both are written as ordinary Cloudflare Workers apps. The same source deploys
to Cloudflare with `wrangler deploy` and to a self-hosted
[Serverless Objects](https://github.com/directionally-local/serverless-objects)
node with `sobjects deploy`, with no code changes. Cloudflare's APIs are the
contract; our implementations are the product.

The design deliberately uses a small, well-tested subset of the Workers
platform: `fetch`, Web Crypto, Durable Objects with SQLite storage, alarms,
RPC, and WebSockets. It avoids bindings and APIs that the Serverless Objects
native engine refuses or that the conformance suite does not exercise. That
subset is what makes "no code changes" true rather than aspirational.

## 2. The portability contract

### 2.1 Targets

Every service must run on all three targets:

| Target | How it runs | What it is for |
| --- | --- | --- |
| Cloudflare | `wrangler deploy` | The hosted service |
| Serverless Objects (celld) | `sobjects deploy` + `sobjects up` | Self-hosted, single node, state in an S3-compatible bucket |
| Serverless Objects (native engine) | `sobjects dev --engine native` | Local development and the `sobjects build --strict` portability gate |

The native engine is not a deployment target for these services. It is the
strictest checker: it refuses KV, D1, R2, Queues, Workflows, service bindings,
and assets. If a service passes `sobjects build --strict`, it is not
native-only.

### 2.2 Allowed and forbidden APIs

Allowed everywhere:

- `fetch` handlers and `Request`/`Response`/`URL`/`Headers`.
- Web Crypto (`crypto.subtle`, `crypto.getRandomValues`, `crypto.randomUUID`).
- Durable Objects: `DurableObject`, `WorkerEntrypoint`, `RpcTarget`,
  `ctx.storage` (KV and SQLite), `ctx.storage.sql`, `transactionSync`,
  `blockConcurrencyWhile`, `setAlarm`/`getAlarm`/`deleteAlarm`.
- Durable Object RPC and `getByName`.
- WebSockets, including the hibernation API.
- `cloudflare:workers` imports (`DurableObject`, `WorkerEntrypoint`, `env`).
- `ReadableStream` for server-sent events.
- `vars` bindings and secrets exposed as `env` values.

Forbidden, because they are Cloudflare-only, native-only, or not covered by
the conformance suite:

- Node.js built-ins (`node:*`), `Buffer`, `process`, `require`, `__dirname`.
  `sobjects build --strict` catches these.
- `HTMLRewriter`, the Cache API, `cloudflare:sockets`, `cloudflare:email`,
  `waitUntil` on the request context (use DO alarms instead), Cron Triggers
  (use alarms), and `ctx.container`.
- KV, D1, R2, Queues, Workflows, service bindings, and static assets as
  primary storage or coordination. celld lists some of these upstream, but the
  conformance suite does not exercise them and the native engine refuses them.
- `process.env`. Read configuration from `env` only.
- Non-JavaScript imports (`.sh`, `.txt`, `.wasm`) in the Worker module graph.
  celld supports Wrangler `rules`, but `sobjects build` bundles with esbuild
  without applying them, so such an import fails the portability gate. Generate
  a TypeScript module instead (see [§8](#8-the-site-worker-today)).

### 2.3 Configuration layout

Each service has two Wrangler configs and one Serverless Objects config:

```
services/<service>/
  wrangler.jsonc             # portable: name, main, compatibility_date,
                             # durable_objects, migrations, vars, rules
  wrangler.cloudflare.jsonc  # Cloudflare-only: routes, workers_dev,
                             # observability, upload_source_maps
  sobjects.example.toml      # [celld] bucket, [ingress], [[ingress.routes]]
```

`wrangler.jsonc` is the config that `sobjects deploy`, `sobjects dev`, and
`sobjects build` read. celld accepts only a known set of top-level keys and
rejects `routes`, `workers_dev`, `observability`, and `upload_source_maps`, so
those live in `wrangler.cloudflare.jsonc`. Wrangler does not support config
inheritance, so the shared keys are duplicated and a test asserts that the two
files agree on `name`, `main`, and `compatibility_date`.

`wrangler.toml` is not read by celld. Do not add one for a new service.

### 2.4 Secrets

The Worker always reads secrets from `env`:

```ts
const token = env.CF_DNS_API_TOKEN;
```

- **Cloudflare:** `wrangler secret put CF_DNS_API_TOKEN -c services/name/wrangler.cloudflare.jsonc`.
- **Serverless Objects:** celld has no secret bindings. The deploy wrapper
  generates a git-ignored `wrangler.local.jsonc` from an environment file
  (mode `0600`) and passes it to `sobjects deploy`; the file is never
  committed. The service unit uses `EnvironmentFile=` for the same values.
  `sobjects.toml` never contains credentials.

A test asserts that no secret name appears in a committed config file.

### 2.5 Compatibility date and migrations

Use `compatibility_date = "2026-10-01"` for new services. It is later than
`2026-02-24`, when `deleteAll()` began clearing a pending alarm, and later than
`2026-08-04`, when `nodejs_compat` became the default. The services do not need
`nodejs_compat`; leaving it off keeps the bundle honest.

celld 0.6 supports only `tag` and `new_sqlite_classes` migrations. Class
renames, deletions, and transfers are rejected. Therefore:

- every Durable Object class is SQLite-backed and listed in `new_sqlite_classes`;
- class names are treated as permanent once deployed;
- new classes are added in a new migration tag, never by renaming an old one.

### 2.6 The portability gate

CI runs, for each service:

```sh
sobjects build --strict services/name
sobjects build --strict services/approvals
```

`--strict` exits non-zero when the app imports a Node.js built-in that does not
work on Cloudflare, or a package with a compiled native addon. Because that
check only looks at Node.js built-ins, CI also runs a small static lint
(`scripts/check-portable-apis.mjs`) for the forbidden APIs in
[§2.2](#22-allowed-and-forbidden-apis): `node:`, `process.`, `Buffer`,
`HTMLRewriter`, `cloudflare:sockets`, `caches.`, and direct `D1Database` /
`KVNamespace` / `R2Bucket` type references.

## 3. Repository layout

The installer repository grows a `services/` tree. It is a separate npm
workspace so the CLI's dependencies stay small.

```
services/
  package.json                 # workspaces: shared, name, approvals
  shared/
    src/problem.ts             # RFC 9457 problem+json
    src/auth.ts                # Ed25519 verify, HMAC, canonical requests
    src/html.ts                # escaping and page shell
    src/rate-limit.ts          # token bucket helpers
    src/dns.ts                 # DnsProvider interface and adapters
    src/acme.ts                # DNS-01 record naming and key authorization
    src/config.ts              # env parsing and validation
    test/
  name/
    wrangler.jsonc
    wrangler.cloudflare.jsonc
    sobjects.example.toml
    src/index.ts               # fetch router
    src/name-object.ts         # NameObject
    src/challenge-object.ts    # ChallengeObject
    src/zone-object.ts         # ZoneObject
    src/index-object.ts        # IndexObject (sharded)
    src/rate-limit-object.ts   # RateLimiterObject
    src/audit-object.ts        # AuditObject
    test/
    conformance/               # /cases and /case/<name> surface
  approvals/
    ... same shape ...
```

`services/shared` has no runtime dependencies. Tests use `node:test` through
`tsx`, matching the rest of the repository.

## 4. Name service

### 4.1 Responsibilities

- Assign and lease `<name>.directionallylocal.run`.
- Keep the DNS record for each name pointed at the owner's server.
- Publish and remove `_acme-challenge` TXT records so a server can complete
  ACME DNS-01 and obtain its own certificate.
- Enforce uniqueness, reserved names, rate limits, and lease expiry.
- Never hold a server's TLS private key or ACME account key.

Non-goals for Phase 1: being an authoritative DNS server, issuing certificates
itself, wildcard certificates for arbitrary sub-subdomains, and transferring a
name between owners.

### 4.2 Domain model

| Entity | Key | Meaning |
| --- | --- | --- |
| Name | the label (`alice`) | A lease on `alice.directionallylocal.run` |
| Lease | name | Owner public key, DNS target, expiry, status |
| Challenge | `sha256(name + token)` | A DNS-01 TXT record with a short TTL |
| Zone | zone name (`directionallylocal.run`) | DNS provider selection and record reconciliation |
| Server key | base64url Ed25519 public key | The identity that may renew or release a name |

Name rules: 3–63 characters, lowercase ASCII letters, digits, and internal
hyphens; no leading or trailing hyphen; no `--` in positions 3–4 (punycode);
not in the reserved list (`www`, `api`, `names`, `approvals`, `admin`, `mail`,
`ns1`, `ns2`, `_acme-challenge`, and the marketing site's labels).

### 4.3 HTTP API

Base URL: `https://names.directionallylocal.run/v1` hosted, or
`https://names.<domain>/v1` self-hosted.

All mutating endpoints require a signed request from the server key. The
signature is Ed25519 over:

```
METHOD \n PATH \n QUERY \n TIMESTAMP \n NONCE \n SHA256(body)
```

sent as:

```
Authorization: DL-Sig keyId=<base64url>, ts=<unix>, nonce=<base64url>, sig=<base64url>
```

The server registers its public key on the first claim. A key rotation endpoint
is signed by the old key. Nonces are stored for ten minutes; a replay returns
`409`. Admin endpoints use `Authorization: Bearer <ADMIN_TOKEN>`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness and version |
| `POST` | `/names` | Claim `{name, publicKey, dnsTarget}` |
| `GET` | `/names/:name` | Lease status |
| `POST` | `/names/:name/renew` | Extend the lease |
| `DELETE` | `/names/:name` | Release the name |
| `POST` | `/names/:name/dns01` | Publish `{token, keyAuthorization}` |
| `DELETE` | `/names/:name/dns01/:token` | Remove the TXT record |
| `POST` | `/acme/present` | ACME hook alias for `dns01` |
| `POST` | `/acme/cleanup` | ACME hook alias for cleanup |
| `GET` | `/admin/names?cursor=&limit=` | List names (bearer) |
| `POST` | `/admin/names/:name/revoke` | Revoke a name (bearer) |
| `GET` | `/admin/audit?day=` | Read the audit log (bearer) |

Claim response:

```json
{
  "name": "alice",
  "fqdn": "alice.directionallylocal.run",
  "status": "active",
  "dnsTarget": "alice.example.ts.net",
  "leaseExpiresAt": "2026-11-28T00:00:00.000Z"
}
```

Errors use `application/problem+json`:

```json
{ "type": "https://directionallylocal.run/problems/name-taken",
  "title": "Name taken", "status": 409,
  "detail": "alice is leased until 2026-11-28." }
```

Idempotency: `Idempotency-Key` is accepted on `POST /names` and
`POST /names/:name/dns01`; the response is stored for 24 hours.

Rate limits: 5 claims per hour per key and per IP, 20 challenges per hour per
name, 60 reads per minute per key. Exceeding a limit returns `429` with
`Retry-After`.

### 4.4 Durable Objects

| Class | Key | Responsibility |
| --- | --- | --- |
| `NameObject` | `idFromName(name)` | Authoritative uniqueness, lease state machine, DNS target, audit entries for this name |
| `ChallengeObject` | `idFromName(challengeId)` | One DNS-01 TXT record, its TTL, and cleanup |
| `ZoneObject` | `idFromName(zone)` | DNS provider adapter, desired record set, reconciliation alarm |
| `IndexObject` | `idFromName("index-" + shard)` | Admin listing and metrics, 16 shards by `hash(name) % 16` |
| `RateLimiterObject` | `idFromName(bucketKey)` | Token bucket and nonce replay cache |
| `AuditObject` | `idFromName("audit-" + day)` | Append-only daily audit log |

Why Durable Objects and nothing else:

- Uniqueness needs a single serialization point per name. `idFromName(name)`
  gives exactly that on Cloudflare and on celld/native.
- Expiry needs durable timers. Alarms are tested on both targets, including
  delivery after a celld restart.
- Queries need SQL. DO SQLite is tested on both targets; D1 is not covered by
  the conformance suite and is refused by the native engine.
- The index is sharded so no single object becomes a global write bottleneck.
  `NameObject` updates its shard with an RPC call; if that call fails, an alarm
  retries. The index is a cache for admin listing, never the source of truth.

`NameObject` uses `blockConcurrencyWhile` on first initialization to check the
reserved list and to create its tables. All state transitions happen inside
`transactionSync`.

### 4.5 Storage

`NameObject`:

```sql
CREATE TABLE IF NOT EXISTS lease (
  name             TEXT PRIMARY KEY,
  owner_key        TEXT NOT NULL,
  status           TEXT NOT NULL,          -- active | grace | released | revoked
  dns_target       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  grace_expires_at INTEGER,
  quarantine_until INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  detail     TEXT NOT NULL
);
```

`ChallengeObject`:

```sql
CREATE TABLE IF NOT EXISTS challenge (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  token             TEXT NOT NULL,
  key_authorization TEXT NOT NULL,
  record_name       TEXT NOT NULL,
  status            TEXT NOT NULL,          -- pending | published | removed
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL
);
```

`IndexObject`:

```sql
CREATE TABLE IF NOT EXISTS entries (
  name       TEXT PRIMARY KEY,
  status     TEXT NOT NULL,
  owner_key  TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`RateLimiterObject`:

```sql
CREATE TABLE IF NOT EXISTS buckets (
  key        TEXT PRIMARY KEY,
  tokens     REAL NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nonces (
  nonce      TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
```

`AuditObject`:

```sql
CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  subject    TEXT NOT NULL,
  detail     TEXT NOT NULL
);
```

### 4.6 Lifecycle

```
claim ──► active ──(lease expires)──► grace ──(7 days)──► released ──(30 days)──► deleted
             │                            │
             └──(renew)───────────────────┘
             └──(release / revoke)──────────────────────► released / revoked
```

- **active:** lease is valid; DNS record present; renew allowed after 7 days.
- **grace:** lease expired; DNS record still present; renew allowed; the API
  returns `402` with a renewal link.
- **released:** DNS record removed; the name is quarantined for 30 days so a
  stale server cannot reclaim it by racing the old owner.
- **revoked:** admin action; DNS removed immediately; 90-day quarantine.

Alarms:

- `NameObject` at `lease_expires_at` → `grace`; at `grace_expires_at` →
  `released` and ask `ZoneObject` to remove the record; at `quarantine_until`
  → `deleteAll()`.
- `ChallengeObject` at `expires_at` → remove the TXT record and delete itself.
- `ZoneObject` every 5 minutes → list provider records, compare with the
  desired set, and repair drift.
- `RateLimiterObject` at the bucket reset time.

### 4.7 DNS-01 and certificates

The name service publishes TXT records; the server owns its ACME account key
and TLS private key.

1. `dl up` generates or loads an Ed25519 server key and an ACME account key.
2. The server claims a name (`POST /names`).
3. The server starts an ACME order for `<name>.directionallylocal.run` (and,
   later, `*.<name>.directionallylocal.run`).
4. The ACME server returns a DNS-01 token.
5. The server computes
   `keyAuthorization = token + "." + base64url(SHA256(accountKeyThumbprint))`.
6. The server calls `POST /names/:name/dns01` with the token and
   keyAuthorization.
7. `NameObject` creates a `ChallengeObject`, which asks `ZoneObject` to publish
   `TXT _acme-challenge.<name> = keyAuthorization` with a 10-minute TTL.
8. `ZoneObject` polls DNS-over-HTTPS (Cloudflare `1.1.1.1` or Google `8.8.8.8`)
   until the record is visible at the zone's authoritative nameservers, up to
   60 seconds. DoH is a plain `fetch`, so it works on every target.
9. The server tells the ACME server the challenge is ready. The CA validates.
10. The server finalizes the order, downloads the certificate, and stores it
    locally (for example under `/etc/directionallylocal/tls`).
11. The server calls `DELETE /names/:name/dns01/:token`, or the challenge's
    alarm removes the record.

The name service never sees the ACME account key or the certificate private
key. A compromised name service can redirect DNS, but it cannot impersonate a
server's TLS identity without also controlling the CA validation path.

For wildcard certificates, the TXT record is
`_acme-challenge.<name>` (no wildcard label), which is the same record the
per-host flow uses. The service therefore supports both without a second API.

### 4.8 DNS providers

`ZoneObject` selects a provider from `env.DNS_PROVIDER` and `env.DNS_ZONE`:

```ts
export interface DnsRecord {
  name: string;   // fully qualified, no trailing dot
  type: "A" | "AAAA" | "CNAME" | "TXT";
  value: string;
  ttl: number;
}

export interface DnsProvider {
  readonly id: string;
  present(record: DnsRecord): Promise<void>;
  cleanup(record: DnsRecord): Promise<void>;
  list(zone: string): Promise<DnsRecord[]>;
}
```

Adapters:

- **`CloudflareDnsProvider`** (hosted): the Cloudflare DNS API with a
  zone-scoped token (`Zone:DNS:Edit`). Records are DNS-only (not proxied) so
  TLS terminates at the user's server.
- **`HttpDnsProvider`** (self-hosted): any provider with an HTTP API (deSEC,
  Hetzner, Route 53 through a signed request, or a small `dns-hook` sidecar
  that runs `nsupdate`). The Worker calls it with `fetch`.
- **`ManualDnsProvider`** (self-hosted, no API): returns the record to the
  operator and marks the challenge `pending`; the server polls until the
  operator publishes it or the challenge expires.

Do not implement RFC 2136 directly in the Worker. It needs raw TCP, which means
`cloudflare:sockets` on Cloudflare and is unavailable on celld/native. A
sidecar keeps the Worker portable.

### 4.9 Public Suffix List and cookies

`directionallylocal.run` is on the Public Suffix List. Consequences:

- Each `<name>.directionallylocal.run` is a separate registrable domain for
  cookies and storage. That is the point: one user's server cannot read
  another's cookies.
- A cookie with `Domain=directionallylocal.run` is rejected or not sent to
  subdomains. The name service and the install worker never set cookies.
- The install worker currently sends
  `Strict-Transport-Security: max-age=63072000; includeSubDomains`. That
  commits every assigned name to HTTPS before Phase 1 certificates exist.
  Recommendation: drop `includeSubDomains` from the bare-domain response until
  the name service can verify that a server has a valid certificate, then
  re-enable it. This is a one-line change in `site/handler.ts` and should be
  made with the Phase 1 TLS rollout, not before.
- PSL status is not a security boundary by itself. Uniqueness, ownership, and
  rate limits are enforced by `NameObject`, not by the PSL.

### 4.10 Abuse controls

- Reserved names and a profanity blocklist checked at claim time.
- Per-key and per-IP token buckets in `RateLimiterObject`.
- A name can be claimed only by a key that proves possession (the signature).
- Admin revocation removes DNS immediately and quarantines the name.
- Audit entries for claim, renew, release, revoke, and challenge publication.
- No wildcard DNS record for user names; each name is an explicit record, so a
  typo does not resolve to someone else's server.

### 4.11 Deployment

**Cloudflare**

```sh
npx wrangler deploy -c services/name/wrangler.cloudflare.jsonc
```

`wrangler.cloudflare.jsonc` adds:

```jsonc
{
  "routes": [{ "pattern": "names.directionallylocal.run", "custom_domain": true }],
  "workers_dev": false,
  "observability": { "enabled": true }
}
```

Secrets: `CF_DNS_API_TOKEN`, `ADMIN_TOKEN`. The zone ID and zone name are
`vars`, not secrets.

**Serverless Objects**

```sh
sobjects deploy services/name
sobjects up --detach
```

`sobjects.example.toml`:

```toml
[celld]
bucket = "s3://my-bucket/directionally-local-name"
listen = "127.0.0.1:8080"

[ingress]
listen = "0.0.0.0:443"
redirect_http = "0.0.0.0:80"

[ingress.acme]
email = "ops@example.com"
agree_to_terms = true

[[ingress.routes]]
hostname = "names.example.com"
```

The ingress ACME flow is HTTP-01 and cannot issue wildcard certificates. That
is fine: the name service's own host is an exact hostname. User names are
served by the users' servers, not by this ingress.

State lives in the bucket. `sobjects down` and `sobjects up` preserve it. The
service is single-node; that is acceptable because a self-hosted name service
owns one zone and one operator's names.

### 4.12 Tests and CI

Unit tests (`node:test`) cover:

- name validation and the reserved list;
- the lease state machine, including alarm-driven transitions;
- signature verification, replay rejection, and idempotency;
- DNS-01 record naming and key authorization;
- provider adapters against a fake `fetch`;
- problem+json shapes and rate-limit headers.

Conformance cases (run under `wrangler dev` and celld) cover:

- claim, duplicate claim, renew, release;
- challenge publish, visibility, cleanup, and expiry alarm;
- alarm delivery after a celld restart;
- SQLite persistence across object eviction;
- RPC from `NameObject` to `IndexObject`;
- rate-limit rejection.

## 5. Approvals page

### 5.1 Responsibilities

- Show a browser page listing pending GitHub App task approvals and laptop
  pairing requests.
- Let a signed-in person approve or deny each request.
- Record who decided what, when, and from where.
- Work for a hosted deployment and for a self-hosted node with no external
  identity provider.

Non-goals: being a general-purpose identity provider, storing GitHub tokens
for longer than needed, or accepting inbound connections to a user's server.

### 5.2 Flows

**GitHub App task approval**

1. Autopilot on the server decides a task needs approval and signs a request.
2. The server `POST /v1/requests` to the approvals service (outbound HTTPS, so
   NAT is fine).
3. The service stores it in `ApprovalQueueObject`, keyed by installation and
   server.
4. A person signs in, sees the request, and approves or denies it.
5. The server long-polls `GET /v1/requests?server=<id>` (25-second hold) or
   subscribes to `GET /v1/events` (SSE). It acts on the decision and reports
   the result with `POST /v1/requests/:id/result`.
6. The service appends an audit entry.

**Laptop pairing**

1. `dl pair` on the server creates a code (the existing `aster pair` flow) and
   posts `POST /v1/pairings` with `{code, serverId, name, expiresAt}`.
2. The person opens `https://approvals.../pair?code=...`.
3. They sign in (GitHub OAuth hosted, magic link self-hosted) and confirm the
   laptop name and server.
4. The service records the decision in `PairingObject`.
5. The server long-polls `GET /v1/pairings/:code` and completes the pairing.

Codes are single-use, expire after 10 minutes, and allow five attempts.

### 5.3 HTTP API

Base URL: `https://approvals.directionallylocal.run/v1` hosted, or
`https://approvals.<domain>/v1` self-hosted.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/` | session | HTML dashboard |
| `GET` | `/pair?code=` | session or magic link | HTML confirmation |
| `POST` | `/pair` | session | Form decision, redirect |
| `GET` | `/api/requests?status=pending` | session | List requests |
| `POST` | `/api/requests/:id/decision` | session + CSRF | Approve or deny |
| `POST` | `/api/requests` | server signature | Create a request |
| `GET` | `/api/requests?server=` | server signature | Long-poll for decisions |
| `POST` | `/api/requests/:id/result` | server signature | Report the outcome |
| `POST` | `/api/pairings` | server signature | Create a pairing |
| `GET` | `/api/pairings/:code` | server signature | Long-poll for a decision |
| `POST` | `/api/pairings/:code/decision` | session + CSRF | Approve or deny |
| `POST` | `/api/session/github` | none | OAuth callback |
| `POST` | `/api/session/magic` | signed token | Magic-link login |
| `POST` | `/api/session/logout` | session | End the session |
| `POST` | `/api/webhooks/github` | HMAC | GitHub webhook |
| `GET` | `/api/events` | session | SSE updates (optional) |
| `GET` | `/api/health` | none | Liveness |

Server-signed requests use the same Ed25519 scheme as the name service, with
the server key registered when the server first pairs.

### 5.4 Durable Objects and storage

| Class | Key | Responsibility |
| --- | --- | --- |
| `ApprovalQueueObject` | `idFromName(installationId + ":" + serverId)` | Pending requests, decisions, per-queue audit |
| `PairingObject` | `idFromName(code)` | Pairing state, attempts, expiry alarm |
| `SessionObject` | `idFromName(sessionId)` | Session data, CSRF token, expiry alarm |
| `GitHubInstallationObject` | `idFromName(installationId)` | Installation token cache and permissions |
| `RateLimiterObject` | `idFromName(bucketKey)` | Login, pairing, and decision limits |
| `AuditObject` | `idFromName("audit-" + day)` | Append-only daily audit log |

`ApprovalQueueObject`:

```sql
CREATE TABLE IF NOT EXISTS requests (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,          -- github-task | pairing
  server_id   TEXT NOT NULL,
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL,
  status      TEXT NOT NULL,          -- pending | approved | denied | expired
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  decided_at  INTEGER,
  decided_by  TEXT,
  reason      TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL
);
```

`PairingObject`:

```sql
CREATE TABLE IF NOT EXISTS pairing (
  code       TEXT PRIMARY KEY,
  server_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL,          -- pending | approved | denied | expired
  attempts   INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT
);
```

`SessionObject`:

```sql
CREATE TABLE IF NOT EXISTS session (
  id         TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,          -- github:login or server:<id>
  csrf       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  seen_at    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
```

Alarms: pairing and session expiry, request expiry, installation-token refresh,
and rate-limit reset.

### 5.5 Authentication and sessions

**Hosted:** GitHub OAuth App web flow. The callback exchanges the code for a
token, reads the user, and checks access to the installation's account or
repository through the GitHub API. The token is used once and not stored.

**Self-hosted:** a magic link. `dl pair` prints a URL containing a short-lived
token signed by the server key. The approvals service verifies the signature
against the registered server key and creates a session. No external identity
provider is required.

**Session cookie:** `__Host-dl_session`, `Secure; HttpOnly; SameSite=Lax;
Path=/`, no `Domain` attribute. The value is a 256-bit random identifier; all
session state lives in `SessionObject`. Twelve-hour idle timeout, seven-day
absolute timeout, rotation on login and on privilege change.

**CSRF:** a per-session token in a hidden form field, checked together with
`Origin` and `Sec-Fetch-Site`. No `SameSite=None`.

**GitHub webhooks:** verify `X-Hub-Signature-256` with HMAC-SHA256 through Web
Crypto before enqueueing anything.

**GitHub App JWT:** sign RS256 with Web Crypto from
`env.GITHUB_APP_PRIVATE_KEY` (PKCS#8 PEM). Cache installation tokens in
`GitHubInstallationObject` until five minutes before expiry.

### 5.6 UI

Server-rendered HTML from template functions. No framework, no build step, no
`HTMLRewriter`.

- Mobile-first, because the primary device is a phone.
- Forms use POST and redirect (POST/redirect/GET), so the core flows work
  without JavaScript.
- Optional small script for live updates, served from the Worker with a CSP
  hash; the page is fully usable without it.
- CSP: `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:;
  form-action 'self'; base-uri 'none'; frame-ancestors 'none'`.
- Every interpolated value goes through `escapeHtml`.
- No external fonts, scripts, or images.
- Clear states for pending, approved, denied, expired, and already-decided.

### 5.7 Deployment

Same shape as the name service:

- Cloudflare: `wrangler deploy -c services/approvals/wrangler.cloudflare.jsonc`
  with the custom domain `approvals.directionallylocal.run`; secrets
  `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_CLIENT_ID`,
  `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`, `ADMIN_TOKEN`.
- Serverless Objects: `sobjects deploy services/approvals` and
  `sobjects up --detach`, with an `[ingress.acme]` route for
  `approvals.example.com`. Self-hosted deployments can omit the GitHub OAuth
  secrets and use magic links only.

### 5.8 Tests and CI

Unit tests cover session creation and expiry, CSRF rejection, pairing attempt
limits, decision idempotency, webhook signature verification, and HTML
escaping.

Conformance cases cover pairing creation and expiry, approval decisions,
session expiry alarms, long-poll behavior, and SQLite persistence across
eviction. They run under `wrangler dev` and celld, like the name service.

## 6. Shared code

`services/shared` is deliberately small and dependency-free:

- `problem.ts`: RFC 9457 responses.
- `auth.ts`: Ed25519 verification, HMAC verification, canonical request
  strings, nonce handling.
- `html.ts`: escaping and the page shell.
- `rate-limit.ts`: token-bucket arithmetic shared by the DOs.
- `dns.ts`: the `DnsProvider` interface and the Cloudflare/HTTP/manual
  adapters.
- `acme.ts`: DNS-01 record names and key-authorization helpers.
- `config.ts`: reads and validates `env` once per request.

Both services import it. It has no Node.js built-ins, so it passes the
portability gate.

## 7. CI under `wrangler dev` and celld

The conformance runners live in
[`directionally-local/serverless-objects`](https://github.com/directionally-local/serverless-objects)
under `packages/conformance`. They currently know two suites, `core` and
`agents`, and copy a fixed app directory. To run our services, the upstream
runner needs one small addition: a `services` suite selected by `--app PATH`
(or an environment variable), so it can point at `services/name/conformance`
and `services/approvals/conformance`.

Proposed upstream change:

```js
const SUITES = {
  core: path.join(PACKAGE_DIR, "app"),
  agents: path.join(PACKAGE_DIR, "agents-app"),
  services: process.env.SOBJECTS_SERVICES_APP,
};
```

and `--app PATH` to override `SUITES.services`. The service conformance app
exposes the same `/cases` and `/case/<name>` contract as the core app, so the
runner needs no other change.

CI job, per service:

```yaml
services:
  runs-on: ubuntu-latest
  strategy:
    matrix:
      service: [name, approvals]
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: 22, cache: npm }
    - run: npm ci
    - run: npm run typecheck
    - run: npm test
    - run: node scripts/check-portable-apis.mjs services/${{ matrix.service }}
    - run: npx --yes serverless-objects build --strict services/${{ matrix.service }}
    - name: Conformance under wrangler dev
      run: |
        npx wrangler dev -c services/${{ matrix.service }}/wrangler.jsonc --port 8787 --local &
        node .ci/serverless-objects/packages/conformance/src/run.js \
          --target wrangler --suite services \
          --app services/${{ matrix.service }}/conformance
    - name: Conformance under celld
      run: |
        node .ci/serverless-objects/packages/conformance/src/run.js \
          --target celld --suite services \
          --app services/${{ matrix.service }}/conformance
```

The celld runner needs a pinned celld binary (`CELLD_BIN`, default
`~/.local/share/serverless-objects/engines/celld-0.6.2/celld`). CI installs it
with `sobjects upgrade` or downloads the pinned release and verifies its
checksum, matching the Serverless Objects install path.

Until the upstream `--app` change lands, a thin local runner
(`services/conformance/run.mjs`) starts `wrangler dev` or `sobjects dev` and
runs the same HTTP cases. It is a temporary bridge, not a second conformance
implementation.

The existing `check` job (typecheck, unit tests, build, shellcheck) stays as it
is. The `services` job is additive.

## 8. The `site/` worker today

`site/` serves `https://directionallylocal.run`. It uses only a `fetch`
handler, so it needs no conformance app. It did have two portability problems:

1. `site/index.ts` imported `../install.sh` as text through a Wrangler `rules`
   entry. celld supports `rules`, but `sobjects build` bundles with esbuild
   without applying them, so the portability gate failed with
   `No loader is configured for ".sh" files`.
2. There was no `wrangler.jsonc`, and celld does not read `wrangler.toml`, so
   `sobjects build site` could not find a config at all.

This PR fixes both, cheaply:

- `site/install-script.ts` is generated from `install.sh` by
  `npm run sync:site-script`. It exports the script as a string, so the module
  graph is plain TypeScript. A test fails if the generated file drifts from
  `install.sh`.
- `site/wrangler.jsonc` is the portable config (`name`, `main`,
  `compatibility_date`). `site/wrangler.toml` remains the Cloudflare deploy
  config with `routes` and `workers_dev`. A test asserts that the shared keys
  agree.
- `site/portability.test.ts` checks that the Worker imports only relative
  modules, uses only the `fetch` handler, avoids Node.js built-ins and
  Cloudflare-only APIs, and keeps the portable config free of celld-rejected
  keys.

With those changes, `sobjects build --strict site` passes. CI runs it in a
separate `portability` job, pinned to a Serverless Objects release; the static
test runs everywhere, including the existing `npm test`.

If `site/` later grows beyond plain `fetch` (a Durable Object, a binding, a
WebSocket), add a `site` suite to the conformance app at the same time.

## 9. Phasing

| Phase | Work | Depends on |
| --- | --- | --- |
| 0 | This design; `site/` portability check | — |
| 1a | `services/shared`; name service skeleton (health, claim, renew, release) with DOs; deploy to staging Cloudflare and a test Serverless Objects node | 0 |
| 1b | DNS-01, Cloudflare DNS provider, DoH propagation check; `dl up` integration; certificate issuance | 1a |
| 1c | PSL/HSTS rollout, abuse controls, admin API, audit export | 1b |
| 2a | Approvals skeleton; pairing flow; magic-link login | 1a |
| 2b | GitHub App task approvals; OAuth; webhooks | 2a |
| 3 | Self-hosted DNS adapters (HTTP provider, manual), docs, upgrade notes | 1b, 2b |

## 10. Risks and open questions

- **celld/native parity.** The conformance suite covers DO storage, alarms,
  RPC, and WebSockets, but not every edge case. The service conformance cases
  are the mitigation; they must run on both targets before a service ships.
- **Single-node self-hosting.** A self-hosted name service is one node. That is
  acceptable for one operator's zone, but it is not a multi-tenant hosted
  replacement. Document the difference.
- **Secrets on Serverless Objects.** celld has no secret bindings. The
  generated `wrangler.local.jsonc` and `EnvironmentFile` approach must be
  documented and tested so operators do not commit credentials.
- **DNS provider differences.** Propagation, TTL floors, and API rate limits
  vary. The DoH check and the reconciliation alarm absorb most of it; the
  manual provider is the escape hatch.
- **ACME rate limits.** A bug that retries issuance can burn Let's Encrypt
  limits. Add per-name issuance backoff and use the staging directory in tests.
- **HSTS before TLS.** `includeSubDomains` on the bare domain is unsafe until
  every assigned name has a certificate. Change it with Phase 1b, not before.
- **PSL timing.** PSL changes propagate slowly. Do not make correctness depend
  on PSL status; it is a cookie-isolation property, not an authorization one.
- **Name squatting.** Reserved names, rate limits, and a quarantine period
  reduce it. A dispute process is out of scope for Phase 1.
- **DO class names are permanent.** celld rejects rename migrations. Freeze the
  class names in this document before the first deploy.
- **`sobjects build --strict` is not a full API check.** It only inspects
  Node.js built-ins and native addons. The static API lint is a required
  companion, not an optional extra.

## 11. Acceptance checklist

- [ ] `wrangler deploy` deploys each service to Cloudflare.
- [ ] `sobjects deploy` deploys the same source to a self-hosted node with no
      code changes.
- [ ] `sobjects build --strict` passes for each service.
- [ ] CI runs each service's tests under `wrangler dev` and celld through the
      conformance runners in `packages/conformance`.
- [ ] `site/` passes the portability check and `sobjects build --strict site`.
- [ ] No service imports a Node.js built-in, a Cloudflare-only API, or a
      binding outside the allowed subset.
- [ ] No secret is committed; `env` is the only configuration surface.
