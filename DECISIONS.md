# Design decisions

Decisions taken while building the dashboard without being able to ask. Each one lists
the choice, why it was made, and what we could do instead. Open for review.

Entries marked **(revised)** were changed after the first review (Node 26, MariaDB, OIDC,
CI like carat). The new decisions those changes required are D20 and later. The second
review made the login mandatory and group-based (D16, D25).

## Architecture & tooling

### D1. One package, Node 26 runs the TypeScript server directly (revised)

- **Choice:** A single npm package, requiring Node ≥ 26 (`.nvmrc`, `engines`). The API
  server is TypeScript run directly by Node's built-in type stripping
  (`node src/server/index.ts`), so there is no server build step, no `tsx` and no
  `ts-node`. The code sticks to "erasable" syntax only (enforced by `erasableSyntaxOnly`).
- **Tooling, as in carat:** `tsc` is TypeScript 7 (`@typescript/native`), used for
  typechecking only. `typescript` is aliased to TypeScript 6 for typescript-eslint.
- **Why:** Fewest moving parts for a small personal tool.
- **Alternative:** a pnpm/npm workspace with `server/` and `web/` packages, if it grows.

### D2. Hono for the API, React + Vite for the UI

- **Choice:** Hono on `@hono/node-server` for the JSON API and the OIDC routes. In
  production it also serves the built SPA. The UI is React 19, bundled by Vite 8. In
  development, Vite proxies `/api` and `/auth` to the API server.
- **Alternative:** a server-rendered page (e.g. Hono JSX) with no client framework.

### D3. Charts are hand-drawn SVG, not a chart library

- **Choice:** Two small components: stacked columns (sessions per day) and horizontal bars
  (failure types). Every chart has a Chart/Table toggle.
- **Why:** Only two charts are needed, and hand-drawing them gives full control over the
  mark specs. It also avoids a large dependency.
- **Alternative:** Recharts (as in carat), ECharts or Observable Plot if we add many more
  charts.

### D4. MariaDB through the official `mariadb` connector (revised)

- **Choice:** MariaDB (developed and tested against 11.4 LTS) with a connection pool. The
  database stores the **raw report JSON** and normalised tables (reports → policies →
  failure details), plus sync bookkeeping and OIDC sessions.
- **Schema changes:** versioned migrations in [src/server/db.ts](src/server/db.ts), applied
  at startup under `GET_LOCK('tlsrpt_migrate')`, so several replicas can start at once.
  Applied migrations are never edited; new ones are appended. MariaDB commits DDL
  immediately, so a migration that fails halfway must be repaired by hand.
- **Connection settings:** separate `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`,
  `DB_NAME` (optional `DB_TLS`, `DB_POOL_SIZE`) rather than a single URL. These map
  directly onto Kubernetes secrets and config maps.
- **Existing data:** nothing is migrated from the old SQLite file. The mailbox is the
  source of truth, and the first sync re-imports every report.

### D5. IMAP access is strictly read-only

- **Choice:** The mailbox is opened with `EXAMINE` (read-only). We never set `\Seen`,
  move, delete or expunge anything.
- **Alternative:** move processed messages to a `Processed` folder, or delete reports
  older than N days.

### D6. Incremental sync by UID, on a schedule and on demand (revised)

- **Choice:** We remember the last processed UID and the mailbox UIDVALIDITY, and only fetch
  newer messages. Sync runs at startup, every `SYNC_INTERVAL_MINUTES` (default 30), from the
  "Sync now" button, and with `npm run sync` (`-- --full` to rescan everything).
- **New with MariaDB:**
  - A sync runs under `GET_LOCK('tlsrpt_sync')`. With several replicas, only one of them
    talks to the mailbox; the others skip that run.
  - The last UID only moves forward after a message is stored. A database error aborts
    the run, and the message is retried next time.
- **Caveat:** A message that _parses_ badly is recorded under "Mailbox sync", and is **not**
  retried automatically. After a parser fix, run `npm run sync -- --full`.

### D7. Duplicate reports are detected by (organization-name, report-id)

- RFC 8460 makes report-id unique per reporter. This also covers resent reports.
- report-id is compared case-sensitively (`utf8mb4_bin`).

### D8. Supported attachment formats

- gzip and plain JSON, detected from the content. Zip is rejected, because RFC 8460 does
  not allow it. Messages without a report are listed, not skipped silently.

### D9. "Received" uses the message `Date:` header, not the IMAP INTERNALDATE

- In this mailbox, INTERNALDATE is the same for every message (they seem to have been
  migrated).

## Analysis

### D10. Counting sessions when a report has several policies for one domain ⚠️ worth reviewing

- **Situation:** Microsoft reports each session under **both** the `tlsa` (DANE) policy and
  the `sts` (MTA-STS) policy for karlsen.fr. Summing all policies would double the count.
- **Choice:** For each report and policy domain, _sessions_ = the largest policy total,
  and _failed_ = the largest policy failure count. _successful_ = sessions − failed.
  Domains are then summed. So a session that fails under any one policy counts as failed.
- **Where raw numbers still appear:** The "Policies" table shows the un-deduplicated counts
  for each policy type.
- **Alternative:** count only one preferred policy type, or have no combined total.

### D11. Time buckets use the report's start date in UTC

- Ranges longer than 120 days switch to ISO-week buckets. Days without reports show as
  gaps.

### D12. Insight rules

- Failures are _critical_ at a failure rate of 5 % or more, otherwise a _warning_.
- MTA-STS `testing` → _info_ (no failures) or _warning_ (failures). `none` → _warning_.
- `no-policy-found` → _info_.
- A reporter silent for 7 days or more → _info_.
- All thresholds are constants in [src/server/analysis.ts](src/server/analysis.ts).

### D13. The default date range is 90 days

- The range is kept in the URL, so views can be bookmarked.

## UI

### D14. Colours: blue/orange for successful/failed, not green/red

- Green/red failed the colour-vision-deficiency check. Status colours are used only
  together with an icon and a text label.

### D15. Everything is computed on the server, per request

- No caching and no server-side pagination. That is fine for thousands of reports.

## Security & deployment

### D16. OIDC login (revised)

- **Flow:** OpenID Connect authorization code flow with **PKCE (S256), state and nonce**,
  using `openid-client` v6 (certified, from the author of `jose`). The provider is
  discovered from `OIDC_ISSUER`.
- **Client authentication at the token endpoint** is set by `OIDC_TOKEN_AUTH_METHOD`:
  `client_secret_basic` (the default, and the default of the OIDC spec), `client_secret_post`,
  `client_secret_jwt`, or `none` for a public client (PKCE only). It must match the client
  registration: Authelia, for example, rejects any other method.
  - It is not guessed from the provider's discovery document, because providers there list
    what they support, not what this particular client is registered with.
  - A secret is required unless the method is `none`, and it is refused with `none`.
  - `private_key_jwt` is not supported; it would need key management.
  - Revised: this was hard-coded to `client_secret_post` before, which Authelia rejected.
- **Mandatory:** the web server refuses to start without `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
  `PUBLIC_URL` and `OIDC_ALLOWED_GROUPS`. There is no "no login" mode, not even for
  development or the demo; use the mock provider from `compose.yaml` there. `PUBLIC_URL`
  must be a bare origin (e.g. `https://tlsrpt.example.com`). It is used to build the
  redirect URI (`/auth/callback`) and decides whether cookies get the `Secure` flag.
  Serving under a path prefix is not supported.
- **Sessions are stored server-side in MariaDB:**
  - The cookie holds a random 256-bit token (`HttpOnly`, `SameSite=Lax`, `Secure` on
    https). The database only stores its SHA-256 hash.
  - Sessions have an absolute lifetime (`SESSION_TTL_HOURS`, default 12), with no refresh
    tokens and no sliding renewal.
  - Expiry is checked with the database clock, so clock skew between the app and the
    database doesn't matter.
  - Server-side sessions allow a real logout (the row is deleted), and no signing key has
    to be managed.
- **Pending logins:** the state, PKCE verifier, nonce and return URL live in MariaDB for
  10 minutes and are single-use. A short-lived cookie restricted to `/auth/` binds each
  login to the browser that started it.
- **Who may log in:** see D25.
- **What is protected:** everything except `/api/health` (for probes) and the three auth
  routes (`/auth/login`, `/auth/callback`, `/auth/logout`). Other `/auth/…` paths are
  protected too, so they can't be used to reach the SPA fallback. The API answers 401, and
  page loads redirect to the login. A test checks this for every route.
- **Logout:** `POST /auth/logout` deletes the session. It then redirects to the provider's
  `end_session_endpoint` with `id_token_hint` (RP-initiated logout) when the provider has
  one.
- **CSRF:** `SameSite=Lax` cookies, plus a check of `Sec-Fetch-Site` / `Origin` on every
  non-GET request.
- **Basic auth was removed**, and so was the unauthenticated mode.
- The CLI sync (`npm run sync`) serves no HTTP, so it only needs the database and IMAP
  settings.

### D17. CI and release like carat (revised)

- **Workflow:** [.github/workflows/release.yaml](.github/workflows/release.yaml) copies
  carat's three jobs, with the same SHA-pinned actions:
  1. **check:** `npm run check` + `npm run build`, on every push and PR.
  2. **release:** a signed `tlsrpt.tar.xz` with checksum, attached to a GitHub release
     tagged `YYYY.MM.DD-<sha>`.
  3. **docker:** a standalone image on GHCR (`<tag>` and `latest`) with SBOM and
     provenance, signed with cosign. Since the third review, this image runs by itself;
     see D21.

  `dependabot.yml` and the auto-merge workflow are copied too.

- **Differences from carat:**
  - The check job has a **MariaDB 11.4 service container**, so the store integration tests
    run in CI.
  - `npm run check` = typecheck + ESLint + Prettier check + tests. It uses `node:test`
    rather than vitest (no extra dependency, and the TypeScript server runs natively).
  - The bundle is assembled by [scripts/bundle.sh](scripts/bundle.sh) (`npm run bundle`),
    not inline in the workflow, so it can be built and tested locally.
  - The image is built for **linux/amd64 and linux/arm64**. The bundle is
    architecture-independent and the Dockerfile has no `RUN`, so no emulation is needed.
  - The image is built from a committed multi-stage Dockerfile (carat generates a
    scratch Dockerfile in the workflow). See D21.
  - The workflow triggers on `master`, like carat and this repository's current branch.
- **Verified locally:**
  - `npm run check` and the bundle in `node:26` (with `TZ=Europe/Oslo`).
  - The multi-stage image (read-only root filesystem, all capabilities dropped): it synced
    the real mailbox into MariaDB, the full OIDC flow worked against a mock provider, and
    the health check reported healthy.
  - The amd64 + arm64 build with a buildx container builder.
  - The GitHub workflow with these changes has not run yet.

### D18. Demo data set (revised)

- `npm run demo` fills a separate `tlsrpt_demo` database with 120 days of synthetic reports,
  then serves it with IMAP disabled. Login is still required. The seed script refuses any database whose
  name does not end in `_demo`.

## Added with the revision

### D20. Production bundle ships `node_modules`, not a single bundled server file

- **Choice:** Unlike carat, whose server has no dependencies, this server needs Hono,
  ImapFlow, mailparser, mariadb and openid-client. The bundle therefore contains
  `npm ci --omit=dev` output. All of it is pure JS (checked: no native addons), so it runs
  on any architecture. Size: 25 MB unpacked, 2 MB as `.tar.xz`, 145 MB image (126 MB of
  which is the DHI Node base).
- **Alternative:** bundle the server with Vite/Rolldown into a single file. That would be
  smaller, but risks breaking dynamic requires in the mail libraries. Reconsider if size
  matters.

### D21. A standalone image, built with a multi-stage Dockerfile on Docker Hardened Images (revised)

- **Before:** a data-only `FROM scratch` image, to be mounted into a `node:26-alpine`
  container. **Now:** a standalone image built by a multi-stage [Dockerfile](Dockerfile).
  The mount and `subPath` question is gone.
  1. **build** (`dhi.io/node:26-alpine-dev`: npm, root): `npm ci` + `vite build`.
  2. **prod-deps** (same image): `npm ci --omit=dev --ignore-scripts`.
  3. **runtime** (`dhi.io/node:26-alpine`): copies `package.json`, the production
     `node_modules`, `dist/` and `src/server` + `src/shared`, and runs
     `node /app/src/server/index.ts`.
- **CI:** the Ubuntu check job still typechecks, lints and tests every push, and the
  release job still publishes the signed `tlsrpt.tar.xz` built on Ubuntu. The docker job
  builds the image from the repository, so the archive and the image are built by two
  separate processes from the same commit. Tests don't run inside the image build.
  - **Alternative:** build the image from the Ubuntu-built bundle (a copy-only Dockerfile),
    which guarantees the image is byte-identical to the archive. I prototyped and tested
    that first, then switched on request.
- **Multi-arch without emulation:** both build stages use `--platform=$BUILDPLATFORM`,
  because their output (built assets, pure-JS dependencies) is architecture independent.
  Only the copy-only runtime stage runs per platform. BuildKit's npm cache mount and the
  GitHub Actions layer cache speed up rebuilds.
- **Build context:** `.dockerignore` is an allow-list (package files, tsconfigs,
  `vite.config.ts`, `src/`), so `.env`, `data/`, `node_modules` and `.git` can never end up
  in the context. The image was checked for this.
- **Runtime base:** non-root uid 1000, no shell or package manager, a CA bundle for TLS
  (checked).
  - Everything in `/app` is owned by root and only readable, so a read-only root
    filesystem works.
  - `LISTEN_HOST=0.0.0.0` and `PORT=3000` are preset.
  - `HEALTHCHECK` uses Node's `fetch`.
  - The OCI labels include the git revision (`REVISION` build argument).
- **Pinned by digest:** both base images are pinned by digest (multi-arch index), and
  Dependabot's `docker` ecosystem refreshes them. Those PRs only touch the Dockerfile,
  so auto-merge works (`docker` was added to the auto-merge workflow).
- **Credentials:** dhi.io requires a Docker Hub login, even for free images (checked:
  anonymous pulls are refused). The workflow reads the repository variable `DHI_USERNAME` and the Actions secret
  `DHI_TOKEN`. Dependabot needs both as Dependabot secrets, because `dependabot.yml`
  registries can only read Dependabot secrets.
- **Not done:** the image is not built on pull requests. That needs dhi.io credentials
  in PR runs, including Dependabot's. A base-image problem would therefore only show up
  in the docker job on `master`. Worth adding if it bites.

### D22. Dates are exchanged with MariaDB as UTC strings

- The `mariadb` driver sets the session time zone, but still converts `Date` values
  using the Node process's local time zone. On a host with `TZ=Europe/Oslo`, timestamps
  were stored two hours off (caught by the integration tests). DATETIME columns are
  therefore read and written as explicit UTC strings (`dateStrings: true`). A test checks
  what is stored.

### D23. Development dependencies in `compose.yaml`

- `docker compose up -d` starts MariaDB 11.4. An init script creates the `tlsrpt_demo`
  and `tlsrpt_test` databases.
- `--profile oidc` adds `navikt/mock-oauth2-server` on :8080 for trying the login. It
  accepts any username; extra claims (e.g. an email) can be entered as JSON on its login
  form.
- The app itself runs on the host with `npm run dev`, not in compose.

### D24. Lint and format like carat

- ESLint flat config (typescript-eslint, react-hooks, react-refresh, eslint-config-prettier)
  and Prettier.
- Differences from carat's Prettier setup: 120 columns and single quotes, matching the
  existing code. The workflow YAML is excluded from Prettier to keep carat's style.

### D25. Access is granted by group membership only

- **Choice:** `OIDC_ALLOWED_GROUPS` (comma or space separated) is required. At login, the
  user's groups must include at least one of them. The groups are read from
  `OIDC_GROUPS_CLAIM` (default `groups`) in the ID token merged with the userinfo response.
  Accepted claim formats:
  - an array of strings, or one space/comma-separated string: the names are used as-is.
    `@` has no special meaning here, so e-mail-style group names (Google, Entra) work.
  - Zitadel project roles, `{ role: { orgId: orgDomain } }`: these become `role@orgId`, one
    entry per organisation the role is granted in, and **never the bare role name**. A role
    key only means something within an organisation. If the project is granted to another
    organisation, its admins can assign the same key to their own users; matching the bare
    key would let them in. The organisation ID is used rather than the domain, because the
    ID never changes.
  - **Anything else is refused** with its own error ("unsupported format") instead of being
    guessed at. For example, Keycloak's `resource_access` is keyed by client ID, and using
    its keys as groups would grant access to anyone with any role on that client. Arrays
    must contain only strings.
  - This replaced a proposed change that used the keys of _any_ object claim as groups. That
    change dropped the organisation scope and failed open on other object formats.
  - The claim name is tried as-is first, because some providers use URLs as claim names.
    It is then tried as a dotted path into nested claims, e.g. Keycloak client roles
    (`resource_access.tlsrpt.roles`) or realm roles (`realm_access.roles`).
- **Error messages:** a missing claim, a claim in an unsupported format, and a claim
  without an allowed group give different messages. A missing claim is almost always a
  provider mapping issue, not a permission issue. A denied login is logged server-side with
  the groups as read (e.g. `operations@123`), which shows the exact value to allow.
- **The email allow-list was removed**, so there is a single authorization rule.
  Individual users can still be allowed through a dedicated group.
- **When changes take effect:** group membership is checked at login only, not on every
  request. Removing someone from the group takes effect at their next login, at the
  latest after `SESSION_TTL_HOURS` (default 12 h).
  - **Alternative:** store the groups in the session and re-check them on each request.
    That makes a change to `OIDC_ALLOWED_GROUPS` take effect immediately. It still would
    not catch changes at the provider without refresh tokens.
- **Fails closed:** an empty allow-list is refused at startup, and `authorize()` denies it
  too.

## Housekeeping

### D19. Branch naming

- The repository is on `master` with no commits yet, while `main` is recorded as the main
  branch. The workflow follows carat and triggers on `master`. If you create `main`
  instead, change `push: {branches: [master]}` in `release.yaml`.
