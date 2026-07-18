# Headwater devlog

DeltaNet-era entries retained after the current entry preserve the former name
and deployed identifiers as written. They document implementation history, not
current naming.

## 2026-07-18 - unsigned native desktop nightlies

Headwater now has the packaging and CI foundation for rolling unsigned desktop
nightlies (`meta/issues/nightly-desktop-releases.md`):

- Native GitHub jobs build Linux x64 Flatpak and AppImage variants, a Windows x64
  NSIS installer, and a macOS arm64 DMG after a separate root check/test gate.
  SHA-qualified job artifacts are merged only after every platform succeeds,
  checksummed, and published to the rolling `nightly` prerelease when the commit
  is still the current `main` head. Non-canceling event/ref concurrency prevents
  interrupted release replacement, and manual runs never publish.
- electron-builder 26.15.3 is pinned beside Electron 43.1.1. Packaging uses a
  stable application/desktop identity, Headwater icons, explicit external
  resources, platform-native helper names, and post-pack assertions for the
  daemon, frontend, utility worker, runtime dependencies, and executable helper.
- Resource staging now preserves nested production dependency layouts outside
  ASAR and records the exact staged versions. Verification imports the staged
  compiled daemon, catching dependency graphs that merely exist but cannot
  resolve at runtime.
- The Flatpak aligns the Freedesktop runtime, SDK, and Electron BaseApp on 24.08
  and exports a 512 px icon. A privileged disposable NAS container built the
  111 MB bundle without warnings; installing it confirmed the expected app ID,
  runtime, architecture, and commit.
- The 163 MB Linux x64 AppImage provides an unsandboxed single-file alternative.
  A native NAS build passed the packaged two-launch daemon/helper/listener smoke
  in extraction mode, and CI runs the same smoke before upload. Release notes
  explain format selection, installation, sandbox and update limitations,
  per-platform data paths, and checksum verification.
- Credential-free macOS nightlies are ad-hoc sealed rather than left with a
  structurally invalid bundle. The hardened runtime receives Electron's JIT,
  unsigned-executable-memory, and library-validation entitlements; strict deep
  signature verification passes, and a LaunchServices run confirmed startup.
  The existing two-launch daemon/helper/listener smoke can now target packaged
  resources and runs against the sealed app in CI.
- Final local verification passed root checks, 1,533 daemon tests, 353 frontend
  browser tests, 28 desktop tests, both daemon production-artifact tests, the
  full build/resource staging and import verification, workflow YAML parsing,
  `git diff --check`, Flatpak build/install, and macOS strict signature checks.
  The first native workflow subsequently produced every original artifact and
  published the rolling release successfully; the issue remains open until the
  AppImage and expanded guidance complete the same path.

## 2026-07-18 - secure Electron desktop bootstrap

The first macOS-arm64 desktop slice now has an independent pinned Electron 43
package and a narrow supervised boundary around the compiled daemon
(`meta/issues/electron-secure-bootstrap.md`):

- Electron starts the daemon in a utility process, validates every private-port
  message in both directions, waits for the actual loopback origin before
  creating a window, and exposes only a frozen status call through the sandboxed
  CommonJS preload. Enrollment codes remain confined to the private lifecycle
  channel and are not placed in argv, logs, renderer globals, or desktop files.
- The renderer uses context isolation, sandboxing, disabled Node integration,
  denied permissions/downloads, same-origin navigation, denied child windows,
  validated external HTTP(S) links, and IPC sender validation. The application
  also owns a single-instance lock.
- Readiness has a 30-second deadline. Graceful daemon shutdown retains its
  10-second budget under a 15-second parent watchdog; repeated quit requests
  remain prevented until cleanup settles, close failures produce a nonzero exit,
  and utility exits or malformed/oversized messages cannot strand startup.
- Root setup/build/check/test orchestration includes the desktop package.
  Resource staging copies the compiled daemon, current static frontend, utility
  worker, and pinned native helper through a rollback/recovery-safe replacement;
  generated resources and the local Electron cache remain ignored.
- The macOS smoke builds and stages fresh inputs, launches the actual Electron
  process group twice against one isolated data directory, requires shutdown
  completion, checks the listener with raw TCP, and thereby proves utility,
  listener, and daemon-lock reuse. The final unrestricted macOS-arm64 run passed
  both launches and satisfied the platform acceptance criterion.
- A repeatable pinned-Node-24/Xvfb container smoke passes both launches on the NAS
  Linux-amd64 Podman worker. This independently proves the Electron host and
  utility/daemon lifecycle. The launcher also passes an explicit
  development-only smoke root and sets Electron's user-data path before
  acquiring the single-instance lock, avoiding platform-specific command-line
  path initialization.
- Verification passed all root checks, 1,533 daemon tests, 353 frontend browser
  tests, 26 desktop tests, the full frontend/daemon/desktop build and staging,
  both production artifact tests, `git diff --check`, and independent lifecycle
  review with no blocking findings.

## 2026-07-18 - compiled production daemon and owned lifecycle

The daemon is now an import-safe, embeddable service instead of a program that
starts during `main.ts` module evaluation
(`meta/issues/daemon-production-runtime.md`):

- `startDaemon(config)` accepts absolute managed paths and returns the actual
  bound origin, readiness data, a completion promise, and one idempotent bounded
  `close()` operation. Structured events report enrollment-code replacement,
  readiness, recoverable diagnostics, and startup/runtime fatal failures without
  requiring a desktop parent to parse logs.
- Listener binding now confirms the real address before readiness. Port `0`
  adopts and trusts the OS-selected same-origin URL, occupied ports unwind
  cleanly, and canonical same-path runtimes are rejected in-process before they
  can share and prematurely release a process lock.
- Shutdown owns HTTP, WebSocket clients/server, backfill timers, in-flight
  signup/restore work, provisional and published transports, Delta Chat I/O,
  the native helper, and the daemon lock under one deadline. Timed-out graceful
  transport closure escalates to confirmed `SIGKILL`; the lock is never released
  while a helper or lifecycle operation may still own the data path.
- The pinned `deltachat-rpc-server` executable is now spawned under local
  supervision using the same JSON-RPC client. Spawn failures and unexpected
  exits become typed failures instead of exceptions thrown from child-process
  handlers; startup races close the helper, while runtime exits close the daemon.
- `main.ts` is a thin compatibility adapter for environment defaults, console
  rendering, and pre-readiness `SIGINT`/`SIGTERM` cancellation. Production start
  runs compiled `dist/main.js` directly under Node 24; `tsx` remains development
  only. CI builds and launches that artifact, serves a static SPA fallback,
  exercises both signals, and proves the listener can be rebound afterward.
- Final verification passed 1,533 daemon unit tests, both compiled-artifact
  smoke tests, root TypeScript/Svelte checks, the production frontend+daemon
  build, `git diff --check`, and all 18 real-relay integration scenarios. Final
  adversarial lifecycle review found no blocking issues.

## 2026-07-17 - Headwater rebrand and migration compatibility

The product is now Headwater. Repository metadata, active documentation,
commands, API examples, capability contracts, and current issues prefer
Headwater names (`meta/issues/rebrand-headwater.md`):

- Fresh configuration uses `HEADWATER_*`; APIs and resources use
  `/api/headwater/*` and `/headwater/*`; JSON metadata uses
  `configuration.headwater` and `pleroma.headwater`.
- Fresh durable files are `headwater-store.json` and
  `headwater-signing-key.json`, while backup downloads use a Headwater filename.
- Migration is deliberately non-destructive. Deployed DeltaNet-era environment
  names, routes, JSON namespaces, browser/core keys, auth hash domains, and state
  filenames remain legacy fallbacks or mirrors. Existing old-named state is
  reused in place so startup cannot mint a replacement feed or signing identity.
- The `.dnbk` extension and `DNBK1`, `dn: 2`, `dn2`, and `dn3` bytes remain
  immutable legacy format/protocol identifiers. Old backups restore and signed
  history continues to verify; these identifiers are not rebranded on disk or
  wire.
- Delta Chat and upstream package/transport names are unchanged. The checkout
  directory and remote still use the former repository slug and require a
  coordinated external rename after the source-tree migration.
- State-file selection now treats only `ENOENT` as absence, so permission or I/O
  failures cannot silently select a fresh store or signing identity. Delta Chat
  compatibility writes persist the rollback-readable legacy key before the
  preferred alias, and browser auth/notification state keeps rollback mirrors.
- The supplied Headwater mark is integrated as a shared SVG and favicon and was
  rendered at desktop and mobile breakpoints. Final verification passed 1,518
  daemon unit tests, 353 frontend Playwright tests, TypeScript/Svelte checks, the
  production build, `git diff --check`, and all 18 real-relay integration
  scenarios. Independent final review found no remaining concrete regressions.

## 2026-07-11 - unified Node and pnpm toolchain

Root orchestration, both packages, local mise, and all CI jobs now select Node
24 and exact pnpm 11.5.2 (`meta/issues/pnpm-version-alignment.md`):

- Root, daemon, and frontend package metadata agree on the runtime and package
  manager policy. Root scripts use `pnpm --dir` so one pinned executable drives
  both package-local installs and commands.
- The root and frontend mise configurations agree exactly. The root adds setup,
  check, test, and build tasks, and user-facing documentation uses mise tasks or
  `mise exec -- pnpm` rather than assuming an ambient executable.
- Three lockfiles are intentional: the daemon and frontend own independent
  dependency graphs, while pnpm's root script lifecycle maintains an empty root
  importer. Frozen installation succeeds for all three without lockfile drift.
- Daemon Node typings now target Node 24 too. A pnpm 11 workspace-level override
  keeps transitive `@types/ws` on the same major; no Node 26 types remain in the
  daemon lockfile.
- All three GitHub Actions jobs install pnpm 11.5.2 and Node 24. Local
  verification under Node 24.18.0/pnpm 11.5.2 passed root `setup`, `check`,
  `build`, and `test` (1,501 daemon tests and 350 frontend Playwright tests).
  Two independent reviews approved the final policy with no findings.

## 2026-07-11 - constrained signup relay registration

Signup no longer turns its caller-provided relay field into an arbitrary
server-side request (`meta/issues/signup-relay-validation.md`):

- Relay values must be bare HTTPS origins. Lexical checks reject credentials,
  paths (including normalized dot segments), queries, fragments, backslashes,
  whitespace, malformed DNS labels, and ambiguous authority syntax before URL
  canonicalization.
- The default relay remains available for ordinary onboarding. Other origins
  must be listed by the node operator in `DELTANET_SIGNUP_RELAYS`, and selecting
  one also requires the current unexpired terminal enrollment code. The proof
  is validated without consuming it; account binding invalidates it and prints
  the fresh post-signup code used for browser enrollment.
- Registration POSTs disable redirects, abort after 10 seconds, cap response
  bodies at 16 KiB using both declared and streamed byte counts, and cancel
  rejected or stalled streams. Upstream bodies are never included in errors.
- Relay responses are parsed only after the bounds checks and must contain a
  structurally valid dot-atom mailbox address and a non-empty bounded password
  before credentials can reach persistence or transport opening.
- Private and loopback relays use the same explicit operator allowlist and
  enrollment proof. TLS remains mandatory; only the isolated integration-test
  worker relaxes certificate verification for its disposable self-signed
  podman relay.
- Two independent security review passes were completed. Final verification
  passed all 1,501 daemon unit tests, all 350 frontend Playwright tests, both
  TypeScript/Svelte checks, `git diff --check`, and all 18 tests in the real
  ephemeral podman relay integration suite.

## 2026-07-11 - protected account credential persistence

`accounts.local.json` now has credential-specific filesystem defenses in
addition to the earlier generation/locking work
(`meta/issues/account-credentials-file-security.md`):

- Missing credential directory components are created and corrected to mode
  0700 even under a hostile umask. Existing parents may be read-only/shared but
  must not be group/world-writable; unsafe parents fail closed with a stable,
  sanitized diagnostic.
- Existing credential files are opened once with `O_NOFOLLOW` on POSIX. File
  type, mode correction to 0600, ownership capture, and reading use that same
  descriptor (`fstat`/`fchmod`), rejecting live and dangling symlinks without a
  pathname-following chmod/read race.
- Atomic replacement applies preserved UID/GID and exact 0600 mode to the
  exclusive temporary descriptor before writing, fsyncing, closing, and
  renaming. There is no post-rename pathname chmod. Unrelated account entries
  remain protected by the immutable-ticket interprocess lock and read-modify-
  write transaction.
- Account parse/read/write failures expose only path, operation, and stable
  reason codes. Raw JSON parser causes are discarded, including for restore
  journals that contain credential snapshots, so recursive error inspection and
  stacks cannot retain passwords.
- Tests cover restrictive creation, hostile umask, broad-mode correction,
  ownership forwarding/preservation, writable-parent rejection, live/dangling
  symlinks, non-files, pre-rename failure cleanup, complete-old-file retention,
  and account/journal error-graph redaction.

## 2026-07-11 - honest frontend-daemon capability contract

The bundled UI now derives mutable feature availability from
`GET /api/v2/instance` instead of assuming every broad Pleroma client method has
a DeltaNet implementation (`meta/issues/frontend-daemon-capability-contract.md`):

- `configuration.deltanet.capabilities` explicitly advertises bookmarks,
  deletion, account moderation, media-description updates, chats, polls,
  unlisted visibility, content warnings, and extended profile fields. Unknown
  metadata is conservative while loading or after failure; generic non-DeltaNet
  Pleroma instances retain their ordinary feature set.
- The bundled daemon advertises only media-description updates from that set.
  Bookmark/delete/mute/block controls are independently gated while the working
  thread-subscription control stays available. Messages and Bookmarks retain
  useful routes with unavailable-state copy and make no unsupported requests,
  including direct chat deep links. Received polls remain read-only.
- Poll/CW composition and unlisted visibility are hidden. The daemon also
  rejects unsupported poll fields, warning text, extended profile fields, and
  unknown visibility with a stable 422 rather than silently dropping fields or
  broadening audience. Website/location/privacy settings are replaced with
  explicit unavailable copy while name, bio, avatar, and header remain editable.
- Upload controls consume the advertised MIME list. DeltaNet advertises one
  PNG/JPEG/WebP/GIF image, so audio/video are rejected before upload and stale
  generic "add another" affordances are gone. Alt-text controls appear in both
  composers only when media-description updates are supported.
- Success-shaped bookmark/chat stubs and the duplicate follow-request stub were
  removed. Remaining empty endpoints are read-only discovery surfaces. The full
  reachable API inventory and request/response/persistence/federation decisions
  live in `meta/frontend-daemon-capabilities.md`; deferred capabilities each have
  focused issues.

## 2026-07-11 - bounded media and backup resources

Upload and backup paths now have daemon-enforced, process-wide bounds
(`meta/issues/media-backup-resource-limits.md`):

- Request bodies default to 1 MiB. Media files are limited to 40 MiB, restore
  containers to 256 MiB, encrypted backup sidecars to 2 MiB, core backups to
  253 MiB, and final exports to 256 MiB. The body limiter counts the stream even
  when `Content-Length` is absent or false, and rejects declared oversize bodies
  before reading. Because Hono multipart parsing materializes a `File`, the
  daemon conservatively reserves two route-sized body copies from a 600 MiB
  process budget before reading; restore adds at most one bounded 2 MiB prefix
  decode plus ordinary runtime overhead. Busy work fails with a stable 409/429
  instead of multiplying heap use.
- Backup generation is serialized. Delta Chat's export API writes one scratch
  tar before exposing its size and has no quota/cancel hook; the daemon checks
  it immediately on return, removes stale retry attempts before retrying, and
  recursively cleans all rejected scratch state. Accepted exports hash the tar,
  build only the bounded encrypted prefix in memory, and stream prefix + tar to
  the response. Restore buffers the bounded multipart request (the Hono API
  constraint), decrypts only the prefix, streams the core slice to a mode-0600
  scratch file, verifies its authenticated hash, and cleans it in `finally`.
  The browser download remains a Blob bounded by the same 256 MiB response cap.
- Backup timestamps are finalized only after the complete container passes all
  limits. Core, sidecar, final-container, malformed-sidecar, wrong-passphrase,
  and store-snapshot failures do not claim a successful backup.
- Staged media streams to mode-0600 files in a mode-0700 shared scratch
  directory. At most eight 40 MiB records exist (320 MiB disk bound); each lives
  for one hour. Startup sweep removes crash orphans. Explicit cancellation,
  posting success, posting failure, and expiry discard registry state and files;
  reference-counted leases defer unlink until every concurrent post finishes.
- Only one attachment is advertised and accepted because the transport can send
  one file. The frontend now enforces that capability and explicitly deletes
  removed or stale upload results. A failed status marks its consumed upload as
  requiring reattachment rather than retaining a dead media id.
- Alt text is capped at 4 KiB, editable through `PUT /api/v1/media/:id`, included
  in the signed durable envelope, and cached transiently at no more than 1,024
  entries (4 MiB derived maximum). Profile avatar/header uploads share the 40 MiB
  per-file cap, accept two files in one bounded request, stream through temporary
  files, and restore prior files if transport persistence fails.

## 2026-07-10 - atomic, corruption-safe store persistence

`deltanet-store.json` now treats pins, held envelopes, pending requests,
notifications, and thread bindings as recovery-critical state rather than a
rebuildable cache (`meta/issues/atomic-store-persistence.md`):

- Schema v10 adds a safe monotonic generation. Every mutation validates and
  atomically writes the same mode-0600 generation to
  `deltanet-store.json.recovery` first and then the primary. Startup validates
  both, selects the highest generation, and heals the missing/older/corrupt
  peer. Corrupt files are retained as timestamped quarantine files; read,
  permission, and other I/O errors are distinct `StoreAccessError`s and never
  trigger quarantine or rollback.
- Store writes use unique same-directory temporary files and an immutable-ticket
  process lock. Production acquires its mode-0700 daemon lock beside the core
  data directory before journal recovery, credentials, auth, or transport open.
  Dead predecessors are completed without deleting/replacing a live lock name;
  a real child-process `SIGKILL` test covers automatic restart recovery. Live or
  malformed predecessors fail closed. Generation CAS rejects stale Store
  instances. Stat/probe checks classify only `ENOENT` as missing; `EACCES`,
  `EIO`, and other failures remain fail-closed.
- Validation is version-specific. Empty/schema-zero and sparse ambiguous legacy
  objects are rejected; complete historical versionless stores and known schemas
  with their required anchors migrate. Current files require every field and generation. Persisted
  IDs are safe non-negative integers, notification types are enumerated, and
  held envelopes require a usable content-envelope shape before non-derivable
  state can survive migration.
- Backup export brackets asynchronous core export with store generation/content
  and an in-memory external-mutation barrier. Mutating API requests, background
  API work, main ingest/events, backfill sends, and thread channel creation hold
  the barrier across core-first awaits; export itself never acquires it. Export
  retries completed generation changes in a fresh directory per attempt and
  returns 409 for active work. New
  containers also authenticate a SHA-256 binding of the core tar in the GCM
  sidecar while retaining read compatibility for existing DNBK1 containers.
- Restore writes a mode-0600, fsynced journal beside (not inside) the core data
  directory before core import. The journal covers store, signing key, and the
  account-credentials file: per-account compare-and-exchange preserves unrelated
  daemon credentials, normal failures roll those roots back, committed credentials
  complete donor roots, and startup replays an interrupted phase
  before opening credentials/store/attestor/transport. Journal and signing-key
  writes share atomic durable-file handling.
- Signing-key snapshots are parsed as Ed25519 PKCS8, their public SPKI is derived
  from the private key, and the exact stored base64 SPKI must match before core
  restore or installation. Startup journal replay uses Store's same exclusive
  writer lock and generation-safe replacement rather than raw file writes.
- Restore returns an uncommitted opened transport. The server requires its core
  self address to equal authenticated `sidecar.addr` before credentials, auth,
  global transport, or journal commit. A prepared-restore lifecycle closes and
  rolls back every post-import failure before publication. The encrypted
  sidecar's authenticated core hash additionally rejects tar splicing.
- The journal deliberately does not transact Delta Chat core import itself;
  core requires an empty target directory and provides no rollback transaction.
  A crash before credential commit can therefore leave an unreferenced imported
  core directory, while sidecar roots and account credential selection still
  roll back consistently.
- File and supported directory fsync cover unique temp replacement, lock/journal
  removal, and each newly-created parent level. Directory fsync errors known to
  mean "unsupported" on the current platform are tolerated; other I/O errors
  fail closed. Shared system temp itself is never chmodded.
- TDD covered the initial persistence red plus focused re-review failures for
  identity splicing, key mismatch, lock ownership/incarnation, probe errors,
  journal races, and pending external mutations. Final verification: 1,412 daemon unit tests,
  `pnpm check`, `git diff --check`, and the real relay
  export-wipe-restore/attestation-key integration all pass.

## 2026-07-10 - local API security boundary

The local Mastodon-compatible API now has an explicit authorization boundary
(meta/issues/local-api-security-boundary.md):

- Production `main.ts` and security tests use `createApp` with a persisted auth
  store; every non-security unit/integration fixture explicitly uses the
  conspicuous `createUnsafeTestApp` factory. The production mode is
  fail-closed, with a method/path allowlist for the SPA, constrained onboarding,
  OAuth, instance metadata, public assets, and sanitized public projections.
  Notifications, backup, relationship/search APIs, mutations, and private-state
  stubs all require a valid Bearer session.
- OAuth apps, codes, and sessions are random per flow (32 bytes). The mode-0600
  auth file stores hashes of client secrets, codes, and tokens, replaces itself
  atomically, binds codes to client + exact redirect + scope, consumes codes
  once, expires them after five minutes, and persists session expiry/revocation.
  Client registration requires a one-use 10-minute terminal enrollment code or
  an existing bearer, accepts only the complete `read write follow push` scope,
  and is persisted per daemon instance by the frontend for normal sign-in reuse.
- CORS is no longer wildcard in production. It echoes only the base origin plus
  `DELTANET_ALLOWED_ORIGINS`; untrusted browser mutations, OAuth, and onboarding
  requests are rejected. A Vite origin is an explicit development choice.
- REST uses `Authorization: Bearer`; WebSocket upgrades consume a one-use
  30-second ticket issued through authenticated REST, never a bearer in the URL.
  Tickets remain associated with their session, and live sockets close on
  revocation, account rotation, or session expiry. Frontend sign-out closes
  streams and local state first, then makes a bounded best-effort revoke.
- Every message blob requires either a bearer or a one-minute HMAC-signed URL
  capability from the auth store's persistent signing secret, allowing UI images
  without leaking the bearer into image URLs.
- Anonymous public timelines/profile statuses filter both wire-marked and
  store-marked private/direct posts and strip local petnames, relationships,
  action flags, and subscription state. Nested boosts fail closed unless their
  complete status tree is known public. Security re-review tightened "known" to
  persisted positive feed provenance for every locally resolved tree node:
  schema v9 reindexes `feedMsgIds`, outer timeline/profile feed messages are
  ingested before projection, and a feed boost cannot surface or placeholder a
  DM-only post. No message blob can be fetched from its bare URL.
- Explicit signout now unpairs the OAuth client identified by its authenticated
  bearer, atomically removing that client and all of its sessions, authorization
  codes, and stream tickets, then notifying every session socket. The daemon
  prints a fresh one-use terminal enrollment code for the browser's next pairing.
  Authorization state permits one outstanding code per client and a bounded
  global set (including restart normalization); OAuth app/code/token responses
  are `no-store`/`no-cache`.
- OAuth callbacks remove code/error parameters from browser history immediately
  after parsing. Signed blob URLs remain intentionally usable for at most their
  60-second lifetime after session/client revocation, and every blob response is
  `private, no-store`.
- Signup and restore share one configuration mutex. Auth state is account-bound:
  changing identity rotates clients, codes, sessions, tickets, and blob signing
  material rather than carrying browser authority across accounts.
- The listener defaults to `127.0.0.1`. Any non-loopback hostname requires the
  exact `DELTANET_ALLOW_NON_LOOPBACK=1` opt-in and a documented HTTPS/reverse-
  proxy security model. Existing fixed `deltanet-token` sessions intentionally
  fail validation and reauthenticate.

## 2026-07-10 — direct visibility: mentioned recipients only

`visibility: direct` now has a transport-level meaning rather than falling
through to the public feed (meta/issues/direct-visibility-mentions.md):

- A direct root must mention at least one non-self E2EE-capable key contact.
  Every body mention is resolved before the first send; one unreachable mention
  rejects the whole request with 422, so there is no known-recipient partial
  send caused by address validation.
- The daemon signs one envelope carrying the unsigned `visibility: 'direct'`
  honest-machinery marker and sends that exact text through media-capable 1:1
  content DMs. No owned-broadcast `post()` call occurs. Every sender-side local
  copy is indexed as non-feed under one logical UUID; one is returned as the
  status, while recipients derive the existing mention notification.
- Direct replies inherit direct server-side. Their audience is the parent author
  plus explicit body-mentioned key contacts; the ordinary root-author copy and
  thread-channel republication paths are bypassed.
- Direct is the strict leak tier: it is excluded from home/public/profile feeds,
  cannot be boosted (including a direct original smuggled into a boost embed),
  held/served by backfill, subscribed, or republished to a thread channel.
  Persisted `directPostUuids` state mirrors locked UUID state and survives store
  migration/reload.
- The frontend leaves Direct enabled, disables obvious no-address-mention root
  submissions, opens the returned direct thread instead of inserting it into
  Home, and disables boost controls for direct posts in every shared renderer.
- Relay acceptance: B and C both follow A's public feed; A directly mentions B.
  B alone receives the content and notification, neither feed contains it, C
  sees no leak, and B's public-requested reply inherits direct back to A.

## 2026-07-09 — visibility part 2: leak prevention

"Followers"-only is now enforced by machinery, not just by our own node
(meta/issues/visibility-leak-prevention.md):

- **Wire marker**: content envelopes carry an UNSIGNED
  `visibility: 'private'` field (same trust argument as `invite` — it
  rides outside the canonical payload; stripping it requires a peer who
  could equally leak the content itself; the marker guards HONEST
  machinery, not malicious holders). Tolerant parse drops junk values.
- **Receiver honoring**: follower nodes render marked posts `private`
  (boost button disabled in the UI, reblog endpoint 422s for numeric AND
  held/embed targets), backfill serving refuses marked envelopes wherever
  held (which also covers thread-so-far bundles — they build through the
  same `buildServeBundles`), thread republication skips marked replies,
  a thread-invite request for a locked/marked root is consumed without
  granting, and the subscribe endpoint 422s private threads.
- **Reply privacy inheritance, server-ENFORCED**: replying to a private
  parent forces the reply onto the replier's OWN locked channel and marks
  it — stricter than Mastodon's overridable default. Caveat documented:
  the replier's locked audience is their followers, not the author's.
- **Revocation**: `POST /api/v1/accounts/:id/remove_from_followers` pulls
  a contact out of BOTH owned channels (future delivery only — the honest
  limit: already-delivered posts stay on their device; none of this is
  DRM, it keeps honest machinery honest).
- Relay integration extension: the marker travels; a locked follower's
  node renders it private, refuses to boost it, and their reply — even
  requested public — inherits locked and never reaches a public-only
  follower of theirs.

## 2026-07-08 — active key confirmation (closing the TOFU stranger window)

Relayed content from a never-met author used to render fully attributed on
its self-certifying signature alone. Now (meta/issues/key-confirmation.md):

- Held/embedded content whose author has NO pinned key renders with a
  dashed "unconfirmed" chip (`pleroma.deltanet.author_unconfirmed`) —
  attribution is honest about being signature-only.
- Every held render (= a thread/orig view; held content never enters
  timelines) schedules ONE background confirmation per author per 15-min
  window: introduce via the invite the envelope carries (checkQr gate +
  post-join address check), then send an ordinary `envelope-request` for
  the post's uuid DIRECTLY to the author. No new wire verb.
- **Self-served-bundle pin rule**: a bundle item that verifies against the
  SENDER's own address pins them — the author attesting their own envelope
  over the PGP-verified channel, trust-equivalent to a direct content
  delivery. First-wins; relayed items (author != sender) still never pin.
- The boost-embed verdict cache re-verifies when the pin state changes, so
  a confirmation that CONFLICTS with an embed flips it to the unverified
  placeholder instead of serving stale trust — forgeries are positively
  detected, not just eventually noticed.
- Deliberately NOT eager-on-ingest: a securejoin is visible to the author,
  so eager fetching would turn every backfilling lurker into a join event.
  Thread-view gating bounds the metadata leak to actual reader interest.
- Direct-delivery TOFU pinning itself is unchanged — it was already
  fetch-equivalent (same PGP channel); only the silent stranger fallback
  is gone.

## 2026-07-08 — visibility channels, part 1 (public + locked)

The composer's visibility selector is no longer decorative: `private`
("Followers") posts go to a second owned broadcast — the LOCKED channel —
while public/unlisted stay on the original feed (which simply *is* the
public channel; migration was free). Timeline aggregation was nearly free
too: `feedChatIds()` already includes every OutBroadcast.

- **Locked follows are approval-gated by construction**: securejoin links
  are capability-based (no join-with-approval exists at the core level),
  so the locked invite is never published — a requester sends a
  locked-SCOPED invite-request (thread-scope precedent; old nodes safely
  degrade to public auto-grant), the owner's daemon QUEUES it
  (follow_request notification — the frontend's accept/decline UI existed
  all along), and approving DMs the locked invite, which the requester's
  existing follow-back machinery joins. Queueing happens on LIVE fresh
  DMs only, so restarts never re-queue.
- Own locked posts render `visibility: 'private'` via a store-backed
  uuid set (non-derivable — which channel a post went to isn't in the
  text — survives migrate like pins).
- **Local leak guards shipped WITH part 1** so "Followers" isn't a false
  promise: backfill serving refuses locked posts, and boosting one's own
  locked post 422s. The remote/receiver-side surfaces (envelope
  visibility marker, thread-channel gating, reply-privacy inheritance,
  revocation) are DEFERRED, explicitly, to
  meta/issues/visibility-leak-prevention.md.
- Relay integration test: B requests + is approved into the locked
  channel and sees both tiers; C (public-only) provably never receives
  the locked post; A's follower/post counts aggregate both channels
  deduped.

## 2026-07-07 — search

`GET /api/v2/search` exists now — the frontend's search page and header
search were fully built and calling it all along (returning nothing).
Zero frontend changes needed.

- **Users we know about, through whatever way**: every contact row core
  holds — including KEYLESS address rows (search is discovery, not
  deliverability, unlike the mention autocomplete which stays
  key-contacts-only). Deduped by address preferring the key row, ranked
  petname > their name > address (`rankedContactSearch`).
- **Posts we know about**: core's own full-text `searchMessages` across
  all chats, filtered through `isSearchableContent` (posts/replies/boosts
  only — reaction/invite/backfill control DMs never surface), with a
  reply's feed + DM copies collapsed onto the store-preferred copy; PLUS
  verified held envelopes (content we never received directly) matching
  the query, rendered through the existing verify-at-render `heldStatus`
  ladder as `orig-<uuid>` statuses — tampered held content never surfaces.

## 2026-07-07 — mention autocomplete + addressing

Typing `@` in any composer now autocompletes over people you know — matched
and ranked by petname first, then their name, then address — and mentioning
someone ADDRESSES them: the same signed envelope is DM-copied to every
mentioned key-contact, so the post reaches them even when they don't follow
the poster, and they derive a `mention` notification. Body mention tokens
render as names ("@carol"), full address as tooltip.

Design + findings (meta/issues/mention-addressing-autocomplete.md):

- **Wire format: `@local@domain` tokens in the plain body, nothing else.**
  The body is inside the signed canonical payload, so mentions are signed by
  construction — no envelope field, no dn4 bump, no downgrade surface. Both
  ends parse one pure grammar (`parseBodyMentions`); what gets delivered and
  notified is exactly what renders.
- **The composer's autocomplete had been silently dead**: it called
  `GET /api/v1/accounts/search`, which didn't exist — every keystroke 404'd
  into an empty popup. The endpoint now serves ranked known key-contacts
  (`rankedContactMatches`, pure) from a full `getContacts` listing.
- **Delivery = the reply-DM-copy mechanism generalized**: after posting,
  each mentioned addr resolves via `keyContactIdForAddr` and gets the
  verbatim wire text; the reply parent/root and SELF are skipped (they
  already get copies). Notification derivation dedupes by post key, so the
  feed copy and DM copy collapse, and a reply-to-me that also mentions me
  stays ONE notification.
- Two live-relay traps: mention grammar must allow underscores in domain
  labels (`_chatmail.example`), and body-mention resolution must probe
  KEY-contacts first — `contactIdByAddr` returns address-contact rows and
  missed securejoined peers. Also the joiner side of a securejoin finishes
  after the inviter's 1000 event; tests that post immediately must wait for
  `SecurejoinJoinerProgress` too.

## 2026-07-07 — petnames

Anti-impersonation, part 1 (meta/issues/petnames.md): display names are
self-chosen, so "Carol Sparkle" proves nothing. Petnames — MY local names
for contacts — now render as chip chrome after their chosen name
("Carol Sparkle ⟦carol⟧"); a name-clone has no chip.

The big find: **DC core already implements the data layer.**
`Contact.authName` (their claim) vs `Contact.name` (my override, set via
`changeContactName`), with `displayName` preferring mine — and the override
lives on the KEY-contact row, so the petname binds to the cryptographic
identity, not the string. It also lives in dc.db, so petnames ride along in
backups for free (asserted in the restore integration test). What deltanet
added on top:

- Daemon: `pleroma.deltanet.{auth_name, petname}` on accounts (never a
  petname for SELF — its `name` is the configured displayname), mirrored on
  mention entries; `POST /api/deltanet/contacts/:id/petname` ('' clears,
  falling back to authName).
- Frontend: `PetnameChip` (chip chrome — background + tag glyph, NOT plain
  text, so a display name containing pill-lookalike characters can't pass);
  rendered in post headers (shared `PostHead`), focused posts, the reply
  footer + inline composer pill, and the profile heading, which also gets
  the set/edit-petname editor. Chip-rendering spots lead with `auth_name`;
  everywhere else keeps displayName (= the petname when set), which is safe
  — an attacker can't fake MY override.
- Subtlety: the petname endpoint's account payload carries no relationship,
  so profile state merges only the name fields back — re-adapting wholesale
  would reset followState to 'stranger'.

Part 2 (key-derived identity badge) stays filed separately.

## 2026-07-07 — reply pill shows the chosen name

The "Replying to" pill showed the address local part — a chosen nickname on
the fediverse, but a random registration string on chatmail. Both renderings
now lead with the author's chosen display name ("Carol Sparkle"), full
address demoted to the chip tooltip:

- The daemon ships a NON-STANDARD `display_name` on status mentions (built
  from the parent message's sender contact, which it always had in hand);
  decision 0001 applies — the API is ours, vanilla clients ignore the field.
- Frontend: `addresseeNames` (handle → name, both `@user` and `@user@host`
  key forms, mirroring `mentionAcctMap`) flows adapt → Post* → PostBody →
  PostPinged; the inline reply composer already had `targetName` plumbed and
  just never rendered it. Fediverse statuses without mention names keep the
  handle fallback. Gotcha for next time: the app page's post re-map
  (`+page.svelte` ~line 600) is a field-PICKING copy — a new view-model field
  silently vanishes unless added there too (caught by the route-level e2e
  after the adapter unit test was already green).

Companion issue filed for later: mention addressing + display-name
autocomplete in the composer (meta/issues/mention-addressing-autocomplete.md
— wire format, delivery semantics, and notification questions noted there).

## 2026-07-07 — backup & identity survival (.dnbk export/restore)

The data dir is the identity and the relay retains nothing, so losing the disk
meant ceasing to exist. Now: Settings has a Backup card (passphrase → encrypted
`.dnbk` download + last-backup nag), and the landing page offers
restore-instead-of-signup. Closed `meta/issues/backup-second-device.md`; the
second-device QR pairing stretch (`provideBackup`/`getBackup`) stays unfiled
until wanted.

Key findings/decisions:

- **Core's backup is NOT the whole identity.** `exportBackup` covers dc.db +
  blobs, but `deltanet-signing-key.json` (ed25519 attestation key — followers
  TOFU-pin it; non-recoverable) and `deltanet-store.json` (held envelopes,
  pins, thread chatIds — non-derivable) live outside it. The `.dnbk` container
  (src/backup.ts) packs an AES-256-GCM-encrypted sidecar (scrypt of the same
  passphrase) ahead of core's tar: `"DNBK1\n" | u32BE len | sidecar | tar`.
  The GCM tag doubles as an early wrong-passphrase check, so a bad passphrase
  422s before any state is touched.
- **`ImexFileWritten` races the RPC response.** A listener scoped to the
  `exportBackup` call can miss the event (it arrives on the event channel,
  observed live against the podman relay). The tar's path is resolved by
  scanning the scratch dest dir after the RPC resolves instead.
- **Live-restore seams.** The store and attestor are lazy file-backed caches;
  both grew `reload()` so a restore under a running daemon takes effect
  without a restart (the restored attestor key must sign the next post or
  followers' pins break — asserted end-to-end in the integration test, which
  does export → wipe the whole data dir → restore → B verifies a post-restore
  post under its pre-wipe pin).
- **`restoreTransport`** shares the whole transport surface with
  `openTransport` via an extracted `buildTransport`; it imports the tar, reads
  addr/password/displayname back out of config (`credsFromConfig`), and main.ts
  persists them to the accounts file so later boots are ordinary.
- **Core refuses a non-empty data dir** (`"<dir>" is not empty`, immediate
  exit) when no accounts structure exists yet — so the sidecar files can NOT
  be written before the restore starts, which was the first implementation.
  Worse, the child's death surfaces as a swallowed "Server quit" throw and the
  pending RPC call hangs forever (12 min of nothing until sampled the process
  and reproduced the spawn by hand). The sidecar write now runs as a
  `beforeOpen` hook INSIDE `restoreTransport` — after `importBackup` created
  the account structure, before `startIo`/ingestion — which is also exactly
  the window that kills the ingest-vs-restored-store race.
- **Content-Disposition needs CORS exposure** (not safelisted) or a
  cross-origin frontend can't read the backup filename.

## 2026-07-07 — whole-code security/QA review, hardening, CI

A pass over the whole daemon (crypto trust boundary, backfill/thread-channel
abuse surface, HTTP API) plus fixes for what it surfaced, regression tests, and
GitHub Actions.

Trust boundary came back clean: relayed/held/embedded content only ever renders
attributed after `verify()` passes; TOFU pins are written only from direct
deliveries (never relayed content); introduction is user/self-triggered only,
gated on `checkQr` kind + a post-join address check. Fixed four real issues:

- **Unbounded held-envelope growth (HIGH).** Held envelopes are not
  request-gated (unsolicited bundles, proactive thread-so-far / channel
  bundles), so a met contact could push signed junk without limit. Added a
  `HELD_ENVELOPE_CAP` (5000) with oldest-by-`receivedAt` eviction; a re-opened
  thread simply re-backfills anything dropped. Cap is injectable via
  `createStore(path, { heldEnvelopeCap })` for fast tests.
- **Republication without re-verify (MED, defense in depth).** The thread host
  broadcast a reply into its channel checking only that a signature was
  *present*. Now `republishReplyToThread` calls `verify(env, msg.sender.address)`
  before posting (and before burning the dedupe slot), so a tampered/forged
  reply is never amplified to subscribers.
- **`in_reply_to_id` 500 (QA).** A non-numeric, non-`orig` reply target fell
  through to `Number(NaN)` -> `transport.message(NaN)`. Now a clean 404 via
  `parseStatusId`.
- **Header route missing Content-Type (QA).** The SELF custom-header response
  now sets `contentTypeForPath(headerPath)` instead of defaulting to
  octet-stream.

Confirmed-safe-and-left-alone (documented for future readers): boost/held
`authorAddr` is attacker-influenced but any wrong addr fails `verify()` and
drops the entry (no mis-attribution); the unsigned `invite` field is
self-authenticating; per-peer serve rate-limiting is bypassable only by minting
real relay identities (substrate-inherent); other unbounded maps
(`republishedUuids`, `pendingThreadRequests`) grow only under host/user action.

Regression cover: new `tests/integration/embed-interactions.test.ts` -- C
favourites + boosts a post it holds only via backfill; A tallies the favourite,
the boost re-embeds A''s signed envelope verbatim and verifies. Unit suite 1050;
full integration 13/13.

CI: `.github/workflows/ci.yml` runs daemon typecheck+unit and frontend
typecheck+Playwright on every push/PR. Integration stays local (needs podman).

## 2026-07-07 — embed-only interactions: act on posts you never received

Issue `meta/issues/interact-with-embed-only-posts.md`, the last "can't interact
with someone" gap. orig-<uuid> statuses (held envelopes, verified boost embeds)
are now actionable: favourite/reactions tally under the uuid post key locally
and DM the author (authoritative side) with introduce-on-need in the background;
replies thread by uuid ref and inherit the signed root; boosts re-embed the
author-signed envelope VERBATIM — attestations make second-hand boosts sound
with no trust chain. All actions gate on VERIFICATION (tampered/unverifiable →
404, nothing sent). Live-verified across nodes: a favourite on a backfilled
held envelope reached the author as a real tallied favourite + notification.

## 2026-07-07 — in-band introduction: content carries the author's contact invite

Issue `meta/issues/in-band-introduction.md`. Closes the substrate's last
reachability gap: there is no cold 1:1 send (securejoin or a received message is
the only key path), which blocked stranger-subscribes and the deep-replier root
copy. Content envelopes now carry the author's multi-use CONTACT invite link —
UNSIGNED by design: securejoin links are self-authenticating, and the joiner's
mandatory post-join address check (implemented as "poll until an e2ee-capable
key-contact for the EXPECTED addr exists") is the authenticator, so no dn4
canonical bump and invites stay rotatable. `introduceViaInvite` refuses any QR
kind but `askVerifyContact` (a smuggled broadcast invite cannot join us to
anything), and introductions run only on EXPLICIT need — user-triggered
subscribe (inline) and our own outgoing root copies (background,
negative-cached) — never from ingest. Integration proves the full stranger
arc over the real relay: C, who never met A in any way, backfills A's root via
B, securejoins A through the invite it carries, subscribes, receives A's next
reply via the thread channel, and C's own deep reply root-copies to A — the
cold-DM gap documented in wire-thread-root-ref heals.

## 2026-07-07 — live-QA fixes: DC transient text suffix; mixed-era ancestor climb

Two bugs from live QA, one shared root cause discovered. (1) While an attachment
is still downloading, DC core's `msg.text` can transiently carry its
file-placeholder summary appended to the real body (`{...} [Image – 137.37 KiB]`);
the persisted text is clean afterwards. The trailing junk broke `parseEnvelope`,
which (a) rendered raw JSON in the live-streamed status frame and (b) — worse,
persisted — made `parseWireUuid` fail at ingest, mis-keying the message under its
canonical MID instead of its uuid, so its reaction tallies (uuid-keyed by the
send path) never rendered even though the author received them. Fix:
`parseEnvelope` now recovers the LEADING balanced JSON object (string/escape-aware
brace scan) and ignores trailing junk; leading junk still fails. Store schema
v8 (no shape change) forces the derived-index re-index so already-mis-keyed
messages re-key from their clean stored text — verified live: the damaged
message re-keyed on boot and the stranded favourite appeared.

(2) The context endpoint's ancestor climb (introduced with thread-auto-backfill)
broke at the uuid→mid era boundary: a v2 reply whose parent chain crosses into
legacy mid refs stopped climbing, so /thread/<deep-reply> showed fewer ancestors
than /thread/<its-parent>. Replaced the split uuid-loop + legacy-fallback with
ONE climb by post key (uuid or mid), crossing local ↔ held ↔ legacy freely.
Verified live: the previously truncated thread renders its full chain.

## 2026-07-07 — thread subscribe: per-thread channel hosted by the root author

Issue `meta/issues/thread-subscribe.md` (design-sketch #3, layers 2–3). Auto-backfill
heals history reachable through your peers; explicit subscription covers a thread's
FUTURE and branches no peer touched. A "Subscribe to thread" action DMs the root
author a SCOPED invite-request; the root's daemon lazily hosts a per-thread broadcast
channel, auto-grants + sends the thread-so-far bundle, and REPUBLISHES incoming replies
into the channel. Subscribers join it as a THREAD subscription (never a followed feed)
and admit its bundles through the existing held-envelope ingest.

### Protocol (extends existing invite types — old nodes degrade gracefully)

- `invite-request`/`invite-grant` gain an OPTIONAL `scope: { thread: 'u:<root-uuid>' }`
  (`envelope.ts`). ABSENT = the existing FEED follow-back flow, UNCHANGED (regression
  tests assert both parsers still fire, and that an old node reading a scoped envelope
  sees a plain request/grant → degrades to a feed follow-back). Scope parsed TOLERANTLY
  (`threadScopeRootUuid`): a malformed/unknown scope → null → treated as unscoped.
  `wire.ts` gains `parseWireThreadInviteRequest`/`parseWireThreadInviteGrant`.
- Republication + thread-so-far REUSE the `envelope-bundle` + held-envelope machinery
  from thread-auto-backfill (no second relay format; verbatim signed envelopes only, 0002).

### New modules

- **`src/thread-collect.ts`** (pure): `collectThreadUuids` — root + descendant uuids over
  the store's reply graph (local `replyChildMids` ∪ held `heldChildrenOf`), the thread-
  so-far membership set. Bounded.
- **`src/thread-subscribe.ts`** (ingest wiring + pure helpers, mirrors backfill-ingest.ts):
  - `handleThreadInviteRequest` (HOST): only for a thread whose ROOT we hold; lazily
    `createBroadcast` + persist the binding (once); auto-grant a scoped invite-grant to
    the requester's message-derived id (reachable by construction — the request just
    arrived); DM the thread-so-far via `buildServeBundles` over `collectThreadUuids`.
  - `republishReplyToThread` (HOST): a fresh FEED reply whose SIGNED `root` ∈ hostedThreads
    → wrap its OWN signed envelope verbatim in an `envelope-bundle`, `postToChat` the
    channel. Signed-only (never fabricate); OMIT is moderation. Dedupe via
    `store.wasRepublished(uuid)` so feed+DM copies / restart never double-post.
  - `handleThreadInviteGrant` (SUBSCRIBER): a SOLICITED scoped grant (gated on
    `hasPendingThreadRequest`, like feed follow-backs) → `follow()` + record a THREAD
    subscription; pending cleared even on join failure.
  - `handleThreadChannelBundle` (SUBSCRIBER): a bundle on a REGISTERED thread-subscription
    chat → the EXISTING `processBundle` held-envelope ingest (render-time verify, no TOFU
    pins). Never serves requests from channels.

### Store (schema v6 → v7)

Four new non-derivable roots that SURVIVE `migrate` (like pins/held envelopes — they name
out-of-band DC chats / network history a message sweep can't reconstruct): `hostedThreads`
(rootUuid→chatId), `threadSubscriptions` (rootUuid→chatId), `pendingThreadRequests`
(rootUuid→ts, the anti-unsolicited-join gate), `republishedUuids` (dedupe). Additive
fields; a v6 store gains them on load.

### Transport seams (`transport/{types,deltachat}.ts`)

`createBroadcast(name)` + `chatInvite(chatId)` (host channel creation, mirroring the feed
broadcast), `postToChat(chatId, text)` (republication), `leaveChat(chatId)` (unsubscribe =
`blockChat`, same mechanism as unfollow), and **`keyContactIdForAddr(addr)`** — the honest
reachability probe: queries `getContacts` by addr and returns an id ONLY for a row with
`e2eeAvail` (a KEY-contact we can actually encrypt to), else null. No cold sends.

### API + UI

- `POST/DELETE /api/v1/pleroma/statuses/:id/subscribe` (`:id` numeric or `orig-<uuid>`).
  `resolveThreadRoot` identifies the thread via the SIGNED `root` ref on a reply, else the
  target's own uuid+author when it IS the root (handles local, held, and orig ids).
  Reachability gate → 422 `unreachable_author` (no key path) / `own_thread`; NEVER a cold
  send. Statuses gain `pleroma.deltanet.thread_subscribed` (resolver `isThreadSubscribed`).
- `following()`/home timeline EXCLUDE thread-channel chats — filtered in server.ts via the
  store's `threadSubscriptions` chatId set (`followedFeeds`/`excludeThreadSubscriptionMessages`),
  NOT a transport-level hack: a thread channel is an InBroadcast like any feed, so the only
  honest discriminator is "is this chat registered as a thread subscription?".
- Frontend: Subscribe/Unsubscribe action on the thread view's FocusedPost (root status)
  via new `client.subscribeThread`/`unsubscribeThread`; optimistic toggle with revert +
  clean toast for the unreachable-author 422. State survives reload (the flag is served on
  the root status). Playwright covers subscribe→Unsubscribe and the unreachable toast.

### Streaming decision (nice-to-have)

Streaming a thread update to an open thread view is DEFERRED (minimal): channel bundles are
suppressed exactly like backfill (no streaming/notifications, held content never in
timelines), and the thread view refetches context on navigation. Live push into an open
thread view would need a per-thread streaming channel — out of scope; noted.

### FINDING — honest C→A reachability WITHOUT C following A's feed (inviter gets the key)

The integration test establishes C→A reachability by having **A follow C's FEED** (not the
reverse). Securejoin exchanges keys both ways, so C — the INVITER — ends up with a
KEY-contact for A and can encrypt the scoped invite-request, yet C is NOT a member of A's
feed. This matters: had C followed A's feed (the first attempt), A's future replies would
reach C DIRECTLY, and the channel republication would be redundant (the held-envelope ingest
also refuses to overwrite the local copy, so the assertion `heldEnvelope(reply)` would even
stay null). With A→C instead, A's NEW deep reply reaches C ONLY through A's thread channel —
the load-bearing property (`resolveKey(reply)` is null on C; only `heldEnvelope(reply)` is
set). Because A is both root and host, A republishes its OWN reply too; a self-authored feed
post never re-arrives via the ingest hook (no IncomingMsg for own sends), so republication
is ALSO triggered at post time in the reply endpoint (dedupe makes it idempotent with the
received-reply ingest-hook path). `resolveThreadRoot` handles the `orig-<uuid>` subscribe
target whether A's root is held (backfilled) or, in other topologies, held locally.

### Tests

`pnpm test` (1028 unit, was 952): new `thread-subscribe-envelope` (scope round-trip +
unscoped regression + tolerant parse), `thread-subscribe-store` (round-trip + migration),
`thread-subscribe` (collect, host grant/channel-reuse/thread-so-far, republish
verbatim/dedupe/omit/feed-only, subscriber solicited-join/unsolicited-ignore, channel-
bundle admit/reject/self-echo-idempotent), `server.test.ts` +9 (endpoint reachable/422/
own/unsubscribe/flag/404 + following+timeline exclusion), `followback.test.ts` +3
(scoped requests are NOT feed follow-backs). Integration
`thread-subscribe.test.ts` green over the podman relay (~52s test): A follows C's feed for
an honest key path (C is the inviter → C gets A's key without following A), C backfills A's
root, subscribes via `orig-<rootUuid>`, joins A's channel; A's NEW deep reply reaches C
ONLY via republication (held, not local) — home timeline + notifications suppressed;
unsubscribe stops updates. Full daemon integration suite (9 files / 11 tests) green.
Frontend `pnpm test` (317 Playwright) + `pnpm check` green with the Subscribe/Unsubscribe
button + unreachable-toast covered.

## 2026-07-07 — thread auto-backfill: heal dangling ancestors from the peer who showed them

Issue `meta/issues/thread-auto-backfill.md` (design-sketch #3, layer 1). The QA
case: alice↔bob talk a thread; carol follows only bob, so she holds bob's half
with reply refs dangling at alice's posts. Her daemon now heals these
automatically — on ingest of a message whose reply/boost/root ref doesn't
resolve, it asks the SENDER (who provably holds the target — you can't reference
what you never held) for the signed envelope, stores it as a HELD envelope, and
renders it into thread views verified + attributed. No boost involved.

### New protocol (v2 control envelopes)

- `envelope-request` (`{refs:[{u,addr}...]}`) — unsigned control DM, a batch of
  uuid refs (cap 50). `envelope-bundle` (`{envs:[<signed envelope>...]}`) — the
  reply, SIGNED content envelopes embedded VERBATIM (same rule as a boost
  `orig`; never fabricated, unsigned/legacy omitted — omission always valid,
  0002). Both added to `EnvelopeType` + `parseEnvelope`. Mixed-era: an old node's
  `parseEnvelope` doesn't know these types → returns null → the DM degrades to
  plain text, invisibly ignored (verified: unknown type → null).

### New modules

- **`src/heldenvelopes.ts`** (pure): `danglingTargets` (a message's unresolved
  uuid refs + peer=sender + author addr from the ref), `heldDanglingTargets`
  (transitive refs of a held envelope), `storableBundleItem` (signed-content
  gate), `verifyHeld` (render-time ladder: `verify()` + TOFU-pin consistency,
  reusing the EXACT boost-embed seam, minus media — media isn't bundled).
- **`src/backfill.ts`** (auto-fetch loop): `createBackfiller` — per-peer batching
  with a flush delay, global rate cap (4 req/min, a slice of the 60/min relay
  budget so user actions never starve), in-flight dedupe, exponential backoff
  (1m·4^n, give up after 5 attempts) via a persisted negative cache, and a
  per-peer transitive round bound (10). Pure scheduling helpers
  (`nextEligibleAt`/`isEligible`/`chunkRefs`/`remainingBudget`) unit-tested
  directly.
- **`src/bundle.ts`** (pure serve side): `servableEnvelope` (verbatim signed-only)
  + `chunkBundles` (~100KB cap, oversized item ships alone, never dropped).
- **`src/backfill-ingest.ts`** (ingest wiring): `enqueueDangling`,
  `buildServeBundles` (serve from a local msg body OR a held envelope we relay),
  `processBundle` (validate → `addHeldEnvelope` → mark resolved → re-chase
  transitive refs), `handleBackfillControlDm` (serve/process, DM-only, per-peer
  serve rate-limit 10/min), `seedBackfillQueue` (startup seed from held state).
  Returns `true` for a backfill control DM so the caller SKIPS the notification/
  streaming tail.

### Store (schema v5 → v6)

Two new sections, both NON-derivable roots that SURVIVE `migrate` (like
pins/notifications): `heldEnvelopes` (uuid → `{env, from, authorAddr, receivedAt}`
— verbatim foreign content + the author addr from the surfacing ref, needed for
`verify()`) and `backfillAttempts` (uuid → `{attempts, lastAttemptAt}` — the
negative cache). Additive fields, so a v5 store gains them on load; the version
bump forces the derived-index re-index that seeds the queue from pre-existing
dangling refs. `addHeldEnvelope` never overwrites a local resolution or an
existing held entry, and NEVER TOFU-pins (bundles are relayed content).
`heldChildrenOf` computes the held reply graph off stored refs (held content has
no `replyChildren` edge to re-derive).

### Render integration (server.ts + mapping.ts + entities.ts)

- `resolveOrigStatus` gains a held-envelope step (local → HELD → boost-embed
  walk): `mapper.heldStatus(uuid)` verifies at RENDER (pins can change) through
  the exact ladder, drops the entry on hard failure, and renders `orig-<uuid>`
  with contact-first attribution.
- The **context endpoint** now traverses held envelopes exactly like local
  messages: the ancestor climb crosses freely local↔held by uuid, and the
  descendant BFS unions `replyChildMids` (local) with `heldChildrenOf` (held).
  Carol's thread of bob's reply surfaces alice's held posts as real, verified,
  attributed statuses. A tampered held ancestor renders nothing and stops the
  climb (no placeholder for ancestors).
- New `heldEnvelopeToStatus` (entities.ts) renders a held envelope as a
  thread-participating status WITH `in_reply_to_id` (unlike a boost's leaf embed)
  so the thread links; new `StatusResolver.heldOrigId` lets a LOCAL reply to a
  backfilled parent link via the parent's `orig-<uuid>`.

### Suppression (enforced structurally)

Held-envelope ingest + bundle processing create NO notifications and NO streaming
events, and held envelopes NEVER enter home/public timelines — they exist for
thread views + status fetch only (other people's backfilled history). Enforced by
construction: the backfill paths only call `addHeldEnvelope`/the backfiller/the
bundle send, none of which touch the notification store, the streaming hub, or the
timeline read path; control DMs are `isFeedMessage:false` (never streamed as
updates) and `handleBackfillControlDm` returning `true` makes the ingest hook skip
the notification/stream tail.

### Media deferral

Media is NOT bundled (per the issue): a backfilled post with media renders with
its alt text (federated `media.description`) and no attachment. The author-signed
`media.sha256` stays in the held envelope so a later per-item verified fetch can
re-attach + verify the bytes — that lazy fetch is OUT of scope here and folds into
the interactions follow-up.

### FINDING — key-contacts vs address-contacts: addr lookups yield keyless rows

The first integration run failed with `e2e encryption unavailable` on the C→B
request DM and looked like a substrate wall ("a broadcast follower has no 1:1
key relationship with the feed owner" — `e2eeAvail:false, isKeyContact:false` on
the probed contact). That diagnosis was WRONG; the real lesson is a DC core 2.x
contact-model distinction:

**Core keeps KEY-contacts and ADDRESS-contacts as separate rows.** A key-contact
is derived from securejoin or a received message and is e2ee-capable. An
address-contact — what `createContact`/`lookupContactIdByAddr` (our
`ensureContactIdByAddr`/`contactIdByAddr`) return — is KEYLESS
(`e2eeAvail:false`), and sending to it fails with "e2e encryption unavailable"
EVEN WHEN a key-contact for the same address exists. The original send path
resolved the peer BY ADDRESS and landed on the keyless row; the probe then
"confirmed" the wall because it, too, probed the address-resolved row. Every
DM send that works in this codebase (the reply copy, the follow-back grant)
targets a MESSAGE-DERIVED id (`target.sender.id` / `msg.fromId`) — never an
addr lookup.

Fix: the backfill queue carries the dangling-ref message's SENDER CONTACT ID
(`QueuedRef.peerContactId`, captured from `msg.fromId` at enqueue; persisted as
`HeldEnvelope.fromContactId` for transitive/startup follow-ups), and
`sendControlDm` targets that id; the addr remains only a dedupe/label/
negative-cache key. The serve side was already correct (replies via the request
DM's own `fromId`). With this, the FULL round-trip delivers over the real relay:
C's request DM reaches B, B's bundle DM reaches C, C's thread renders from
actually-delivered bundles — no in-process bridging, in a broadcast-only
topology (C never 1:1-introduced to B beyond following his feed).
`ensureContactIdByAddr`'s doc comment (transport/types.ts) now records the
distinction. The wire-thread-root-ref cold-DM finding STANDS unchanged — that
case is genuinely cold (no securejoin ever happened between C and A, so no
key-contact exists to target).

### Tests

`pnpm test` 952 (was 773): new `backfill-envelope`, `backfill-store` (held
round-trip + migration survival + never-pin-from-bundle), `heldenvelopes`
(dangling/transitive detection, storable gate, verify ladder incl. tamper +
pin-conflict), `bundle` (verbatim-only + chunking), `backfill` (batching/dedupe/
in-flight/rate-cap/backoff/negative-cache/rounds/attribution + send targets the
message-derived contact id), `backfill-ingest` (enqueue, serve
verbatim+signed-only+omit, bundle receipt + transitive + no-overwrite +
tampered-sibling-survives, serve rate-limit, suppression),
`backfill-thread-render` (resolveOrigStatus held path, context ancestor/descendant
held traversal, tampered held ancestor renders nothing, timeline suppression).
`pnpm check` green. Integration `thread-auto-backfill.test.ts` green with REAL
end-to-end delivery over the podman relay (~18s test): C's request DM → B's
bundle DM → complete verified thread in C's context, no notifications, A absent
from C's home timeline. Full integration suite green.

## 2026-07-07 — signed thread-root ref on replies + root DM copy

Issue `meta/issues/wire-thread-root-ref.md` (prereq for thread auto-backfill +
subscribe, sketch #3 revised). A reply now carries a signed `root` ref (the
thread's topmost post) so any holder of a mid-thread message can name the thread
+ owner, and reply DM copies now also reach the ROOT author (not just the
parent) so the root accumulates the full thread by construction.

### Changes

- **`daemon/src/envelope.ts`**: `Envelope` gains optional `root?: EnvelopeRef`
  (same shape as `ref`). `buildReplyObject`/`buildReplyEnvelope` carry it (set
  only on replies, only when known). `parseEnvelope` TOLERANT-DROPS a malformed
  root (missing/empty/non-string `u`, non-string `addr`) to absent — junk roots
  never reach verification, and the empty-key-string graft (an absent root and
  an empty `u` would frame identically as `0:`) can't ride a signed root-less
  envelope.
- **`daemon/src/attest.ts`**: `CANONICAL_PAYLOAD_VERSION` → `dn3`.
  `CanonicalFields` gains `rootToken` (the root ref's key string) AND `rootAddr`
  (the root ref's author address), each its OWN frame, each empty when absent,
  directly after `refToken`:
  `lp(dn3) … lp(refToken) lp(rootToken) lp(rootAddr) lp(mediaSha256)`.
  The addr is SIGNED because — unlike `ref.addr`, a display-only attribution
  fallback — `root.addr` is a ROUTING target: it decides who receives the root
  DM copy today and whom a subscriber contacts in thread-subscribe; unsigned, a
  relayed envelope (boost embed now, backfill bundles next) could swap it to an
  attacker's address while still verifying. Separate frames (never concatenated
  into rootToken): self-delimiting frames are the point of the length-prefix
  design. ONE framing impl parameterized by a `{version, withRoot}` layout so
  dn2/dn3 never drift. `sign()` emits dn3 only. **`verify()` gains a dn2
  fallback**: try dn3 first; if it fails AND `env.root === undefined`, retry the
  OLD dn2 layout (version string `dn2`, no root frames). Downgrade-safe because
  the version string is inside the signed bytes — a dn3 sig can't verify as dn2
  or vice versa, and a dn2 envelope can never grow a forged root (dn3 signs the
  root token + addr; the dn2 fallback is gated on root ABSENCE). An omitted root
  is always valid; a present root is dn3-only. `verify()` additionally rejects a
  present root failing the shared `isWellFormedRootRef` predicate (exported from
  envelope.ts) BEFORE any payload work: parser sanitization can't reach NESTED
  envelopes (a boost `orig`, future bundle items), and the trivial graft
  `{u:''}`/`{u:'',addr:''}` frames as `0:0:` — byte-identical to an absent root —
  so a root-less dn3 sig would otherwise verify with junk `.root` attached.
  Signers never emit malformed roots, so the gate rejects only grafts. verify
  stays never-throwing, canonicalPayload pure/total.
- **`daemon/src/server.ts`** (reply branch): `deriveRootRef(transport, parent)`
  — best-effort, never fabricated: (a) reuse the parent reply's own `root`
  verbatim; (b) else a non-reply parent WITH a uuid IS the root; (c) else walk
  locally-held ancestors (same resolveKey/parseWire climb the context endpoint
  uses, bounded) and apply (a)/(b) to the topmost held message; unknowable →
  omit. The derived root is set BEFORE signing. After the parent-author DM copy,
  a **root DM copy** goes to the root author when known, distinct from the parent
  author and not SELF, via a new transport method (below). BEST-EFFORT: failure
  logs + is swallowed; the reply, feed post, and parent copy never fail.
- **`daemon/src/transport/{types,deltachat}.ts`**: new `ensureContactIdByAddr`
  (core `createContact`, idempotent) so the root copy can address a never-met
  root author; `contactIdByAddr` stays lookup-only.
- **`daemon/src/wire.ts`**: `ParsedWire` gains `root?: MsgRef`, surfaced from a
  v2 reply envelope's `root` (normalized like `reply`); legacy markers never
  produce it. Consumed by the backfill issue later.

### FINDING — cold root DM does not deliver on the local relay

The integration test (`tests/integration/thread-root-ref.test.ts`, topology
A←B←C where C has NEVER met A) proves C's reply carries `root` = A's post
(uuid + addr) on the wire — the load-bearing property. But the **cold root DM
copy to A fails at the DC core level**: `e2e encryption unavailable`. The only
key-exchange path in the substrate is securejoin (invite links carry the PGP
key); A's Autocrypt key never gossips to C (A is not a member of B's feed), and
`createContact` alone gives core no key to encrypt to. The issue's premise that
"chatmail serves keys for first-contact encryption" does not hold on this relay
— there is no cold-first-contact send path in the codebase today (the follow
flow is securejoin; the invite-request follow-back only DMs already-known
contacts). Per the issue's explicit instruction, I did NOT weaken the topology
(no pre-introducing C→A) to force delivery: the copy is best-effort, the failure
is logged + swallowed, and the reply/feed/parent copy all succeed. The
integration test documents this and hard-asserts the wire root ref; the cold-DM
assertions run only if a relay DOES serve the cold key. Unblocking the DM
copy needs a substrate key-fetch/gossip path (candidate for the backfill issue).

## 2026-07-07 — orig-<uuid> thread view (clicking a verified boost embed)

Fix (`meta/issues/orig-status-thread-view.md`): clicking a verified boost
embed navigated to `/app/thread/orig-<uuid>`; the daemon's status + context
handlers did `Number(id)` → NaN → `transport.message(NaN)` threw → 500. Now
these ids resolve honestly, and every `/statuses/:id` route is hardened.

### Changes (`daemon/src/server.ts` only)

- `parseStatusId(raw)`: one shared helper turning the opaque `:id` param into a
  discriminated union — all-digits → `{ kind:'msg', msgId }`, `orig-<uuid>` →
  `{ kind:'orig', uuid }`, anything else / empty → `null`. Replaces the
  scattered `Number(id)` calls so a non-numeric id is a clean 404, never a 500.
- `resolveOrigStatus(transport, uuid)`: (1) if we hold the original locally
  (`store.resolveKey(uuid)`), return the REAL local status; (2) else walk the
  boost index (`store.boostsByMid(uuid)`) for a held boost whose embedded
  `orig` verifies — `toStatus` runs the SAME ladder as the timeline (sig + pin
  + media hash + contact-first attribution) and yields a status whose `.reblog`
  IS the verified embed; return that nested reblog (id `orig-<uuid>`); (3) no
  verifiable candidate → `null` → 404. No verification is reimplemented.
- `GET /statuses/:id`: numeric → existing path; `orig-<uuid>` →
  `resolveOrigStatus`; else 404.
- `GET /statuses/:id/context`: for `orig-<uuid>` ancestors are `[]` (we hold no
  original to climb from) and the descendant BFS roots at the uuid post key, so
  DM reply copies we DO hold still render — mapped exactly like the numeric
  path; unresolvable / unknown → empty arrays. Numeric path unchanged.
- Action routes (reblog / unreblog / favourite / reactions): all now take the
  local msgId via `parseStatusId` and 404 on any non-numeric id (an action on
  an `orig-*` post has no local target — making interactions work via uuid refs
  is a separate future issue, per the spec).

### Frontend

No change needed. Status ids are already opaque strings end to end: the thread
route (`/app/thread/<id>`), `threadHref` (`encodeURIComponent(statusId)`), and
the whole e2e suite drive non-numeric ids (`status-1`) with empty context. An
`orig-<uuid>` id is structurally the same, so the frontend renders it as-is.
Frontend suite not run (untouched).

### Tests

`daemon/tests/server.test.ts` +14 (739 total, was 725): verified-embed fetch
with contact-first attribution, locally-held original → real status, unknown
uuid → 404, non-numeric id → 404 (no 500); orig context empty vs. resolvable
reply children; and the action-route hardening matrix. `pnpm test` +
`pnpm check` green. Integration suite not run.

## 2026-07-07 — verified boost embeds honor known contacts

Fix (`meta/issues/verified-embed-known-contact.md`): a verified boost embed
(bob boosts carol; lain follows bob not carol) was always attributed via the
bare `addrToAccount` shell (id `0`, `?`-avatar, local-part name) — even when
the recipient HAD met the author and holds a real DC contact for them. Contact
profile (name/avatar) arrived over the core-PGP-verified transport from the
author, so using it is not a 0002 violation; the shell was only ever for
addresses we've truly never seen.

### Changes

- `entities.ts`: `verifiedEmbedToStatus` gains an optional pre-resolved
  `account` param (and `messageToStatus` an `embedAccount` param that threads
  it); `account ?? addrToAccount(addr, baseUrl)`. Stays pure / transport-
  unaware. Only the `account` object enriches — nested identity (`orig-<uuid>`
  id, `orig.ts` created_at, zero counts) is untouched. Verification ladder
  (sig/pin/media-hash) untouched.
- `mapping.ts`: `toStatus` resolves the embed author via
  `contactIdByAddr` + `contact` (contact-first, addr-shell fallback — same as
  the notification path) and passes `embedAccount`.

### Cache choice

The per-msgId `embedCache` still caches ONLY the verification VERDICT
(`BoostEmbed`). The account is resolved FRESH on every render (outside the
cache), so a `?`-shell rendered before the contact existed is never pinned
forever — if the contact appears later, the next render picks it up. This is
the simplest correct option (no cache invalidation logic needed) and keeps
contact freshness identical to every other contact render.

### Tests

- Unit (726, was 725): NEW `boost-embed.test.ts` case — verified embed with a
  resolvable contact renders that contact's display name / avatar / id, and
  asserts nested identity (orig-<uuid> id, orig.ts created_at, zero counts)
  is unchanged. All existing shell/tamper cases stay green.
- `pnpm test` + `pnpm check` green in daemon/. Integration suite not run
  (unnecessary for this change; C-truly-never-met-A shell path unaffected).

## 2026-07-06 — project start

Goal: Pleroma-like single-user backend, Mastodon client API in front,
Delta Chat/chatmail federation behind. Test frontend: PleromaNet.

### Decisions

- **Transport via `@deltachat/stdio-rpc-server` + `@deltachat/jsonrpc-client`
  (v2.53.0)** — prebuilt core binary, typed JSON-RPC client. We don't touch
  SMTP/IMAP/Autocrypt ourselves at all.
- **Feed = broadcast channel, follow = securejoin invite link.** Verified by
  integration test: `createBroadcast` + `getChatSecurejoinQrCode` +
  `secureJoin` works on core 2.53 — followers get a read-only `InBroadcast`
  chat. (Original plan was symmetric group chats as fallback; not needed.)
- **IDs**: Mastodon status id = DC message id (per-account integer, decimal
  string; monotonic so max_id/min_id pagination works). Account id = DC
  contact id. Fine for single-user; revisit if multi-account.
- **OAuth is auto-granted**: `/oauth/authorize` immediately redirects back
  with a static code; any Bearer token is accepted. The daemon is
  single-user and binds to localhost — authenticating yourself to yourself
  adds nothing yet.
- Accounts registered on nine.testrun.org (chatmail testing relay) via
  `POST /new`. Credentials live in gitignored `accounts.local.json`.

### Findings

- Full federation round-trip (register → invite → securejoin → post →
  E2E-encrypted delivery) over nine.testrun.org takes ~9s end to end.
  Securejoin handshake itself completes in a few seconds when both sides
  are online.
- The transport layer has no unit tests (network-bound by nature); it is
  covered by `tests/integration/federation.test.ts` instead. TDD applies to
  the mapping + API layers, which take the transport behind an interface.
- First `IncomingMsg` after a join can be a securejoin system message, not
  the followed feed's post — consumers should filter/poll, not assume.

### End-to-end result (same day!)

PleromaNet signs in against the daemon (OAuth auto-grant → token →
verify_credentials), renders the home timeline, and posting from the
composer delivers over chatmail to followers. Ran two daemons (alice :4030,
bob :4031, separate testrun.org accounts), followed each other via
`/api/deltanet/invite` + `/api/deltanet/follow`, posts flow both ways.

Surprises / follow-ups:

- **Followers received posts made *before* they followed** — the core seems
  to re-deliver recent broadcast history to new members. That's the backfill
  problem solved for free; verify the mechanism and its limits.
- `parentId` is sometimes set on plain broadcast messages (saw a post with
  `in_reply_to_id` pointing at a securejoin system message). May need to
  suppress in mapping unless it's a real reply.
- SELF contact's `displayName` is a placeholder ("Me") — worked around by
  reading the `displayname` config in `transport.self()`. The UI shows "Me"
  as the account name otherwise.
- PleromaNet requires node 24 (mise); run it with `mise exec -- pnpm dev`.

### PleromaNet API surface (from code survey)

Hard requirements: `POST /api/v1/apps`, `GET /oauth/authorize`,
`POST /oauth/token`, `verify_credentials`, `GET /api/v1/timelines/home`
(+`Link` pagination header), `GET /api/v2/instance`, `POST /api/v1/statuses`
(form-encoded). CORS for the vite origin. Streaming websocket is optional —
frontend falls back to 60s polling. `http://localhost` is accepted by the
sign-in form. Statuses should carry a `pleroma` object (emoji_reactions etc.)
but empty defaults are fine.

## 2026-07-06 — zero-config boot + signup + real stats

The daemon can now start with no `accounts.local.json` at all: `createApp`
takes an `AppContext` (`getTransport()` / `signup()`) instead of a bare
`Transport`, so Mastodon endpoints that need chatmail 401 with
`{"error": "not configured"}` until an account exists, while
`/api/deltanet/status`, instance metadata, oauth, and the stub endpoints
keep working. `POST /api/deltanet/signup` registers a fresh chatmail account
against a relay's `/new` endpoint (factored into an injectable
`registerAccount()` in `src/signup.ts` so tests never touch the network),
persists it to `accounts.local.json`, and opens the transport in place —
no restart needed. Also wired real follower/following/status counts
(`Transport.stats()`, backed by the feed broadcast's contacts/chat list) into
`verify_credentials`, and added static SPA serving (`DELTANET_STATIC`,
default `../frontend/build`) with an index.html fallback for client-side
routes. All new behavior was driven top-down from `tests/server.test.ts`.

## 2026-07-06 — experiment findings: broadcasts are stricter than hoped

Ran controlled experiments (fresh accounts, scratch script) against core 2.53:

- **Cross-chat `quotedMessageId` is rejected at send time** ("Quote of message
  from Chat#X cannot be sent to Chat#Y"). Native quotes can't implement
  replies/boosts across feeds.
- **Read-only broadcast members cannot `sendReaction`** ("Broadcast channel is
  read-only"). Native reactions can't implement likes on others' posts.
- Same-chat quotes DO resolve cross-node (receiver gets `WithMessage` with a
  locally fetchable messageId — References-based linking works), empty-text
  quotes are accepted, and image messages round-trip fine.
- `MessageData.quotedText` (freeform) has no chat restriction, and every
  message's global email Message-ID is available via
  `getMessageInfoObject().rfc724Mid`. No reverse mid→msgId RPC exists, so the
  daemon must keep its own index.

### deltanet wire convention v0 (consequence)

Replies, boosts, and reactions become an application-layer convention over
message text, with the rfc724 Message-ID as the global post reference:

- **Reply**: post to OWN feed, text ends with marker line `↳re <mid> <addr>`;
  `quotedText` carries "<author>: <excerpt>" so vanilla Delta Chat renders a
  quote bubble. A copy goes as DM to the original author (thread + notify
  even without a follow-back).
- **Boost**: post to own feed, text = `♻ <mid> <addr>`, `quotedText` = the
  original text (embedded, SSB-style, so non-followers can render it).
- **Like/reaction**: DM to the author: `<emoji> ↳ <mid>`; retraction
  `✖ ↳ <mid> <emoji>`. DMs never appear in timelines, so these stay out of
  feeds; vanilla DC users see a readable "❤ ↳ …" message.
- Daemon keeps a persistent store per account (mid⇄msgId index, reply
  children, reaction tallies, notifications), fed by an idempotent ingest
  pass over timeline loads + incoming-message events.
- Honest limitations: reaction counts are only authoritative on your own
  posts; markers are visible (if unobtrusive) to vanilla DC readers.

## 2026-07-06 — default images, image attachments, self display name

Closed three small daemon issues via TDD (`tests/entities.test.ts` +
`tests/server.test.ts` first, then implementation). `GET /deltanet/header.png`
now serves a generated SVG gradient banner (kept the `.png` path from the
account entity mapping; browsers render SVG regardless of extension), and the
avatar placeholder (`entities.avatarPlaceholderSvg` + `initialOf`) uses the
contact's first grapheme and `color` field instead of a fixed glyph — added
`Transport.contactBadge(contactId)` for this, with a neutral fallback so the
avatar route never 404s for an unknown contact while configured. Added
`POST /api/v1/media` (multipart upload, 422 on non-image mime) backed by a new
`src/media.ts` in-memory registry over an OS-tmpdir upload dir, and extended
`POST /api/v1/statuses` to accept `media_ids[]`/`media_ids`, allow image-only
posts, and pass `{file}` through `Transport.post()` — the deltachat impl uses
`rpc.sendMsg(..., {viewtype: 'Image', file, ...})` instead of
`miscSendTextMessage` when a file is present. Alt text round-trips into the
posted status's `media_attachments[0].description` and into later timeline/
status reads via a msgId-keyed lookup in the same registry. Own posts (DC
contact id 1) now get the configured `displayname` substituted onto
`msg.sender` inside the deltachat transport's `loadMessages`, same trick as
`self()`, with the config read cached per transport instance rather than
per message.

## 2026-07-06 — replies/threads + reposts (deltanet wire convention v0, implemented)

Implemented both `meta/issues/replies-and-threads.md` and
`meta/issues/reposts.md` against the wire convention recorded above, TDD
throughout (new unit tests written and shown red before each implementation).

- **New `src/protocol.ts`** — pure functions, no transport/store
  dependencies: `buildReplyText`/`buildBoostText` produce the marker text;
  `parseMarkers` recovers it tolerantly (a reply marker must be the *final*
  line preceded by a blank line, a boost marker must be the *entire* text —
  anything else, including marker-shaped text embedded elsewhere or with a
  missing addr, is treated as plain body, so we never misfire on ordinary
  vanilla-DC messages). `buildQuotedText`/`parseQuotedAuthor` handle the
  freeform `"<author>: <excerpt>"` quote bubble, best-effort on parse (falls
  back to a null author if there's no `": "` separator). All round-trip via
  `tests/protocol.test.ts`.
- **New `src/store.ts`** — per-account JSON-file-backed index:
  mid⇄msgId, reply children (parent mid → child msgIds), boost tallies
  (boosted mid → booster msgIds), and which of those boosts are our own
  (for unreblog). `ingestMessage(msg, mid)` is idempotent (tracks ingested
  msgIds) and derives edges by running the message text through
  `parseMarkers`. Lazy-loaded, saved synchronously on every mutation (kept
  simple per the plan — the indices are small). `ephemeralStorePath()`
  gives callers (tests, `createApp`'s default) a scratch file so nothing
  needs a real data dir to exercise the API layer.
- **Transport** (`src/transport/types.ts` + `deltachat.ts`): `post()` gained
  `opts.quotedText`, threaded into `MessageData.quotedText` via `sendMsg`
  (switched off `miscSendTextMessage` whenever a file *or* quotedText is
  present, since that RPC has no quote parameter). Added `messageMid`
  (wraps `getMessageInfoObject(...).rfc724Mid`, in-memory cached — there's
  no reverse RPC), `sendControlDm` (resolves/creates the 1:1 chat via
  `getChatIdByContactId`/`createChatByContactId`, then `sendMsg`), and
  `deleteMessage` (`deleteMessagesForAll`). `openTransport` gained an
  `onMessage` option: every message `loadMessages` returns is handed to it,
  and a core `IncomingMsg` subscription also feeds it (so DM-only messages
  that never render in a timeline still get ingested) — failures are
  caught and logged, never fatal.
- **Server** (`src/server.ts`): the store lives in `createApp` (or is
  injected via a new `ServerOptions.store`, so `main.ts` can share one
  instance between the transport's `onMessage` hook and the API layer).
  `POST /api/v1/statuses` with `in_reply_to_id` resolves the target's mid,
  builds the reply marker + quotedText, posts to the own feed, and
  `sendControlDm`s the same text to the original author (skipped for
  self-replies) — the DM failing is logged but doesn't fail the request.
  `POST /api/v1/statuses/:id/reblog` builds the boost marker + a
  500-char-capped quotedText and posts to the own feed; the response
  wraps the new boost message with `reblog` embedding the original and
  `reblogged: true` (matches real Mastodon's asymmetric reblog/unreblog
  shapes: reblog returns a *new* status wrapping the original,
  unreblog returns the *original* status with `reblogged: false`).
  `unreblog` looks up our own boost msgId for that mid
  (`store.ownBoostMsgId`) and deletes it via the transport; the store
  doesn't track retractions itself; the endpoint just reports
  `reblogged: false` directly since we know we just deleted it.
  `GET /api/v1/statuses/:id/context` walks ancestors by following reply
  markers upward (cap 20) and descendants breadth-first over
  `store.replyChildren` (cap 100), both re-ingesting messages they touch
  along the way in case they weren't in the store yet.
- **Entities** (`src/mastodon/entities.ts`): `messageToStatus` now takes an
  optional `StatusResolver` (`resolveMid`, `childrenCount`, `boostCount`,
  `isOwnBoost`, `midForMsgId`) plus a `resolveMessage(msgId)` callback for
  recursively mapping an embedded boost; both default to no-ops/null so
  every old call site and test keeps working unchanged. Content is the
  marker-stripped body (parsed *before* html-ification); `in_reply_to_id`
  prefers the resolved mid, falling back to the legacy `parentId` field.
  A boost marker sets `status.reblog`: resolved mid → recursively mapped
  real status; unresolved → a synthesized minimal status/account built
  from `parseQuotedAuthor(msg.quote?.text)` + the marker's addr (account id
  `"0"`, `acct` = the addr, avatar/header point at neutral placeholders).
  Had to give `messageToStatus` an explicit `MastodonStatus` return-type
  annotation (was `ReturnType<typeof messageToStatus>`) since the
  self-referential `reblog: MastodonStatus | null` field made TS's
  circular-inference check choke otherwise.
- Deviations from the plan: none structural. One judgment call not spelled
  out in the issues — real Mastodon's `/reblog` and `/unreblog` responses
  are asymmetric (new wrapper status vs. original status), which the
  reposts issue's "return a status with reblog embedded" wording didn't
  fully disambiguate; implemented to match real Mastodon since PleromaNet
  is a Mastodon-API client.
- `pnpm test` (171 tests, all passing) and `pnpm check` (`tsc --noEmit`,
  clean) both green. Did not touch `tests/integration/federation.test.ts`
  or run `pnpm test:integration`, per instructions — `openTransport`'s
  new third parameter is optional so that test's existing two-arg calls
  still typecheck.

## 2026-07-06 — likes/favourites, emoji reactions, follow/unfollow, notifications

Implemented all four remaining wire-convention-adjacent issues
(`meta/issues/likes-favourites.md`, `emoji-reactions.md`,
`follow-unfollow-profiles.md`, `notifications.md`) together, TDD throughout
(protocol/store/derivation tests written and shown red before each piece of
implementation, then endpoint tests against extended fakes).

- **`src/protocol.ts`**: `buildReactionText(emoji, mid)` →
  `"<emoji> ↳ <mid>"`; `buildUnreactionText(emoji, mid)` →
  `"✖ ↳ <mid> <emoji>"`; `parseReaction(text)` recognizes both, single-line
  only (a reaction/unreaction with a trailing newline, or missing
  mid/emoji, is not recognized — same "never misfire on vanilla DC
  messages" tolerance as `parseMarkers`).
- **`src/store.ts`** gained:
  - `ownMids` — tracked directly off `msg.fromId === 1` inside the existing
    `ingestMessage` (no signature change was needed: `T.Message` already
    carries `fromId`).
  - Reactions: `Record<mid, Record<reactorAddr, emoji[]>>` (a reactor can
    apply several distinct emoji to the same mid — required by the emoji
    reactions issue). `applyReaction`/`retractReaction`/`reactionTallies`.
  - Notifications: append-only `Notification[]` + a monotonic string id
    counter, persisted like everything else. `addNotification` dedupes via
    an explicit `dedupeMid`(`+dedupeEmoji`) input rather than overloading
    the stored `emoji` field — a favourite notification stores no `emoji`
    field at all (matches real Mastodon) but still needs the emoji folded
    into its dedupe key so a ❤ and a 🎉 from the same reactor on the same
    post don't collide. `listNotifications({limit, maxId, sinceId})` is
    newest-first with strict `<`/`>` pagination bounds (Mastodon semantics).
- **New `src/ingest.ts`** (`deriveOnIngest(store, msg, mid)`): the
  notification/reaction-application pass, deliberately separate from
  `Store.ingestMessage` (which only maintains mid/msgId/reply/boost
  indices) so it's testable with a plain store + fake messages. SELF
  messages are skipped entirely — not just "no notification" but also "no
  reaction applied" — because the favourite/reaction endpoints apply our
  own reaction to the store directly and DM the author; relying on
  ingesting our own outgoing control DM would make the response depend on
  IncomingMsg delivery timing. Wired into both `server.ts`'s `ingest()`
  helper and `main.ts`'s `ingestOnMessage` (same call site as
  `store.ingestMessage`, right after it, same mid).
- **Transport** (`src/transport/types.ts` + `deltachat.ts`) gained
  `following()`, `unfollow(contactId)`, `timelineFrom(contactId, query)`,
  `onFollower(handler) => unsubscribe`.
  - **InBroadcast contact shape** (finding, since this wasn't verified by
    an integration test — no RPC docs spell it out either): a chat we
    joined via `secureJoin` shows up in `getChatlistEntries` as
    `chatType: 'InBroadcast'`, and `getFullChatById(...).contactIds` for
    that chat contains the feed owner (the QR code's issuer) as the only
    non-SELF contact. `following()` and `unfollow()`/`timelineFrom()`'s
    `inBroadcastChatFor()` helper both rely on "first non-SELF id in
    `contactIds`" — flagged in-code as based on this reasoning, not an
    integration-tested fact, since `pnpm test:integration` was off-limits
    for this task. `getFullChatById` was used over `getChatContacts`
    because it also gives `name`, needed for `following()`'s return shape,
    in the same call.
  - **leave vs. block decision**: grepped `client.d.ts` for a broadcast
    "leave" RPC — none exists; `leaveGroup` is documented as being for
    `Group` chats only. Between `deleteChat` and `blockChat`, `deleteChat`'s
    own doc comment says explicitly that it does *not* block the contact,
    so a later broadcast delivery would silently resurrect the chat as a
    contact request — the "unfollow" would be undone by the next post from
    that account. `blockChat` was used instead: it actually stops delivery
    and matches user intent ("stop following this account").
  - `timelineFrom(1, ...)` (our own contact id) is special-cased to read
    our own feed broadcast chat instead of hunting for an InBroadcast chat
    for ourselves (we don't have one) — needed so
    `GET /api/v1/accounts/:id/statuses` also works on our own profile.
  - `onFollower` is a thin pub/sub over the `SecurejoinInviterProgress`
    core event; per its own doc comment in `types.d.ts`, `progress` on that
    event is *always* 1000 (there's no intermediate-progress variant for
    the inviter side, unlike the joiner-side event) — the `progress !==
    1000` guard is defensive rather than load-bearing today. `contactId` on
    the event is the joiner, i.e. the new follower.
- **`src/mastodon/entities.ts`**: `contactToAccount` gained an optional
  `relationship: MastodonRelationship` param folded into
  `pleroma.relationship` (full Mastodon relationship shape; only
  `following`/`showing_reblogs` ever go true — the rest are honest
  `false`s, no blocking/muting/endorsement features exist yet).
  `StatusResolver` gained `reactionTallies(mid)` and `ownAddr()` (both
  default to empty/null so every old call site keeps working);
  `messageToStatus` now computes `favourites_count`/`favourited` from the
  ❤ tally and `pleroma.emoji_reactions` (`{name, count, me}`) from every
  *other* tally, `me` computed by checking `ownAddr()` against each
  emoji's reactor list. Exported the existing (previously module-private)
  `synthesizeAccount` helper for reuse by the notifications endpoint.
- **Server** (`src/server.ts`):
  - `POST/DELETE` favourite and `PUT/DELETE
    /api/v1/pleroma/statuses/:id/reactions/:emoji` share one
    `reactToStatus(c, emoji, action)` helper: resolves the target + its
    mid, applies our own reaction to the store immediately (so the
    response reflects it without waiting for DM round-trip delivery), and
    — unless the target is our own post — sends the reaction/unreaction
    control DM with a quoted excerpt. The emoji route param is
    `decodeURIComponent`'d per the issue's instruction. ❤ stays
    favourite-only in the mapping (excluded from `pleroma.emoji_reactions`)
    purely as an entities-layer mapping rule; the store treats it as just
    another emoji.
  - `GET /api/v1/accounts/relationships` (registered before the `:id` GET
    so Hono's static-route-first matching wins — verified via the test
    suite) reads `transport.following()` and returns the full relationship
    shape per requested id. `GET /api/v1/accounts/:id` now also includes
    `pleroma.relationship`. `POST .../unfollow` calls `transport.unfollow`
    and returns the post-unfollow relationship (idempotent: reports
    `following:false` even if we weren't following). `POST .../follow`
    always 422s with an error pointing at invite links, per the issue.
  - `GET /api/v1/accounts/:id/statuses` replaced the `[]` stub with a real
    implementation over `transport.timelineFrom`.
  - `GET /api/v1/notifications` replaced the empty-list stub with a real
    mapping over `store.listNotifications`, respecting `limit`/`max_id`/
    `since_id`; account is the real contact when `accountContactId` is
    known, else `synthesizeAccount` from the stored address; status is
    `resolveMessage` + the shared `toStatus` mapper when `statusMsgId` is
    present.
  - New-follower wiring (`transport.onFollower` →
    `store.addNotification({type: 'follow', ...})`) lives in `main.ts`, not
    `server.ts`, matching the issue's instruction — it needs the live
    transport instance from `openTransport`, which `server.ts`'s
    request-scoped code doesn't have direct access to outside a request.
- Deviations from the plan: none structural. Two things worth flagging:
  (1) the InBroadcast "owner = first non-self contact" assumption above is
  reasoned from RPC semantics + doc comments, not confirmed by
  `pnpm test:integration` (off-limits for this task) — worth a follow-up
  integration-test pass; (2) follow notifications have no natural
  `dedupeMid`, so repeated joins-by-the-same-contact (e.g. rejoining after
  an unfollow) will currently produce a second `follow` notification each
  time — not addressed since the issue's dedupe requirement was specific to
  reply-seen-twice, but flagged here in case it's surprising later.
- `pnpm test` (279 tests, all passing) and `pnpm check` (`tsc --noEmit`,
  clean) both green. Did not touch `tests/integration/federation.test.ts`
  or run `pnpm test:integration`, `../frontend`, or `data/`, per
  instructions.

## 2026-07-06 — bug fix: reaction/reply DMs from contact-request chats never ingested

Bug found in live testing: reaction/reply control DMs from another node
land in the recipient's Delta Chat database (in a 1:1 chat with
`isContactRequest=true`) but were never ingested. Feed/broadcast messages
ingested fine; only messages arriving in a *pending* 1:1 (contact-request)
chat were silently dropped. Root cause: `dc.on('IncomingMsg', ...)` in
`src/transport/deltachat.ts` never fired for those messages — apparently
core suppresses `IncomingMsg` for contact-request chats, even though it
still updates the database and (per live testing) still emits
`MsgsChanged`. Consequence: reactions/likes from remote nodes we hadn't yet
accepted a chat with never registered — store stayed empty, no
favourite/emoji_reaction notifications ever fired.

Checked `node_modules/@deltachat/jsonrpc-client/dist/generated/types.d.ts`
for the exact event semantics before touching anything:
- `IncomingMsg { chatId, msgId }`: doc comment says "there is no extra
  MsgsChanged event sent together with this event" — describing the
  *normal* case (one or the other, not both). It says nothing about
  contact-request chats specifically; live testing is what showed those
  chats get `MsgsChanged` only, never `IncomingMsg`.
- `MsgsChanged { chatId, msgId }`: msgId is 0 "if only a single chat is
  affected" is inverted in the actual field doc — reread: chatId/msgId are
  each "set if only a single [chat/message] is affected... otherwise 0".
  So `msgId === 0` means a chat-level change (multiple messages/chats
  affected, e.g. a draft) with nothing specific to load — skipped.
- `IncomingMsgBunch`: no payload beyond `kind` (a "stop spamming
  notifications, batch them" hint for UIs) — carries no chatId/msgId, so
  it's useless for ingestion and wasn't subscribed to.
- No other event kind in the file documents contact-request-specific
  delivery semantics.

Fix (`src/transport/deltachat.ts`), three parts:
1. Subscribed to `MsgsChanged` alongside `IncomingMsg`, routed through the
   same `notifyOnMessage` funnel (via a new shared `loadAndNotify(msgId,
   eventKind)` helper). Skips `msgId === 0`. Downstream ingestion
   (`Store.ingestMessage`) already dedupes via `ingestedMsgIds`, so
   double-delivery from both events firing for the same message is a
   harmless no-op.
2. Startup backfill: a fire-and-forget `backfill()` runs after `startIo`
   (not awaited in the main `openTransport` path, so it never delays
   daemon startup) — walks every chat via `getChatlistEntries` →
   `getMessageIds` → `getMessages` in batches of 50, sequentially, each
   message run through `notifyOnMessage`. Catches messages that arrived
   while the daemon was down *and* anything both events missed. Per-chat
   try/catch so one bad chat doesn't abort the sweep.
3. Accept contact-request chats on first sight: `notifyOnMessage` now
   calls a new `acceptIfContactRequest(chatId)` before handing off to
   `options.onMessage` — checks `getBasicChatInfo(...).isContactRequest`
   and calls `acceptChat` (best-effort, caught and logged) so the 1:1 stops
   being a pending request and future deliveries flow through normal
   events instead of relying on the `MsgsChanged` safety net forever.

Extracted the filtering logic all three paths need (skip info messages,
skip messages with no sender (`fromId === 0`), skip messages with neither
text nor a file) into a pure, exported `shouldIngest(msg)` predicate in
`src/transport/deltachat.ts` — the one piece of transport-layer logic
worth unit-testing per the project's "transport has no unit tests, it's
network-bound" convention. Added `tests/deltachat.test.ts` (6 cases: plain
text accepted, info message rejected, sender-id-0 rejected, no-text/no-file
rejected, file-only accepted, text-only accepted).

`src/main.ts` needed no changes — `ingestOnMessage`'s signature
(`(msg: T.Message) => Promise<void>`) is unchanged; it's still just
`options.onMessage` under the hood, now fed from three call sites
(`IncomingMsg`, `MsgsChanged`, backfill) instead of one.

TDD note: skipped red→green for the transport wiring itself per the
project's existing convention (transport is network-bound / no unit
tests) — only `shouldIngest` got the full TDD treatment (test file written
against the not-yet-exported predicate first, confirmed failing via
missing-export error, then extracted and exported).

`pnpm test` (315 tests, all passing) and `pnpm check` (`tsc --noEmit`,
clean) both green.

Fixed double-counted replies/boosts: a reply is delivered twice by design
(feed broadcast + DM copy to the author, different rfc724Mids), and both
copies registered in `replyChildren`/`boostsByMid`. `Store.ingestMessage`
now takes `isFeedMessage` (default `true`) gating edge registration only —
mid mapping/`ownMids` still record for every message; `deltachat.ts` reuses
its existing `getBasicChatInfo` call (no extra RPC) via a new pure
`isFeedChat(chatType)` predicate to classify each message, passed as
`onMessage`'s 2nd arg through `main.ts`/`server.ts`. `deriveOnIngest` is
unchanged, so DM reactions and mention-dedupe still work. `pnpm test`
(325 tests) and `pnpm check` both green.

Two more live-testing fixes: (1) profile pages 404ed — added
`GET /api/v1/accounts/lookup?acct=` backed by a new
`Transport.contactIdByAddr` (`rpc.lookupContactIdByAddr`; SELF matched
first via pure `matchesSelfAddr`, tolerating "@"-prefix and bare own
username). (2) self avatar placeholder showed "M" — `contactBadge` now
applies the cached configured-displayname override via pure `badgeOf`
instead of the raw SELF contact's "Me". `pnpm test` (340) + `pnpm check`
green.

## 2026-07-06 — bug fixes: re-follow after unfollow silently failed; startup backfill silently dropped

**Bug 1: re-following a previously-unfollowed feed didn't work.**
`unfollow()` calls `blockChat` on the InBroadcast chat, which correctly
hides it from `getChatlistEntries`/the timeline. But `follow()`, called
again on the same invite/contact, got back the *same* (still-blocked) chat
id from `secureJoin`, and its `acceptChat(...).catch(() => undefined)` call
swallowed whatever error `acceptChat` threw on a blocked chat — so the feed
stayed invisible while `POST /api/deltanet/follow` still returned 200.

Root cause / what `acceptChat` actually does: **nothing relevant to
blocking**. It has no doc comment in the generated client at all (unlike
e.g. `deleteChat`, which spells out exactly what it does and doesn't do),
and empirically it does not undo a `blockChat`. Blocking in `@deltachat`'s
model is a *contact*-level operation, not a chat-level one: neither
`BasicChat` nor `FullChat` expose a `blocked`/`isBlocked` field at all —
the only place blocked-ness is observable is `Contact.isBlocked`. There is
also no "unblock chat" RPC, only `unblockContact(accountId, contactId)`.
So `blockChat(chatId)` blocks the chat's underlying contact(s), and the
only way back is to find those contacts and call `unblockContact` on them.

**Fix** (`daemon/src/transport/deltachat.ts`): added a pure predicate
`blockedContactIds(contacts: T.Contact[]): number[]` (filters
`contact.isBlocked`, unit-tested in `tests/deltachat.test.ts` against
`makeContact({ isBlocked })`). `follow()` now, after `secureJoin`, calls
`getChatContacts` + `getContactsByIds` on the returned chat id, runs the
result through `blockedContactIds`, and `unblockContact`s each one before
calling `acceptChat` — and neither call swallows its error silently
anymore (both are logged via `console.error`, matching the project's
existing "log, don't swallow" convention for best-effort RPC calls
elsewhere in this file). Confirmed live via a real unfollow→re-follow
cycle (see integration test below): after the fix, the re-joined
InBroadcast chat shows `isBlocked: false` on the owner contact and reappears
in `getChatlistEntries`, and alice's next post reaches bob's timeline again.

Proven end-to-end by a new integration test in
`tests/integration/federation.test.ts`: `lets a follower re-follow a feed
after unfollowing it`. Runs against two **freshly registered** chatmail
accounts (via `registerAccount`, not `accounts.local.json`) in fresh
`data/int-alice`/`data/int-bob` dirs (renamed from an initial `data/int-*`
attempt's sibling `it-*` naming specifically to avoid any collision with
`data/it-alice`/`data/it-bob`, which the pre-existing test also uses, and
with `data/main`/`data/demo`, which live daemon processes hold open) —
follow, confirm delivery, unfollow, confirm the next post is *not*
delivered, re-follow via a fresh invite, confirm a new post *is* delivered
again. One wrinkle: the second `secureJoin` reuses an already-verified
key-contact relationship between the two test accounts, and unlike the
first join, alice's side does not reliably re-emit
`SecurejoinInviterPropgress` (progress===1000) for it — so the test treats
that wait as best-effort (`.catch(() => undefined)`, 60s) and falls through
to polling `bob.timeline()`, which is what the regression actually cares
about. Full run: 2 tests passed in ~97s.

**Bug 2: startup backfill (and any event delivered before `openTransport`
returns) was a silent no-op.** `openTransport` fires its startup `backfill()`
sweep fire-and-forget *before* it returns (`void backfill()...`, deliberately
not awaited so it doesn't delay startup) and can independently deliver live
core events (`IncomingMsg`/`MsgsChanged`) in the same window. But
`main.ts`'s `ingestOnMessage` read a module-level `transport` variable —
`let transport: Transport | null = null;` — that's only assigned *after*
`await openTransport(...)` resolves:
```
const ingestOnMessage = async (msg, isFeedMessage) => {
  const t = transport;
  if (!t) return;         // <- backfilled messages hit this and vanish
  const mid = await t.messageMid(msg.id);
  ...
};
...
transport = await openTransport(DATA_DIR, creds, { onMessage: ingestOnMessage });
```
Every message the hook saw before that assignment landed — which, for a
fire-and-forget sweep racing the outer `await`, is not a rare edge case —
hit the null guard and was dropped. Live symptom: a rebuilt
`deltanet-store.json` after restart had `ingestedMsgIds` covering only
live-event messages (count 3), `ownBoosts`/`boostsByMid` empty, and
`POST /statuses/:id/unreblog` 404ing because `store.ownBoostMsgId` had
nothing to find. It "mostly worked" only because core happens to re-emit
`MsgsChanged`/`IncomingMsg` for some messages after startup anyway, masking
the gap.

**Fix**: removed the outer-variable dependency structurally rather than
just avoiding it. `OpenTransportOptions.onMessage`'s signature grew a third
argument, `mid: string | null` — the transport now resolves each ingested
message's `rfc724Mid` itself (reusing the same `resolveMid`/`midCache`
machinery `messageMid()` already exposed, just called a step earlier,
inside `notifyOnMessage`) and passes it straight through. `main.ts`'s
`ingestOnMessage` no longer reads `transport` at all — it just uses the
`mid` argument — so there is no window where the hook can be called before
the data it needs is available; the race is impossible by construction, not
just unlikely. (`notifyFollower` in `main.ts` was checked too: it's
registered via `transport.onFollower(...)` *after* `openTransport` resolves,
so no equivalent race exists there — left as-is.)

Files changed: `daemon/src/transport/deltachat.ts` (`blockedContactIds`,
`follow()` unblock logic, `onMessage` signature + `notifyOnMessage`
resolving `mid` before calling it, `midCache`/`resolveMid` moved earlier in
the closure), `daemon/src/main.ts` (`ingestOnMessage` takes `mid` directly),
`daemon/tests/deltachat.test.ts` (`blockedContactIds` unit tests, TDD
red→green: written against the not-yet-exported function first, confirmed
failing via `TypeError: blockedContactIds is not a function`, then
implemented), `daemon/tests/integration/federation.test.ts` (new
re-follow-after-unfollow test). `pnpm test` (343 tests) and `pnpm check`
both green throughout; `pnpm test:integration` green (2/2, ~97s) after the
fix (first attempt, before the best-effort event-wait change above, failed
only on the flaky `SecurejoinInviterProgress` wait for the second join —
state inspection confirmed the unblock itself had already succeeded even
in that failing run).

## 2026-07-06 — incident: integration suite wiped a live daemon's database; startup backfill was order-dependent

**Incident: running the integration suite wiped a live daemon's data.**
`tests/integration/federation.test.ts`'s original test (`delivers a post from
alice to her follower bob`) predates the `data/int-*`-per-test convention
established by the re-follow regression test above. It still opened
`data/it-alice`/`data/it-bob` with long-lived credentials read out of
`accounts.local.json` (`accounts['main']`/`accounts['peer']`), and began with
`rmSync('data/it-alice', ...)` / `rmSync('data/it-bob', ...)`. Both of those —
the data dir names *and* the `accounts.local.json` entries — are shared with
long-running daemon processes (this repo runs `data/main`, `data/demo`,
`data/it-bob` as live daemons against real chatmail accounts). Running the
suite today `rmSync`'d a live daemon's DeltaChat database out from under it
mid-run. Nothing caught this beforehand because the old test was never
migrated when the isolation convention was introduced — it just kept
quietly reusing shared state next to a newer sibling test that had already
solved this exact problem correctly.

**Fix**: reworked the old test to the same pattern as its newer sibling —
its own fresh, test-only data dirs (`data/int-basic-alice`,
`data/int-basic-bob`, `rmSync`'d at start) and two freshly registered
chatmail accounts via `registerAccount(relay)`, instead of
`accounts.local.json`. No test in this file touches `data/it-*` or
`accounts.local.json` anymore, and no test's data dir/account can collide
with another test's or with a live daemon's. `readAccounts` is no longer
imported by this file at all. Only `tests/integration/federation.test.ts`
changed; nothing outside `tests/integration` was touched, and the live
daemons' data was not further touched by this fix (out of scope — this task
only stops the *test suite* from being able to do it again).

**Bug: startup backfill's notification derivation was sweep-order-dependent.**
`deltachat.ts`'s `backfill()` walked `getChatlistEntries` (recency order, not
dependency order) and called `notifyOnMessage` inline per message, which —
via `main.ts`'s `ingestOnMessage` — ran `store.ingestMessage` (mid/msgId
indexing, `ownMids` bookkeeping) *and* `deriveOnIngest` (notification/
reaction-store side effects) back to back for that one message before moving
to the next. If a DM chat holding a reaction/reply control message happened
to be swept *before* the chat holding the mid it targets (e.g. our own feed
chat with the original post), `deriveOnIngest` ran while `store.isOwnMid`
still read `false` for that mid — `ownMids` for the target message hadn't
been populated yet, because indexing *that* message hadn't happened yet.
Net effect: the reaction was still tallied (`applyReaction` isn't gated on
`isOwnMid`), but the corresponding favourite/`pleroma:emoji_reaction`
notification was silently never derived, purely because of which chat the
core happened to list first.

**Fix**: split ingestion into two explicit phases. `OpenTransportOptions.
onMessage` grew a fourth argument, `phase: 'combined' | 'index' | 'derive'`
(new exported type `IngestPhase`). Every existing call site — live
`IncomingMsg`/`MsgsChanged` events, and ordinary timeline/message loads via
`loadMessages`/`notifyOnMessage`'s default — passes `'combined'`, meaning
"do both halves for this one message," exactly the behavior before this
argument existed. Only `backfill()` uses the split: it now first collects
every message from every chat (unchanged sweep/batch/error-handling logic,
just pushed into an array instead of notifying inline), then runs a first
pass calling `notifyOnMessage(msg, 'index')` for every collected message,
then a second pass calling `notifyOnMessage(msg, 'derive')` for every one of
them again. `main.ts`'s `ingestOnMessage` switches on `phase`: `'combined'`
or `'index'` runs `store.ingestMessage`; `'combined'` or `'derive'` runs
`deriveOnIngest`. By the time any message reaches the `'derive'` pass, every
backfilled message — regardless of source chat or sweep order — has already
been indexed, so `store.isOwnMid` is fully populated store-wide before
derivation ever runs. This deliberately does **not** give the transport a
`Store` dependency: `deltachat.ts` still only knows about `phase` as an
opaque tag it passes through, all store semantics stay in `main.ts`.

Checked the interaction with `Store.ingestMessage`'s own dedupe
(`ingestedMsgIds`) carefully, since backfill's `'index'` pass now runs before
`'derive'` ever touches the same msgId: the dedupe guard
(`if (ingestedSet().has(msg.id)) return;`) only lives inside `ingestMessage`
itself, so it can only ever make a repeated `'index'` call a no-op — it has
no way to suppress a `'derive'` call, because `deriveOnIngest` is a
different function with its own, separate dedupe
(`notificationDedupeKeys`). So `ingestOnMessage`'s `'combined'`/`'index'`
branch calling `store.ingestMessage` first and its `'combined'`/`'derive'`
branch calling `deriveOnIngest` unconditionally (never behind an
"already ingested?" check) was exactly the right shape — no adjustment to
`store.ts` was needed.

Added `acceptIfContactRequest` skip on the `'derive'` phase in
`notifyOnMessage` (it's redundant work, not a correctness issue: the
`'index'` pass for the same message already accepted the chat moments
earlier if needed).

New unit tests in `daemon/tests/ingest.test.ts` (`backfill
order-independence (two-pass ingest/derive)`): one test simulates the
two-pass backfill directly — an `'index'` pass over `[reaction message, own
post]` in that (bug-triggering) order, confirming `isOwnMid` is populated
for the own post's mid before any derivation runs, then a `'derive'` pass
over the same order — and asserts the favourite notification *is* produced.
A companion "contrast" test runs the old inline-per-message behavior in the
same order and asserts the notification is *not* produced (reaction tally
still applies), to document the bug the fix closes and guard against a
future regression back to single-pass ingestion.

Files changed: `daemon/src/transport/deltachat.ts` (`IngestPhase` type,
`onMessage` signature, `notifyOnMessage` phase plumbing, `backfill()`
rewritten to collect-then-two-pass), `daemon/src/main.ts` (`ingestOnMessage`
switches on `phase`), `daemon/tests/ingest.test.ts` (two new tests),
`daemon/tests/integration/federation.test.ts` (old test reworked to fresh
`data/int-basic-*` dirs + `registerAccount`, no more `accounts.local.json`/
`data/it-*`). `pnpm test` (345 tests) and `pnpm check` green. Did not run
`pnpm test:integration` this round (several minutes, and live daemons are
running against real chatmail data — out of scope for this fix, and exactly
the risk this task closes off).

## 2026-07-06 — Mastodon streaming websocket (live updates/notifications)

Implemented `meta/issues/streaming-websocket.md`: `GET /api/v1/streaming`
(+ trailing-slash) upgrades to a websocket and streams `update`/
`notification` frames for live feed activity, matching the frontend's
existing (already-wired, previously dark) streaming client exactly.

**Read the frontend first (read-only, no changes)**:
`frontend/src/lib/pleroma/streaming.ts`. Connects to
`new URL('/api/v1/streaming/', origin)` (note: trailing slash) with
`?stream=<user|public|public:local>&access_token=<token>` (`URLSearchParams`
percent-encodes the `:` in `public:local`). `parsePleromaStreamingMessage`
does `JSON.parse` on the raw frame expecting a top-level `{event, payload}`
object, then `JSON.parse`s `payload` a *second time* (it's a JSON string,
not an object) to get the actual status/notification. Only `event ===
'update'` (mapped to `.status`, gated by a structural `isPleromaStatusPayload`
type guard) and `event === 'notification'` (`.status` optional) are ever
acted on; anything else is parsed but silently ignored by the page. The
client reads no top-level `stream` field at all — so the Mastodon-standard
`{"stream":[...], "event", "payload"}` shape the issue asks for is a strict
superset of what this frontend needs, and matching it exactly costs nothing
extra. No ping/pong or reconnect logic lives in the client itself (that's in
the page, flat 60s-interval reconnect) — this only matters for how
aggressively the server needs to keep the connection alive, not for frame
shape.

**`src/streaming.ts` (new)**: `createStreamingHub()` — `register(socket,
streams)` (returns an unregister fn), `unregister(socket)`,
`broadcastUpdate(statusJson, msgId)` (to `user`+`public`+`public:local`
subscribers, deduped: a bounded FIFO of the last 1000 streamed msgIds so a
`MsgsChanged` re-fire for the same message — see `deltachat.ts`'s
`IncomingMsg`+`MsgsChanged` double-subscription — never streams a status
twice), `broadcastNotification(notificationJson)` (`user` subscribers only).
Sockets are accepted through a minimal structural `StreamingSocket` type
(`{send(data: string), readyState?: number}`) — no `ws` import anywhere in
this file, so the hub is fully unit-testable with plain object fakes.
Frames: `JSON.stringify({stream: [<stream>], event, payload:
JSON.stringify(payloadObj)})`, matching the frontend's double-JSON-decode
exactly.

Also in this file (not `server.ts`): `resolveStreamName` (pure `stream`
query-param -> `StreamName` mapping, default `'user'`) and
`createStreamingEvents(hub, streamParam)`, which builds the
`{onOpen, onClose, onError}` triple `hono/ws`'s `upgradeWebSocket` helper
wants — including the ws-level keepalive ping (`setInterval` every 30s on
`ws.raw.ping()`, best-effort/try-catched, cleared on close/error alongside
unregistering from the hub). Pulled these out of `server.ts`'s route
registration deliberately: Hono's `app.request()` fetch-based test helper
cannot drive a real `Upgrade: websocket` handshake (confirmed by reading
`@hono/node-server`'s `upgradeWebSocket` implementation — it gates on
`env[WAIT_FOR_WEBSOCKET_SYMBOL]`, only ever populated by a real
`http.Server`'s `'upgrade'` event), so anything left inside the route
handler closure would be untestable without a real HTTP+ws round trip.
Keeping `server.ts`'s handler a one-line adapter
(`upgradeWebSocket((c) => createStreamingEvents(hub, c.req.query('stream')))`)
means the actual registration/keepalive/cleanup behavior is unit-tested
directly against `createStreamingEvents` with a fake socket instead.

**`src/mapping.ts` (new)**: factored `server.ts`'s inline `resolver`/
`ownAddr`/`toStatus` closures out into `createStatusMapper(store, baseUrl)`,
and the `GET /api/v1/notifications` handler's inline notification-JSON
builder out into `mapNotification(n, transport, mapper, baseUrl,
mediaDescriptionFor)`. `server.ts` now calls both instead of defining its
own copies — required so `main.ts`'s live-ingestion path can map a freshly
ingested message/notification to the *exact* same JSON shape the REST
endpoints return, per the issue's "no divergent JSON shapes" requirement,
without duplicating the mapping logic. One known small gap: live-streamed
statuses for a freshly-uploaded image never carry alt-text
(`mediaDescriptionFor` is `() => null` in `main.ts`), because `mediaStore`
lives inside `createApp`'s closure and isn't plumbed out (would mean
changing `createApp`'s return shape, touching all 36 existing call sites).
Self-heals on the client's next REST poll, which does have `mediaStore`
access — acceptable for a best-effort live nicety.

**`src/ingest.ts`**: `deriveOnIngest` now returns `Notification[]` — the
notifications actually created (not dedupe no-ops), by collecting
`Store.addNotification`'s existing `| null` per-call return instead of
discarding it. Chosen (per the issue) as the least invasive way for
`main.ts` to know exactly which notifications are new after a live ingest,
without a separate before/after diff against `listNotifications`. Existing
callers (`server.ts`'s `ingest()`, `main.ts`'s old `ingestOnMessage`, all of
`ingest.test.ts`) call it as a bare statement and are unaffected by the
signature change.

**`src/main.ts`**: `ingestOnMessage` now branches on `phase === 'combined'`
(live events + ordinary timeline/message loads) to additionally map+broadcast
after the existing store/derive bookkeeping — never for the `'index'`/
`'derive'` startup-backfill phases, so backfill stays silent as required.
For a feed message (`isFeedMessage`), maps it via the shared `mapper.toStatus`
and calls `hub.broadcastUpdate`. For each notification `deriveOnIngest`
returns, maps it via `mapNotification` and calls `hub.broadcastNotification`.
`notifyFollower` (the `SecurejoinInviterProgress` handler) does the same for
follow notifications. All of this is wrapped in try/catch — streaming is
best-effort and must never make ingestion itself fail. If `transport` hasn't
been assigned yet (the same startup-backfill race `mid`-passing already
works around for indexing, see the fix above) a live event during that
narrow window is simply not streamed rather than crashing — acceptable,
since indexing/derivation (the load-bearing half) still happens
unconditionally.

**Websocket transport wiring**: added `ws`+`@types/ws` as dependencies. The
issue's writeup mentioned `@hono/node-server/ws`/`createNodeWebSocket`
(the *old*, `@hono/node-server`-v1-era API, which lives in a *separate*
package, `@hono/node-ws`, whose peer dependency pins `@hono/node-server
^1.19.11` — incompatible with this repo's `^2.0.8`). Checked
`node_modules/@hono/node-server`'s actual shipped `.d.mts`: v2 exports
`upgradeWebSocket` directly from its root, no `injectWebSocket` step at all
— just `serve({fetch, websocket: {server}})` with a `ws.WebSocketServer({
noServer: true})` (confirmed against the package's own README). No
`pnpm-workspace.yaml` build-approval changes were needed (`ws` has no
postinstall script). `server.ts`'s `ServerOptions` grew optional
`upgradeWebSocket`/`hub` fields; the streaming route (both `/api/v1/streaming`
and the trailing-slash form) is only registered when both are present, so
`createApp`'s existing 36 call sites (none of which pass these) are
unaffected. `main.ts` wires real ones in and calls
`serve({..., websocket: {server: wss}})`.

Manually smoke-tested end to end: booted `main.ts` unconfigured (no account)
and confirmed via `curl` with real `Upgrade: websocket` handshake headers
that `GET /api/v1/streaming?stream=user&access_token=x` returns a genuine
`HTTP/1.1 101 Switching Protocols` with matching `Sec-WebSocket-Accept` —
proving the `upgradeWebSocket`/`WebSocketServer`/`serve` wiring is correct
end-to-end, not just type-checked.

New unit tests: `tests/streaming.test.ts` (26 tests — frame format/double-
JSON-encoding, stream filtering including "one frame per socket even when
subscribed to multiple matching streams", dedupe by msgId including the
1000-id eviction boundary, register/unregister lifecycle including
readyState-gated sends, `resolveStreamName`, and `createStreamingEvents`'s
onOpen/onClose/onError + ping-interval + ping-failure-triggers-cleanup
behavior via fake timers), plus additions to `tests/ingest.test.ts`
(`deriveOnIngest`'s new return value: created/empty/dedupe/SELF/retraction
cases) and `tests/server.test.ts` (streaming route registration: absent
without `upgradeWebSocket`+`hub`, both path variants present when wired,
correct stream-name wiring — via a fake `UpgradeWebSocket` that invokes
`createEvents(c)` directly, since Hono's `app.request()` can't drive a real
websocket upgrade).

Files changed: `daemon/src/streaming.ts` (new), `daemon/src/mapping.ts`
(new), `daemon/src/ingest.ts` (`deriveOnIngest` return type), `daemon/src/
server.ts` (extracted mapping usage, streaming route registration),
`daemon/src/main.ts` (hub/mapper wiring, `ingestOnMessage`/`notifyFollower`
broadcasting, `serve()`/`WebSocketServer` wiring), `daemon/package.json`
(`ws` dependency, `@types/ws` devDependency), `daemon/tests/streaming.test.ts`
(new), `daemon/tests/ingest.test.ts`, `daemon/tests/server.test.ts`. `pnpm
test` (382 tests) and `pnpm check` green. Did not run `pnpm test:integration`
(per task instructions).

## Reply mentions metadata (`meta/issues/reply-mentions-metadata.md`)

`messageToStatus` now fills `in_reply_to_account_id`/`mentions` from the
reply marker's resolved parent (via the existing `resolveMessage` callback,
already used for boost embedding), instead of always `null`/`[]`. Added a
`contactToMention` helper (same id/username/acct/url shape as
`contactToAccount`) and a `MastodonMention` type. `mapping.ts`'s `toStatus`
now fetches the reply parent alongside the boosted message, deduped through
one `resolvedById` map so `resolveMessage` serves both call sites without
double-fetching (recursive reblog-of-a-reply embedding is bounded: it just
sees an empty map for the inner message's own parent, no extra fetch).
Decision: self-replies still get a mention (diverges from upstream Mastodon,
which drops the author's own mention on self-replies) — simpler and the
frontend doesn't special-case it. Files: `daemon/src/mastodon/entities.ts`,
`daemon/src/mapping.ts`, `daemon/tests/entities.test.ts`,
`daemon/tests/server.test.ts`. `pnpm test` (403 tests) and `pnpm check`
green.

## Profile editing (`meta/issues/profile-editing.md`)

Implemented `PATCH /api/v1/accounts/update_credentials`, backed by Delta Chat
self-config. `display_name` → `displayname`, `note` → `selfstatus` (both
federate in outgoing message headers), `avatar` file → `selfavatar`. Header
uploads are stored locally and served for SELF only (no DC equivalent — they
don't federate).

**Frontend contract (read-only inspection of `../frontend`).** The settings
save (`updateAccountProfile` in `src/lib/pleroma/client.ts`) submits **JSON**
(`Content-Type: application/json`), not multipart: `profileUpdateBody` sends
`display_name`, `note`, `locked`, `bot`, `discoverable`,
`hide_followers_count`, `fields_attributes`. It reads back the full
`PleromaAccount` (`display_name`, `source.note`, `note`, `discoverable`,
`pleroma.hide_followers_count`, `fields`). The "Choose avatar"/"Choose banner"
buttons exist in the settings UI (`routes/app/[...path]/+page.svelte`) but are
**not yet wired** to any upload. So the endpoint accepts JSON *and* multipart
form-data (hono `parseBody` yields `File` objects for `avatar`/`header`, same
as `/api/v1/media`) — the avatar/header paths are forward-looking for when the
frontend wires those buttons.

**Does DC copy selfavatar into blobs?** Yes. Delta Chat core imports the
avatar file into its blob store on `setConfig('selfavatar', path)` (the config
docs and `SelfavatarChanged`/`AccountsItemChanged` events confirm selfavatar is
a managed asset, and `Contact.profileImage` for SELF resolves to the imported
blob). A temp source file would therefore suffice — but per the issue we still
persist the uploaded avatar under the account data dir (not os tmpdir) so it
survives a restart as a stable on-disk artifact. `avatarPath(SELF)` special-
cases contact id 1 to read the `selfavatar` config directly (authoritative,
avoids any lag in the raw contact's `profileImage`).

**Cache invalidation.** `openTransport`'s `cachedDisplayName` (read by
`self()`/timeline mapping/`contactBadge`) is dropped via a new
`invalidateSelfDisplayName()` at the end of `updateProfile`, so a name change
is visible on the very next read.

**Header route.** Replaced the single global `/deltanet/header.png` with
per-contact `/deltanet/header/:contactId`: SELF (id 1) serves the stored
`<dataDir>/header.png` if present, else the generated gradient; every other id
gets the gradient. `contactToAccount` now points `header`/`header_static` at
`/deltanet/header/:id`. Kept `/deltanet/header.png` as a gradient alias so old
URLs / `synthesizeAccount` (still references it) don't break. `dataDir` is
threaded through `ServerOptions` from `main.ts` (which knows `DATA_DIR`,
resolved absolute); tests fall back to a per-process scratch dir.

Validation: blank `display_name` → 422; empty `note` is allowed (clears bio);
non-image `avatar`/`header` → 422 (same mime check as `media.ts`).

Files: `daemon/src/transport/types.ts` (`ProfileUpdate` type +
`updateProfile`), `daemon/src/transport/deltachat.ts` (`updateProfile`,
`invalidateSelfDisplayName`, SELF-aware `avatarPath`),
`daemon/src/mastodon/entities.ts` (header URLs), `daemon/src/server.ts`
(endpoint, `selfAccountJson` helper, per-contact header route, `dataDir`
option, avatar/header persistence), `daemon/src/main.ts` (`dataDir` wiring),
`daemon/tests/server.test.ts` (fake transport `updateProfile` + recorder, new
update_credentials/header suites). `pnpm test` (413 tests) and `pnpm check`
green. Did not run `pnpm test:integration` (per task instructions).

## 2026-07-06 — profile federation findings (live verification)

- Display name and avatar federate on ANY outgoing message (encrypted
  headers) — verified: bob's node showed "Carol Sparkle" + her avatar file
  after one broadcast post.
- **Bio (`selfstatus`) federates only via 1:1 messages**, not broadcasts —
  verified empirically: two broadcast posts left bob's copy empty; a single
  reaction control DM delivered it. In practice bios spread to anyone you
  interact with (reply DM copies, reactions). Broadcast-only followers keep
  an empty bio until first direct interaction. Documented limitation.
- Headers/banners are local-only (no DC equivalent), as designed.

## 2026-07-06 — two live-found bug fixes

- `transport.post()` (`daemon/src/transport/deltachat.ts`) returned raw
  `rpc.getMessage(...)`, so the just-posted status echoed back with the SELF
  placeholder display name "Me". Now wraps both send paths in a `loadOwn`
  helper applying the same `withSelfDisplayName` override `loadMessages`/`self()`
  use. Audited the file: `post()` was the only single-raw-message returner;
  `message()` already routes through `loadMessages`, `blobPath()` only reads
  `msg.file`. No transport-layer unit test by convention (openTransport is only
  exercised by the integration suite, not run here) — the `server.test.ts` fake
  doesn't model the "Me" placeholder so it can't cover this.
- `serveFile` (`daemon/src/server.ts`) served avatars/blobs/headers with no
  Content-Type (defaulted to text/plain). Added `contentTypeForPath` sniffing
  the extension (png/jpg/jpeg/webp/gif/svg → image/*; else
  application/octet-stream); no new RPC calls. Covered by new
  `served-file content types` suite in `daemon/tests/server.test.ts`.

## 2026-07-06 — follow-back via invite-request (`meta/issues/follow-back-invite-request.md`)

Made the profile Follow button real for known contacts: instead of pasting an
invite link, a daemon *asks* a contact (any follower / anyone we share a
verified 1:1 channel with) for their feed invite and joins on the reply.

### Wire convention (`daemon/src/protocol.ts`)

- `buildInviteRequestText()` → `⇋ invite-request` (human-readable to vanilla
  DC users). `parseInviteRequest(text)` is tolerant: true iff the *first line*
  starts with the marker (trailing human text on that line allowed), so we
  never misfire on ordinary messages that merely contain the glyph.
- `buildInviteGrantText(link)` → `⇋ invite <link>`. `parseInviteGrant(text)`
  recovers the link only if it *looks like* an invite (`https://i.delta.chat/`
  or `OPENPGP4FPR:`), so a grant-shaped DM carrying a bogus/hostile URL never
  reaches `follow()`. Round-trip + tolerance tests in `tests/protocol.test.ts`.
- These control DMs are inert to the existing parsers: `parseReaction`
  (needs the ` ↳ ` infix) and `parseMarkers` (needs REPLY/BOOST prefixes)
  both fall through to plain-body, so they register no reply/boost edge and
  never crash the reaction path. They're DMs, so edge-gating already excludes
  them anyway; verified by a `deriveOnIngest` test asserting zero notifications.

### Store (`daemon/src/store.ts`)

`pendingFollowRequests: Record<addr, requestedAtMs>`, persisted, with
`add`/`clear`/`has`/list accessors. Callers pass timestamps in (`Date.now()`
at daemon call sites; fixed values in tests) so the store stays pure/testable.

### Async side effects from a sync derivation pass (`daemon/src/ingest.ts`)

Interpreting these DMs needs *async* transport work (reply with our invite;
securejoin a feed), but `deriveOnIngest` and the whole store-derivation path
are sync. Rather than force async in, a sibling **pure** function
`deriveFollowbackActions(store, msg)` returns typed actions —
`{kind:'grant-invite', toContactId}` / `{kind:'accept-grant', link, fromAddr}`
— gated purely on store+message state (never transport). `main.ts`'s ingest
hook executes them against the live `Transport` via `executeFollowbackAction`:

- `grant-invite`: `feedInvite()` → `sendControlDm(buildInviteGrantText(...))`.
- `accept-grant`: `follow(link)` then clear the pending marker (in a `finally`,
  even if the join throws — a persistently-failing link must never loop
  re-answering the same grant on every restart).

Actions flow: transport `onMessage` hook (`deltachat.ts`) → `main.ts`
`ingestOnMessage(msg, isFeedMessage, mid, phase)` → `deriveFollowbackActions`
→ `executeFollowbackAction(store, transport, action)` → transport RPC.

### Phase gating (the restart-safety wrinkle)

`main.ts` executes actions **only for live (`'combined'`) messages**. The
startup backfill sweep (`'index'`/`'derive'`) must not re-grant or re-join old
requests — otherwise a restart would re-answer every historical
invite-request and re-join every historical grant. During the `'derive'`
backfill pass we still run `cleanupFollowbackAction` (pending-state cleanup
only, no network): a grant that arrived while the daemon was down clears the
now-satisfied pending marker, so `requested` doesn't stick for a follow that
completed before shutdown.

### Follow endpoint + relationships (`daemon/src/server.ts`)

`POST /api/v1/accounts/:id/follow` is now real: resolve the contact (404 if
unknown); if already following, return the current relationship unchanged;
otherwise `sendControlDm(buildInviteRequestText(), friendlyQuote)`, record
pending by address, return `{following:false, requested:true}`. The
relationships/lookup/`:id` endpoints report `requested` from the store for
pending addrs (via a shared `relationshipForContact` helper). When the grant
later arrives and the join completes, the pending entry is cleared, so
`following` flips true through the normal `transport.following()` path and
`requested` stops sticking.

### Security reasoning

- **Pending-gating prevents unsolicited joins.** An incoming `⇋ invite <link>`
  grant is auto-joined *only if* `store.hasPendingFollowRequest(sender)` — i.e.
  we actually asked. `deriveFollowbackActions` returns no action for a grant
  from a sender with no pending entry, so a stranger DMing us a feed invite can
  never silently subscribe us to their feed. Exercised directly in the
  integration file's fast unit-style "unsolicited grant" case (action for a
  pending sender, none for a non-pending one — proving the gate is the
  difference).
- **Open auto-grant policy (v1), documented.** We grant our feed invite to
  *anyone* who asks (never to SELF; idempotent on repeats). This is a
  deliberate v1 choice: a "locked account" deny mode (grant only to approved
  requesters) is future work. Granting a *read-only* broadcast invite is far
  lower-stakes than auto-*joining* someone else's feed, which is why the
  asymmetric gating (open grant, pending-gated accept) is safe.

### Integration test (`daemon/tests/integration/followback.test.ts`)

Real network, fresh accounts + `data/int-followback-{alice,bob}` dirs. A and B
both create feeds; B follows A via A's link; A follows B back by DMing an
invite-request over the shared channel (driven the way `main.ts` wires
ingestion — a minimal live-`'combined'` ingest loop per node; no test
shortcuts). B's ingest auto-grants; A's ingest joins B's feed off the grant
and clears pending. Asserts A ends up with B's feed (B posts → A receives) and
A's pending entry is cleared. A learns B's contact id from the inviter-side
`SecurejoinInviterProgress` event (broadcast followers don't post into A's
feed, so `contactIdByAddr` may not resolve yet). Full `pnpm test:integration`
green (4 tests, ~97s).

## 2026-07-06 — follow-back review corrections (duplicate execution + DM-only gating)

Code review caught two wiring gaps in the follow-back implementation:

- **Duplicate execution.** The follow-back block in `main.ts` ran on *every*
  live delivery of a message — but one DM can reach the ingest hook via both
  `IncomingMsg` AND the `MsgsChanged` safety net (plus repeat `MsgsChanged`
  on state changes), so a single invite-request could send multiple grant
  DMs. Fix: `store.ingestMessage` now returns a freshness boolean (`true` =
  first time this msgId is seen, `false` = already-ingested no-op), and
  action execution is gated on it for `'combined'`-phase messages. The
  backfill `'derive'` cleanup path is untouched (idempotent by design).
- **DM-only gating.** `deriveFollowbackActions` never saw `isFeedMessage`, so
  a broadcast *post* containing `⇋ invite-request` would have made every
  follower auto-DM the poster a grant (unintended amplification — the
  convention is 1:1 DM-only). Fix: `isFeedMessage` is now a required
  parameter and the function derives nothing for feed messages; gating lives
  inside the pure function so no caller can forget it.

While wiring the gates, the whole follow-back half of the ingest hook moved
out of `main.ts` into an exported `runFollowbackOnIngest(store, transport,
msg, isFeedMessage, phase, freshlyIngested)` in `src/ingest.ts` — `main.ts`
and the integration test's mirrored ingest loop now call the *same* function,
and the phase/freshness/DM-only rules are unit-tested directly
(`tests/followback.test.ts`: same msgId twice → exactly one grant DM / one
join; feed message with the marker → no actions even when fresh; `'derive'`
→ cleanup only; `'index'` → nothing; no transport yet → no-op).
Re-ran the follow-back integration test after the change: still green, so the
freshness gate doesn't starve legitimate first-time execution.

## 2026-07-06 — canonical-mid unification (dual-copy identity split)

Fixed the dual-copy identity split (../meta/issues/canonical-mid-unification.md):
a reply is sent twice — feed broadcast copy + DM copy to the parent author —
under two different rfc724 Message-IDs, so a non-follower parent (who only
holds the DM copy) references the DM mid in their replies/reactions, and those
interactions never landed on the feed copy that timelines/threads render.

### Design

- **Marker**: DM reply copies append a final `⚓ <feedMid>` line declaring the
  feed copy's mid (the post's canonical identity). Anchor glyph, readable in
  vanilla Delta Chat, no collision with the other single-glyph markers. The
  feed copy keeps its exact prior `buildReplyText` format — its text is its
  identity for historical text-twin matching, so it must not change.
  `buildReplyTextWithCanonical` / `parseCanonicalMid` (final-line-only,
  tolerant) in `src/protocol.ts`; `parseMarkers` now peels a trailing canonical
  line before locating the reply marker so reply parsing still round-trips.
- **Store owns aliasing** (`src/store.ts`): a `canonicalByMid` (dmMid→feedMid)
  map, `canonicalize(mid)`, and `aliasMid(dmMid, feedMid)`. Normalization is
  applied **at write time** (edge/tally keys canonicalized in `ingestMessage`,
  `applyReaction`, `deriveOnIngest`) **AND at read time** (every lookup
  canonicalizes its query key). **Decision: re-key on alias insertion, not
  read-time union.** `aliasMid` migrates any edges/tallies/ownBoosts already
  registered under the dmMid onto the feedMid (merging reactor sets) — this is
  the belt for the case where the alias arrives *after* a reaction referencing
  the dm-mid was already applied. Read-time canonicalization is the braces
  (covers the reverse window and queries by either mid). Both orders unit-tested.
- **Historical text-twin aliasing during (re)index** (`learnAlias` in the store
  ingest): builds `text→feedMid` for SELF FEED messages and `text→dmMid` for
  SELF DM messages awaiting a twin, resolving whichever copy is swept second —
  order-independent (both orders unit-tested). An explicit `⚓` marker is
  honored for *any* author (a non-follower's DM copy declares its feed mid this
  way); text-twin matching stays SELF-only (only our own copies are guaranteed
  exact twins). Pre-fix copies are exact text twins, so carol's historical
  "cool pic" (86/87) heals on re-index.
- **Acting on a DM copy** (server point 5): `targetMid(transport, target)` in
  `src/server.ts` parses the target's `⚓` marker (pure, no extra RPC) and uses
  the canonical mid for the outgoing reply/react/boost ref when present, else
  `messageMid`. Reply send now posts the feed copy first, learns its mid, and
  builds the DM copy with the canonical marker appended.
- **Migration without data surgery**: a persisted `schemaVersion` (now 1). On
  loading an older/versionless store, `migrate()` drops the derived indices
  (mid maps, edges, tallies, ingestedMsgIds, ownMids, alias map) but KEEPS
  `notifications` + `notificationDedupeKeys` + `nextNotificationId` +
  `pendingFollowRequests`, then the startup backfill re-indexes with aliasing.
  Verified: re-derivation can't duplicate-notify (dedupe keys survive — unit
  test re-adds the same favourite and gets a null no-op) and no DC database is
  touched, so QA nodes heal on a plain restart.

### Emoji normalization — WITHDRAWN

The paired emoji-normalization issue was withdrawn on user review: bare `❤`
(the favourite wire encoding) and `❤️` VS16 (a deliberate red-heart emoji
reaction) are two distinct interactions by design, not duplication — so no
variation-selector stripping, no heart merging. Favourite detection stays
exact-match bare `❤`; `❤️` keeps flowing through as a normal emoji_reactions
chip (unchanged behavior). Re-index re-derives tallies form-preserving.

### Tests

Unit: marker round-trip + tolerance, canonicalize at every touchpoint,
alias re-key (both orders), identical-text aliasing (both sweep orders,
non-self negatives, explicit-marker-wins), schema migration (index drop +
notification/dedupe/pending preservation + version bump), server "acting on a
DM copy" for reply/react/boost. Integration
(`tests/integration/canonical-mid.test.ts`, fresh accounts + `data/int-canon-*`):
the full QA scenario over real chatmail — B follows A (no follow-back), A posts,
B replies, A (holding only the DM copy) reacts ❤ and replies; asserts B's FEED
copy shows replies_count 1 + favourites_count 1 and the thread chains through
feed-chat conversation ids. Green on first real run (~17s).
`pnpm test` (527) + `pnpm check` + `pnpm test:integration` (5) all green.

### Review fix: resolveMid canonical-first

`resolveMid` initially tried the raw mid before the canonical one — so a
HISTORICAL ref pointing at a DM copy's mid (pre-fix data on a migrated store)
raw-hit the DM twin's msgId and context ancestors still routed through the
Single-chat copy (right counts, wrong copy). Flipped to canonical-first with
raw as fallback: `midToMsgId[canon(mid)] ?? midToMsgId[mid]`. The fallback
preserves the legitimate case where the canonical feed copy doesn't exist
locally (a non-follower's node only ever received the DM copy). Audited the
other lookups: everything that routes rendering (ancestor walk, notification
statusMsgId, status mapping resolver) goes through `store.resolveMid`, so the
one flip covers them; `isOwnMid` is an order-independent boolean OR; all other
store lookups already key by `canon(mid)` only. Unit tests added for both
sides (both copies ingested → FEED msgId; alias known but feed copy absent →
DM msgId).

## 2026-07-06 — non-follower thread rendering + own-reaction re-index (schema v2)

Fixed the two non-follower-node QA regressions from
../meta/issues/non-follower-thread-rendering.md, found on lain's node (lain
does NOT follow carol):

1. **DM-only replies were invisible in threads.** Reply edges registered only
   from FEED messages, but a non-follower holds a reply solely as its DM copy —
   so the thread edge was never created and the reply never rendered.
2. **Own reactions vanished on re-index.** The migration re-derives tallies
   from messages, but `deriveOnIngest` skipped all SELF-authored messages, so
   our own outgoing reaction control DMs never re-applied — reactions we made
   were only ever applied directly by the REST endpoint, and a fresh store lost
   them.

### Design

- **`replyChildren` value shape: msgId -> child CANONICAL mid** (store schema
  `STORE_SCHEMA_VERSION = 2`). Storing the child's canonical mid (not its
  msgId) means the feed copy and DM copy of one logical reply collapse to a
  single child entry once aliased (set-add dedupe), AND a DM-only reply keeps a
  thread edge that resolves back to the DM copy. Registered from BOTH feed
  copies and Single-chat DM reply-marker messages (reply markers only — DMs
  still register nothing else: reactions/boosts/control DMs register no edges,
  and boost edges stay feed-only since boosts have no DM twin to unify).
- **childrenCount counting choice: count ALL children (resolvable or not).**
  It represents the logical reply count — a reply we've only heard referenced
  but never received still counts, even though it can't render. `replyChildren`
  (the *renderable* list) resolves each stored child mid to a msgId and skips
  unresolvable ones; the two intentionally differ. Both dedupe by canonical
  child mid defensively (an alias learned late could momentarily leave a
  dm/feed pair in the raw list before the next write-time sweep).
- **`applyAlias` now sweeps replyChildren VALUE lists too.** On learning
  `dmMid -> feedMid` it (a) re-keys any children under the dmMid onto the feedMid
  (KEY re-key, existing), and (b) walks every value list mapping `dmMid ->
  feedMid` and deduping (VALUE re-key, new) — a child edge may have been
  registered against the DM copy's mid before its alias was learned. Read paths
  (`replyChildren`/`replyChildMids`/`childrenCount`) canonicalize child mids
  defensively too.
- **`resolveMid` reverse-alias fallback.** A DM-only reply's child edge is keyed
  by the CANONICAL (feed) mid the node will never receive, so `midToMsgId[feedMid]`
  is empty. Added a third fallback after canonical-first/raw: a reverse scan of
  `canonicalByMid` for any dmMid that aliases to this feed mid and IS indexed,
  resolving to the DM copy the node actually holds. This is what makes the
  DM-only reply render (via the new `replyChildMids` BFS in the context
  endpoint) instead of resolving to null.
- **Context descendants BFS** now walks `store.replyChildMids(mid)` (canonical
  child mids), resolves each to a msgId via `resolveMid` (skip nulls but still
  recurse on the child's own canonical mid so an unheld middle node doesn't sever
  its subtree), and recurses. Replaced the old msgId-list + `messageMid`
  round-trip.
- **SELF reaction re-derivation.** `deriveOnIngest` gained an optional 4th
  `ownAddr` param. A SELF reaction/unreaction control DM now re-applies OUR OWN
  tally keyed by `ownAddr` (idempotent set-add). **How own-address reaches
  derivation:** threaded from the ingest call sites — `server.ts`'s `ingest`
  passes `await mapper.ownAddr(transport)` (memoized); `main.ts`'s
  `ingestOnMessage` passes `ownSelfAddr(msg)`, a memoized helper that prefers
  the live transport's `self()` but falls back to a SELF message's own sender
  address during the startup backfill's `'derive'` pass (when the module
  `transport` var is not yet assigned). The function stays pure. SELF still
  derives ZERO notifications and no follow-back actions; the followback path
  still ignores SELF; the endpoints' direct-apply stays (idempotent double-apply
  is fine). Reaction target mids canonicalize as before.
  - *Backfill order caveat* (noted in code): within one chat `getMessageIds` is
    chronological, so a react then a later unreact of the same mid replay in
    order and the retract wins; across chats ordering is irrelevant since
    distinct chats hold reactions for distinct mids.
- **Migration.** `migrate()` already drops `replyChildren` among all derived
  indices (verified) and keeps notifications/dedupe keys/pending — so a v1
  store's stale msgId-valued `replyChildren` is dropped and the backfill
  re-derives the v2 canonical-mid values on restart. No data surgery; QA nodes
  heal on a plain restart.

### Tests

- Unit: DM-only reply edge registration; feed+DM copy collapse to one child on
  alias (dedupe); alias-later VALUE + KEY re-key; childrenCount counts ALL
  (including an unheld child); reverse-alias `resolveMid` (child keyed by feed
  mid, feed copy absent -> resolves to DM copy); SELF reaction re-derivation
  (apply, idempotent, react-then-unreact ordering, canonicalized target,
  reply/boost still derive nothing); v1->v2 migration drops replyChildren.
- Integration (`tests/integration/non-follower-thread.test.ts`, fresh accounts
  + `data/int-nf-*`): B follows A, A does NOT follow B. A posts; B replies; A
  reacts ❤ and replies to B's reply (holding only the DM copy). On A's node the
  thread of A's original shows B's reply (from the DM copy) and A's
  reply-to-reply, with A's own ❤ on B's reply. Then **simulate the migration**:
  close A's transport, delete ONLY the test's own
  `data/int-nf-a/deltanet-store.json`, reopen, wait for the backfill re-index,
  and re-assert the thread + own reaction — all recovered. On B's (follower)
  node the same reply shows exactly ONE reply-to-reply and ONE favourite (no
  double-count). Green on real chatmail.

`pnpm test` (541) + `pnpm check` + `pnpm test:integration` (6) all green.

## 2026-07-06 — hotfix: historical other-author reply twins double-counted (schema v3)

Live regression on a migrated v2 store (real node, verified via API): a
HISTORICAL reply from another author rendered TWICE in threads and inflated
replies_count. On the follower's node the other party's reply exists as a feed
copy (msg 88) AND a pre-canonical DM copy (msg 89, no `⚓` marker — it predates
the marker). The new DM-edge registration registered BOTH as children under two
different canonical mids, because the historical text-twin aliasing in
`learnAlias` only matched SELF-authored copies. New data was unaffected
(markers create the alias at ingest); historical data from OTHER authors was
not.

Fix: **text-twin aliasing generalized from SELF-only to per-author.** Twin
condition: same sender ADDRESS + byte-identical text — which includes the reply
marker — one copy in a feed chat and one in a Single chat → alias
dmMid → feedMid. Order-independent like the SELF version (pending maps now
keyed by `senderAddr + NUL + text`, both arrival orders unit-tested; fields
renamed `selfFeedTextToMid`/`selfDmPendingText` →
`feedTextToMid`/`dmPendingText`, safe since migration drops them anyway).
Safety rationale (in code): a false positive requires an author sending the
exact same reply-marked text as both a feed post and a separate DM — which is,
by construction, the dual-copy pattern itself. As a corollary the matching is
now gated on the text actually carrying a reply marker (only replies are ever
sent as dual copies), so an author posting "lol" to their feed and separately
DMing "lol" is never equated — this gate was implicit before (SELF-only made it
moot) and is explicit + tested now.

`STORE_SCHEMA_VERSION` bumped to **3** so already-migrated v2 stores (they
exist in the wild as of tonight) re-index once more with the generalized
aliasing; the usual migrate-drop covers everything, no data surgery, plain
restart heals.

Tests: other-author twin aliasing (both sweep orders); different-address and
non-reply-marked negatives; follower-side no-double-count as a unit-level store
test — a pre-canonical (marker-less) other-author feed+DM reply pair registers
exactly ONE child, both sweep orders (preferred over re-running the integration
suite per review guidance — topology unchanged, and the integration test's
post-fix DM copies always carry markers so they can't reproduce the marker-less
case anyway). Two tests in the child-edge block that relied on identical-text
copies NOT auto-aliasing now use differing bodies so the explicit
`aliasMid`-later VALUE-sweep path stays covered in isolation. Migration test
added for v2 → v3 (double-child footprint dropped, version bumped).
`pnpm test` (546) + `pnpm check` green.

## 2026-07-06 — wire convention v1: author-minted logical post UUIDs (schema v4)

Implemented ../meta/issues/post-uuids.md in full. Message-ID-based refs cannot
unify the two copies of a logical reply across a third party: a reply's feed
copy and DM copy have two different rfc724 mids, and a node holding only one
copy (or only a ref to the other) can't resolve. Live orphan: bob couldn't
resolve lain's reply ref to carol's DM copy. Fixed at the protocol level —
every logical post is now minted an author-side UUIDv4 carried in ALL its
copies, and refs target that uuid. This SUPERSEDES the `⚓` canonical-mid marker
+ text-twin aliasing for NEW data (both kept parse-only / legacy-only).

### Design decisions (delegated to me by the brief)

- **Marker glyph/format: `⚑ <uuidv4>`** as the final line of every outgoing
  status message (plain post, reply, boost, and the DM copy of a reply).
  Pennant reads sensibly in vanilla Delta Chat and doesn't collide with the
  other single-glyph markers (`⚓ ♻ ↳ ⇋`). Tolerant final-line parse like the
  others (`parsePostUuid`). `buildPostText(body, uuid)` is the new plain-post
  builder; a media-only post is just the marker line.
- **Ref-token discrimination: explicit `u:` prefix for uuid refs, bare token
  for mids** (`RefToken = {kind:'uuid',uuid} | {kind:'mid',mid}`,
  `buildRefToken`/`parseRefToken`). Shape alone would suffice here (uuidv4 has
  no `@`, mids in this deployment always do), but the explicit tag means the
  parser never guesses and stays robust to future mid shapes. Documented as
  belt-and-braces. `MsgRef` became `{ key: RefToken; keyString; addr }` —
  `keyString` is the opaque post-key value (uuid or mid) callers pass straight
  to the store.
- **DM copy no longer carries `⚓`.** The reply send path mints ONE uuid and
  embeds it in BOTH the feed copy and the DM copy — which are now byte-identical
  — so a node holding either unifies the logical reply via the shared uuid. The
  `⚓` marker is stopped on emit (`buildReplyTextWithCanonical` deleted) but
  `parseCanonicalMid` is kept so pre-v1 DM copies on migrated stores still
  resolve; `parseMarkers` peels a trailing `⚑` first, then a legacy `⚓`, then
  the reply/boost marker.

### Store: the post-key keyspace

- `postKey(msg) = parsePostUuid(text) ?? canonicalize(mid)`. Every derived index
  is keyed by post key: `replyChildren` (parent KEY and child VALUES),
  `boostsByMid`, `ownBoosts`, `ownMids`, `reactions`, plus notification
  dedupe/statusMsgId. Follow-back state is mid-free and untouched.
- **`resolveKey(key) → msgId`**: a uuid key resolves via a new `uuidToMsgIds`
  index, PREFERRING the feed copy. The store can't see DC chat types, so
  `ingestMessage` records the feed copy specially in `uuidFeedMsgId` from the
  `isFeedMessage` flag it already receives; `resolveKey` returns
  `uuidFeedMsgId[uuid] ?? uuidToMsgIds[uuid][0]`, then falls through the existing
  canonical-mid chain (canonical-first + reverse-alias) for mid-shaped keys.
  `resolveMid` stays as a synonym.
- **`midForMsgId` now returns the post KEY** (new persistent `msgIdToKey`,
  canonicalized at read for late-learned legacy aliases). This is what makes the
  mapper's `childrenCount`/`boostCount`/`reactionTallies` lookups hit the
  uuid-keyed edges of a v1 post rather than its raw mid.
- Ref → key at the edges: `refKey(keyString)` = the uuid for a uuid ref, else
  `canon(mid)`. Mirrored in ingest.ts (`refKey(store, ref)`) and server.ts
  (`refKeyString`).

### Emit paths (server.ts)

`targetRef(transport, target)` picks the target's ref token: its `⚑` uuid if it
carries one → uuid ref (resolves on ANY node holding ANY copy, including a third
party with only the feed copy — the case mid refs couldn't do); else a legacy
`⚓` canonical mid; else its own mid. Reply/boost/reaction/unreaction all target
that token; reaction control DMs carry the token verbatim (parser
discriminates). Unreblog and the local reaction apply now key by the target's
post key too. Context: ancestors resolve `parsed.reply.keyString` via
`resolveKey`; the descendants BFS roots at the target's own post key
(`midForMsgId`) and resolves child post keys.

### parentId fallback removal

`messageToStatus` no longer falls back to `msg.parentId` for `in_reply_to_id`
(DC sets parentId from email References to the previous same-chat message — not
authorship-level reply intent; it made replies render as replying to unrelated
posts). Resolution is now marker/uuid-only, null otherwise. Also simplified the
content body to always use `parsed.body` (which strips the `⚑` line too, so a
plain v1 post never renders its uuid marker). Regression unit test: a reply with
an unresolvable ref AND a set `parentId` renders `in_reply_to_id` null.

### Migration / dedupe (schema v4)

`STORE_SCHEMA_VERSION = 4`; `migrate` drops all derived indices including the
new uuid indices (`...emptyData()` resets them) and keeps
notifications/dedupeKeys/pending as before. **Dedupe safety across the v3→v4
post-key switch**: legacy messages carry no `⚑` marker, so `postKey` falls back
to the canonical mid for them — exactly the key era-3 dedupe keys were computed
under. A v3→v4 re-index therefore recomputes the SAME `type:addr:mid[:emoji]`
keys (preserved), so historical events never re-notify. Only v1 messages key by
uuid, and none exist in a v3 store. Proven by a v3→v4 unit test: a legacy
mention + favourite survive the migration and re-adding the same events dedupes
to no-ops.

### What supersedes what

- `⚑` uuid unification SUPERSEDES `⚓` canonical-mid marker + `learnAlias`
  text-twin aliasing for NEW messages. The canonical-mid machinery
  (`canonicalByMid`, `aliasMid`, reverse-alias resolution, `learnAlias`) is
  RETAINED for legacy (marker-less / `⚓`-marked) data on migrated stores — its
  store tests were converted to build legacy no-uuid reply text.
- The reply-child VALUE re-key on alias insertion is now mostly redundant for
  v1 data (both copies share a uuid, so they collapse at ingest) but still
  covers legacy pairs.

### Tests

- Unit (573 total): protocol round-trips (uuid marker, ref-token
  discrimination, both-copies-one-uuid via shared uuid, reaction tokens,
  legacy `⚓` parse-only); store post-key keyspace (resolveKey, feed-copy
  preference, uuid-targeted child edges, distinct-uuid = distinct children);
  entities parentId-fallback-removal regression; v3→v4 no-double-notify
  migration.
- Integration (7 total, real chatmail): NEW `post-uuids.test.ts` — C follows A
  and B, B follows A, A doesn't follow B; A posts, B replies, A replies to B's
  reply holding only B's DM copy; on C (feed copies only) the full thread
  renders connected, A's reply resolving to B's FEED reply via uuid
  (in_reply_to chains A→B→A, replies_count correct). The two existing DM-copy
  integration tests updated to detect the DM copy by its `⚑` marker.

`pnpm test` (573) + `pnpm check` + `pnpm test:integration` (7) all green.

## 2026-07-07 — podman-based ephemeral chatmail relay for integration tests

Integration tests created throwaway accounts on the *production*
`nine.testrun.org` relay — rude at scale and non-reproducible (relies on the
public network + that relay staying up). Now the suite provisions its own
ephemeral chatmail relay in a podman container per run, offline after the
image build.

### The in-container deploy (build-time vs first-boot split)

Studied the upstream `chatmail/docker` image and reproduced its split (the
relay's `cmdeploy` is explicitly container-aware — `basedeploy.has_systemd` /
`is_in_container` exist precisely so image builds work):

- **Build time** (`daemon/testenv/Containerfile`): Debian 12 + systemd base
  (vendored jrei/systemd-debian recipe), clone `chatmail/relay` at a pinned
  ref, create the `cmdeploy` venv (editable install), then run **only the
  `install` stage** (`CMDEPLOY_STAGES=install pyinfra @local run.py`) against
  a dummy `build.local` domain. The install stage is non-systemd (apt
  packages + chatmaild venv), so it runs fine during the build with no PID-1.
- **First boot**: systemd comes up as PID 1 (`podman run --systemd=always`);
  a oneshot `chatmail-init.service` runs `cmdeploy init` +
  `cmdeploy run --ssh-host @local --skip-dns-check`, i.e. the
  `configure,activate` stages: self-signed cert, service configs, and starts
  postfix/dovecot/nginx/unbound/filtermail/etc. `/new` is the real chatmail
  CGI (`newemail.py`) behind nginx, so signup exercises the real path and
  sends pass real filtermail encryption enforcement.

Domain is `_chatmail.example` — the leading `_` makes `config.py` pick
`tls_cert_mode: self` and skips DNS/MX/DKIM. No external network needed.

### Port / env contract

`testenv/relay.sh {build,up,down}` publishes to `127.0.0.1` only:
HTTPS/`/new` `8443`→443, IMAPS `9993`→993, SMTPS `9465`→465. `up`
force-removes any old container, runs fresh with tmpfs-backed mail state (so
every run is a clean slate), waits until `POST /new` returns creds **and** an
IMAPS TLS handshake succeeds, then prints `export DELTANET_TEST_RELAY_*`
lines. `resolveTestRelayConfig` (unit-tested) reads those; default = local
relay with explicit transport params + cert acceptance,
`DELTANET_TEST_RELAY=testrun` = the old `nine.testrun.org` autoconfig path
(no podman). Vitest globalSetup shells to `relay.sh up` / teardown to `down`
(`vitest.integration.config.ts`, `fileParallelism:false`).

### Transport: explicit-server path

`openTransport` gained an optional `transportParams`
`{imapHost,imapPort,smtpHost,smtpPort,acceptInvalidCerts}`. When set it
`setConfig(displayname)` then `rpc.addTransport(EnteredLoginParam{...})`
(IMAP/SMTP `ssl`, `certificateChecks: acceptInvalidCertificates`) instead of
`batchSetConfig + configure()` autoconfig. Pure builder
`buildEnteredLoginParam` is unit-tested.

### The one real fight: TLS 1.3 over podman's forwarder

Delta Chat core (rustls) could not complete a **TLS 1.3** handshake to the
relay through podman's port-forwarding path (the macOS podman machine's
gvproxy): dovecot logged `SSL_accept() failed: unsupported protocol` and
postfix STARTTLS reported `bad protocol version` — while `curl` (OpenSSL) on
the *same* socket succeeded every time. Chatmail ships a TLS-1.3-only floor
(dovecot `ssl_min_protocol=TLSv1.3`; postfix `smtps`/`submission` per-service
`smtpd_tls_mandatory_protocols=>=TLSv1.3` overrides in `master.cf`, which a
global `postconf -e` does *not* touch). `chatmail-init.sh` lowers just the
*floor* to `TLSv1.2` after `cmdeploy run`; core then negotiates 1.2 through
the forwarder. Real clients on a real relay still negotiate 1.3. This is the
only deviation from a stock chatmail deploy, and it's confined to the
throwaway test relay.

### Verification

- `pnpm -C daemon test` — 580 unit (was 573; +7: `relay-config.test.ts`),
  green, unaffected.
- `pnpm -C daemon check` — clean.
- `pnpm -C daemon test:integration` against the local podman relay — 7/7 pass
  (~146s), twice in a row including from a cold `podman rm`-ed state.

Image ~1.1 GB. First build a few minutes; subsequent boots ~20-30s to healthy.

## 2026-07-07 — wire convention v2: JSON envelope bodies (decisions 0001/0002)

Per docs/decisions.md 0001 (hard cut from vanilla-DC rendering compat) and
0002 (no synthesized statuses), the whole message body is now a single
**versioned JSON envelope** instead of the v0/v1 text markers. This kills the
in-band ambiguity class (a real chat message like `♻ hello` can no longer be
misread as protocol) and lifts the one-glyph-per-verb ceiling.

### The envelope (src/envelope.ts)

The ENTIRE message text is one JSON object:

```
{"dn":2,"type":"post"|"reply"|"boost"|"react"|"unreact"
        |"invite-request"|"invite-grant",
 "uuid":"...", "text":"...", "ref":{...}, "media":{"description":...},
 "emoji":"...", "link":"..."}
```

- `dn` gates parsing: **strict `dn===2`**. Wrong/missing `dn`, unknown `type`,
  malformed JSON, a JSON array/scalar → `parseEnvelope` returns null and the
  text is treated as **plain human content** (an external sender's real chat
  message must never crash or misparse).
- Refs are typed: `{"u":"<uuid>","addr":"..."}` (uuid-first) or
  `{"mid":"<mid>","addr":"..."}` (legacy targets). `addr` rides along for
  attribution/notification without a lookup.
- `media.description` carries **persistent, federated alt text** on posts/
  replies with attachments — this REPLACES the in-memory mediaStore alt-text
  hack (chatmail has no per-attachment alt field). The mediaStore registry is
  kept ONLY for pre-send upload staging (`/api/v1/media` → post attach).
- Reserved and never emitted / never repurposed: **`pubkey`, `sig`** (post
  attestations, design-sketch #6). Unknown fields are ignored (forward-compat).

### Emission is v2-only; reads are mixed-era

ALL protocol messages emit v2 (posts, replies incl. the DM copy — byte-
identical to the feed copy, SAME uuid — boosts, react/unreact DMs, invite-
request/grant). No `quotedText` anywhere (compat bubbles retired). Boost is
`type:"boost"` + ref: per 0002 it does NOT embed the original content
(unverifiable embedding returns WITH attestations later).

`src/wire.ts` is the single read seam: `parseWire`/`parseWireUuid`/
`parseWireReaction`/`parseWireInviteRequest`/`parseWireInviteGrant` try the v2
envelope FIRST, then fall back to the v0/v1 marker parsers (src/protocol.ts,
kept read-side for existing histories — NOT deleted), then plain text. Store,
ingest, mapping, entities, and server all read through this seam, so a mixed-
era thread (legacy `⚑`/`⚓`/`↳re` parent + v2 reply, or the reverse) resolves
consistently. The post-key keyspace is unchanged: a v2 `uuid` field feeds
`postKey` exactly as the v1 `⚑` marker did.

### No synthesized statuses (0002)

`synthesizeStatus`/`synthesizeAccount` are **removed entirely** (grep-clean).
An unresolvable boost (any era) now renders as the BOOSTER's own status:
`content` = a fixed placeholder (`[boosted post unavailable]`), `reblog: null`,
plus `pleroma.deltanet: {placeholder:"boost", ref:{key,addr}}` so the frontend
distinguishes it. A resolvable boost still embeds the recipient's own verified
copy. The notification-account fallback (a real, core-PGP-verified interaction
author whose Contact row we lack) moved to `addrToAccount` — NOT synthesized
content attribution, just a display shell; id `0` marks it non-resolvable.

### Store schema v5

`STORE_SCHEMA_VERSION = 5` (re-index parses mixed-era data via `parseWire`).
`migrate` drops the derived indices and keeps notifications/dedupe/pending as
before. **Dedupe continuity**: legacy messages carry no uuid (neither `⚑` nor a
v2 `uuid` field), so `postKey` falls back to the canonical mid — the same key
era-3/era-4 dedupe used. A v4→v5 re-index recomputes identical
`type:addr:mid[:emoji]` keys (preserved), so no historical event re-notifies
(proven by a v4→v5 unit test).

### Also: DC-core version pinning (separate small item)

`@deltachat/stdio-rpc-server` and `@deltachat/jsonrpc-client` are pinned to
EXACT `2.53.0` (dropped `^`) with a `comments.deltachat-core-pinning` note in
package.json: the core is the federation substrate, so a bump changes wire/
securejoin/RPC behavior and must be a deliberate, tested event — never an
incidental float. Bump both together and re-run the integration suite.

### Wire-convention status

v2 (JSON envelope) is THE format. v0 (bare markers) / v1 (`⚑` uuid + `⚓`
canonical) are **read-only legacy** — parsed for existing histories, never
emitted. Revisit dropping the read-side parsers once test-era data stops
mattering (per 0001).

### Tests

- Unit (643, was 580): NEW `envelope.test.ts` (round-trips, strict `dn===2`
  gate, malformed-JSON→null, array/scalar rejection, unknown-field tolerance,
  reserved-field absence, pretty-print) + `wire.test.ts` (v2-first then legacy
  then plain, per verb). entities: unresolvable boost → placeholder (no
  synthesize), v2 envelope federated alt text. store: mixed-era threads
  (v1 parent + v2 reply, and the symmetric case), v2 boost of a legacy parent,
  v4→v5 no-double-notify migration. server: reply/boost/react/invite paths
  assert emitted v2 envelopes + no quotedText + no marker glyphs.
- Integration (local podman relay): existing DM-copy detection switched from
  `⚑`-marker sniffing to v2-envelope parse (`parseWireUuid`); `post-uuids`
  extended to assert the DM copy and B's feed copy share ONE uuid (byte-
  identical envelopes) and that a v2 reply resolves against a v2 parent cross-
  node on third-party C.

## 2026-07-07 — post attestations: signed envelopes + verifiable boosts (sketch #6, 0002)

Every content envelope (post/reply/boost) is now signed with a per-account
ed25519 key; boosts embed the boosted post's COMPLETE signed envelope (+
re-attached media, verified by content hash) as `orig`, so a recipient who never
met the original author can verify it offline. Republishers can OMIT (reply
control) but never ALTER or FABRICATE. Attestation is the ADMISSION rule for
republished content, not an overlay — unverifiable embeds render placeholders
(0002), never partial/attributed content.

### Canonical payload (src/attest.ts)

The signature covers a payload RECONSTRUCTED FROM FIELDS, never the raw JSON, so
re-serialization (key order, whitespace, ignored fields) can't break
verification. Fixed-order, per-field LENGTH-PREFIXED, version-prefixed:

```
lp(dn2) lp(type) lp(uuid) lp(addr) lp(ts) lp(text) lp(refToken) lp(mediaSha256)
```

concatenated with no separator, where `lp(x) = <utf8ByteLength(x)>:<x>`. Empty
parts frame as `0:` (constant field count). `refToken` is the ref's opaque key
string (uuid or bare mid); `mediaSha256` is the lowercase-hex sha256 of the
attached file. Version prefix `dn2` gates the layout so it can evolve.

**Why length-prefixing, not a bare NUL join** (review-caught bug, fixed same
day, pre-deploy so no signatures existed to preserve): `text` and `refToken`
are attacker-controlled JSON strings that CAN contain NUL, so a bare
`join('\0')` was ambiguous — `(text:"a\0b", ref:"c")` and `(text:"a",
ref:"b\0c")` concatenated to identical bytes, meaning ONE signature verified
TWO different envelopes (e.g. a plain post re-presented as a reply to an
attacker-chosen target). The decimal byte-length prefix makes every field
self-delimiting: no byte value can shift a frame boundary, and there is no
rejected-content class (NUL-bearing text still signs/verifies). Guarded by
tamper-matrix tests: the exact re-split pair must not cross-verify, NUL text
round-trips, and framing-mimicking content (`text` ending in `"<len>:<next>"`)
doesn't collide with the honest split.

### Keys (src/attest.ts)

`openAttestor(keyPath)` — path injected exactly like the store path (data dir).
Lazy `generateKeyPairSync('ed25519')`, persisted as `deltanet-signing-key.json`
(PKCS#8-PEM private + base64 SPKI-DER public), mode 0600, NEVER logged. `pubkey`
on the wire is the base64 SPKI DER (carries the algorithm OID; a raw 32-byte key
is ambiguous). `sign(env, addr)` → `{ ts, pubkey, sig }`; `verify(env, addr)` is
pure (no key files) and never throws.

### TOFU pinning (src/ingest.ts + store `pinnedKeys`)

`store.pinnedKeys: Record<addr, pubkey>` — additive field (no schema bump; the
`{...emptyData(), ...raw}` load tolerates it) and preserved through `migrate`
like notifications/pending (a pin is a trust root, not a derivable index).
`pinKey` is first-wins; conflicts surface at verify time. Pin hook lives in
`deriveOnIngest`: any non-SELF DIRECT delivery (core-PGP verified — feed or DM,
both securejoin/Autocrypt channels) whose OUTER envelope carries a pubkey pins
`sender.address → pubkey`. NEVER from an embedded boost `orig` (a booster could
seed a fake pin) — we read the pubkey off the outer envelope only.

### Boost embedding (server.ts reblog path)

The booster holds the target message: its TEXT IS the boosted post's envelope →
parse and embed VERBATIM as `orig`. Embed only if the target is a SIGNED v2
envelope (has sig+pubkey); unsigned/legacy → ref-only boost (recipient gets the
placeholder ladder). If the orig declares `media.sha256`, re-attach the SAME
file to the boost message (transport `post({file})`); a media target with no
signed sha256 → ref-only (never a fabricated hash).

### Rendering ladder (entities.ts + mapping.ts)

Per boost, in order: (a) own-copy — ref resolves locally → embed the recipient's
own verified copy (unchanged); (b) verified-orig — `orig` present AND sig
verifies AND pin-consistent AND (media declared → boost's attached file hashes
to the signed sha256) → render orig as a real status via an addr-based account
shell (`addrToAccount`, extended to carry an attested display name only if the
envelope declares one — never invented); (c) placeholder — `'boost'`
(absent/legacy) or `'boost-unverified'` (embed present but FAILED verification).
0002: a failed verification is a placeholder, never partial content.

The verified embed's nested `reblog` id is `orig-<uuid>` — synthetic-FREE
(uuid = author-minted logical-post id), a string the frontend treats opaquely
(`PleromaStatus.id: string`; precedent `notif-boost` fixture id). `created_at`
uses `orig.ts`; media url points at the BOOST message's own blob route (bytes
live there). Verification is async (hashes a file, reads pins) so it's computed
in `mapping.ts` `toStatus` and handed to the sync `messageToStatus`; result is
cached per boost msgId (mapping runs per render).

### Tests

- Unit (725, was 672): NEW `attest.test.ts` (canonical round-trip/stability/
  injectivity + framing-ambiguity probes: NUL re-split non-collision and
  non-cross-verify, NUL round-trip, framing-mimicry; sha256, key gen/persist/
  0600, sign→verify, full tamper matrix)
  + `boost-embed.test.ts` (the rendering ladder end-to-end via `createStatusMapper`:
  verified embed w/ media, `'boost'` vs `'boost-unverified'`, tamper matrix —
  altered text / wrong pubkey / pin conflict / media-hash mismatch / declared-
  media-no-file / pin-consistent-still-renders). store: TOFU pin first-wins +
  reload + migrate survival. ingest: pin from direct delivery, never from an
  embedded orig, not from SELF/unsigned. server: reply/post envelopes are signed
  (verify round-trip); reblog embeds a signed orig verbatim, stays ref-only for
  unsigned targets.
- Integration (local podman relay): NEW `boost-attestation.test.ts` — the exact
  A/B/C topology WITH AN IMAGE. B follows A, C follows only B; A posts a signed
  image; B boosts (embeds A's orig + re-attaches the image); C renders the boost
  with A's text, A's addr, and the image, and the blob C serves hashes to the
  original A signed. ~29s.
