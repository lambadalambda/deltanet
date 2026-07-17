# Headwater

Your own single-user social network that federates over **encrypted email**.

Headwater looks and feels like Pleroma/Mastodon, but there is no multi-user
instance and no ActivityPub: you run a small daemon on your own machine, your
identity is an email address on a [chatmail](https://chatmail.at) relay
(registered for you at sign-up, no form to fill), and your feed is an
end-to-end-encrypted broadcast channel on the Delta Chat network. Following
someone means joining their feed via an invite link. Relays temporarily store
encrypted mail and cannot read message bodies or recover your identity keys;
they still observe delivery metadata such as sender/recipient addresses,
timing, and sizes. Store-and-forward delivery means your node can sleep and
catch up later, within the relay's finite retention window.

```
frontend (SvelteKit SPA, served by the daemon)
      │  Mastodon/Pleroma client API (localhost)
daemon (Mastodon API ⇄ chat messages)
      │  JSON-RPC — deltachat-rpc-server (chatmail core)
      │  SMTP/IMAP + Autocrypt (OpenPGP)
chatmail relay
```

## Quick start

Requirements: [mise](https://mise.jdx.dev), which pins Node 24 and pnpm 11.5.2.
If managing tools yourself, use Node `>=24 <25` and exactly pnpm `11.5.2` to
match package metadata and CI.

```sh
mise install
mise run setup     # install daemon + frontend deps
mise run build     # build the frontend
mise exec -- pnpm start  # daemon on http://localhost:4030, serving the UI
```

The daemon and frontend intentionally keep separate dependency lockfiles because
they have independent dependency graphs and build contexts. The empty root
importer lockfile is also intentional: pnpm's root script lifecycle maintains it
even though dependencies are installed only in the two packages. Root scripts
invoke each package with the same pinned pnpm version; run them through
`mise exec -- pnpm`, or use the equivalent root tasks (`mise run setup`,
`check`, `test`, and `build`).

Open http://localhost:4030 and keep the daemon terminal visible. For an existing
account, enter the one-time enrollment code printed at startup the first time a
browser signs in; later sign-ins reuse that browser's persisted OAuth client
until explicit signout forgets and unpairs it.
For a new account, pick a display name on the **Create account** tab, then enter
the fresh enrollment code printed after signup. You get a new chatmail address
and feed invite. Share the invite so people can follow you; paste someone else's
invite into the search box to follow them.

## Local API security

The daemon listens on `127.0.0.1` by default and treats localhost as a network
location, not as authorization. The browser signs in through the local OAuth
flow and sends an unguessable Bearer session on every private REST request.
Before opening a WebSocket it exchanges that bearer for a one-use, 30-second
stream ticket, so the long-lived token never appears in a WebSocket URL. The
anonymous surface is deliberately bounded: the served SPA; status and
enrollment-protected OAuth bootstrap; signup/restore while no account is
configured; instance/discovery metadata; sanitized public timeline, profile,
avatar, and header projections; and message blobs carrying a short-lived signed
capability.

- Initial OAuth client registration requires the single-use enrollment code
  printed by the daemon (valid for 10 minutes). The SPA persists that client per
  daemon instance and reuses it; entering a fresh code replaces the registration
  after an account/auth reset. The local flow accepts only the complete
  `read write follow push` scope.
- OAuth client secrets, enrollment codes, authorization codes, access tokens,
  and stream tickets are generated with 256 bits of randomness. Only hashes of
  secret values are stored by the daemon.
- At most one authorization code exists per client, the global code set is
  bounded, and each code expires after five minutes and is consumed by one exact
  client/redirect exchange. OAuth app, code, and token responses are explicitly
  non-cacheable. Sessions expire after 30 days and survive ordinary restarts.
- **Sign out & forget this browser** closes local streams and immediately removes
  both the browser session and its persisted OAuth client, then requests
  client-wide server revocation for at most two seconds. Successful revocation
  invalidates the client plus all its sessions, codes, and stream tickets, closes
  every associated live socket, and prints a fresh one-use enrollment code in
  the daemon terminal. The next sign-in cannot reuse retained client credentials
  and requires that fresh terminal code.
- Auth state defaults to `${HEADWATER_DATA}.auth.json`. It is atomically replaced
  and forced to mode `0600`. Deleting it while the daemon is stopped rotates the
  blob-signing secret and invalidates every browser session and OAuth client.
- Existing browser storage containing the legacy fixed `deltanet-token` key is
  not accepted. Those browsers naturally return to sign-in and receive a random
  session.
- Every message blob requires either the Bearer header or a short-lived signed
  URL capability, including public-looking, malformed, and control-message
  attachments. Signed URLs let normal `<img>` loading work without exposing the
  bearer. An already-issued capability can remain usable for at most 60 seconds
  after session/client revocation; blob responses are always `private, no-store`.
  Sanitized public avatars and headers remain anonymous projections.

CORS echoes only `HEADWATER_BASE_URL`'s origin and the comma-separated origins in
`HEADWATER_ALLOWED_ORIGINS`; it never emits `*`. The production SPA needs no
extra origin because the daemon serves it same-origin. For a separate Vite dev
server, start the daemon with an explicit origin, for example:

```sh
env HEADWATER_ALLOWED_ORIGINS=http://localhost:5173 mise exec -- pnpm start
```

Useful environment settings are documented in `daemon/.env.example`. A
non-loopback `HEADWATER_HOSTNAME` is rejected unless
`HEADWATER_ALLOW_NON_LOOPBACK=1` is also set. That opt-in does not add TLS or
make Bearer tokens safe on an untrusted LAN; use an HTTPS-authenticated reverse
proxy, set `HEADWATER_BASE_URL` to its real origin, and restrict
`HEADWATER_ALLOWED_ORIGINS` when intentionally exposing the listener.

Signup uses `https://nine.testrun.org` by default. Custom relay selection is an
operator-controlled capability: add exact HTTPS origins to the comma-separated
`HEADWATER_SIGNUP_RELAYS` setting before starting the daemon. Relay URLs with
credentials, paths, queries, or fragments are rejected, and an API caller
cannot choose an origin outside that allowlist. Selecting any non-default relay
also requires the current one-time enrollment code printed by the daemon.
Private and loopback relays use the same explicit setting and must present a
valid TLS certificate. The self-signed podman relay is enabled only inside the
isolated integration-test worker, which relaxes certificate verification for
that worker process.
Allowlisting a custom `/new` origin does not configure its mail transport: the
returned mailbox domain must still provide working Delta Chat DNS/`.well-known`
autoconfiguration and valid production IMAP/SMTP TLS.

## Running two nodes locally (testing federation)

One checkout can run any number of nodes — each is just a port + an account
name + a data directory. From `daemon/`:

```sh
# node A on :4030 (also serves the web UI)
mise exec -- pnpm start

# node B on :4031, in a second terminal
env PORT=4031 HEADWATER_ACCOUNT=second HEADWATER_DATA=data/second mise exec -- pnpm start
```

Then, in the browser:

1. Open http://localhost:4030 and http://localhost:4031 in two tabs — both
   serve the UI, and since they're different origins the sessions don't
   collide. Create an account on each (each signup registers a fresh
   address on the chatmail relay and stores it under its own key in
   `accounts.local.json`).
2. On tab A, copy the invite link from the "Share your feed" card.
3. On tab B, paste it into the search box and hit **Follow this feed**.
   Repeat in the other direction for mutual follows.
4. Post from either side. Delivery goes out as end-to-end-encrypted mail
   through the relay and lands on the other node in a few seconds — with
   the streaming websocket, the other tab shows a "new posts" pill and
   live notification badges without a refresh.

The same works over curl if you prefer scripts:

```sh
curl -s localhost:4030/api/headwater/invite \
     -H "Authorization: Bearer $HEADWATER_TOKEN_A"     # get A's invite
curl -s -X POST localhost:4031/api/headwater/follow \
     -H "Authorization: Bearer $HEADWATER_TOKEN_B" \
     -H 'Content-Type: application/json' \
     -d '{"invite": "<paste it here>"}'               # B follows A
```

Private API calls require a session issued by the OAuth sign-in flow; the
example assumes each node's raw value is available as `HEADWATER_TOKEN_A` or
`HEADWATER_TOKEN_B`. Tokens are shown only once by `/oauth/token` and are
otherwise held in that browser origin's local storage. Each node port has a
separate browser origin, client, session, and default auth file, so two local
nodes do not collide and cannot share a bearer token.

Notes:

- Both nodes can talk to the same relay (default nine.testrun.org) — the
  federation still goes through real SMTP/IMAP, so this is a genuine
  end-to-end test, not a loopback shortcut. Use different relays per node
  to test cross-relay federation.
- `mise exec -- pnpm -C daemon test:integration` does an automated version of
  this (register two throwaway accounts, follow, post, assert delivery,
  unfollow/refollow) — a good smoke test after changes. Integration tests
  always use their own `data/int-*` dirs and fresh accounts; never point
  them at a data dir a running daemon owns.
- Killing a daemon and restarting it is safe: the relay holds undelivered mail
  for up to 20 days (7 days for messages over 200 KiB, subject to quota), the
  daemon re-derives message indices from its Delta Chat database, and durable
  non-derivable state is recovered from `headwater-store.json` plus its recovery
  copy. A migrated node with the legacy `deltanet-store.json` filename keeps
  using that file rather than creating split state. A relay account is deleted
  after roughly 90 days without login.

## Backup & restore

Your node's data directory holds the cryptographic identity: the OpenPGP key
lives in the Delta Chat database, while the post-attestation signing key that
followers pin lives beside it. The live node also needs credentials and local
OAuth state, which default to files beside rather than inside the data
directory. Relays temporarily hold encrypted mail but not these private keys,
and delete accounts idle for roughly 90 days. Use Headwater's encrypted backup,
which retains the legacy-compatible `.dnbk` container extension, rather than
assuming that copying only `${HEADWATER_DATA}` captures every live-node file.

- **Backup:** Settings → Backup — pick a passphrase and download a
  `headwater-backup-*.dnbk` file. The `.dnbk` extension and `DNBK1` container
  marker are retained legacy format identifiers for restore compatibility. It
  contains core's passphrase-encrypted backup tar plus an encrypted
  sidecar containing the attestation signing key and durable daemon store. A
  restore brings back the address, OpenPGP identity, follows, message history,
  store state, and signing key, so followers' key pins keep verifying. Browser
  OAuth clients/sessions are intentionally not restored and require fresh
  enrollment. The custom daemon-local profile header (`header.png`) is not
  currently included; the avatar is core-backed.
- **Restore:** on a fresh node, choose **Restore from a backup** on the
  landing page's Create-account tab instead of signing up. Or over the API:
  `POST /api/headwater/restore` (multipart `file` + `passphrase`);
  `POST /api/headwater/backup/export` (`{"passphrase": ...}`) produces the
  download; `GET /api/headwater/backup` reports the last backup time.

The passphrase is not recoverable — a wrong one fails cleanly (the container
is authenticated) without touching the node.

## Testing against a local relay

By default `mise exec -- pnpm -C daemon test:integration` provisions its own
**ephemeral chatmail relay in a podman container** and runs the whole suite
against it — no accounts are created on the public `nine.testrun.org`, and the
run needs no external network once the image is built.

Requirements: **podman** (rootless is fine). The relay image is a real
[chatmail/relay](https://github.com/chatmail/relay) built via its own
`cmdeploy` on a Debian 12 + systemd base (see `daemon/testenv/`).

- **First build takes a while** (several minutes: it clones the relay, apt-
  installs postfix/dovecot/nginx/unbound and builds the chatmaild venv). The
  image is cached afterward, so subsequent runs just boot a container
  (~20-30s to healthy). Build it ahead of time with
  `daemon/testenv/relay.sh build` if you like; `test:integration` builds it
  on demand if missing.
- **Reset semantics:** every run starts a *fresh* container with tmpfs-backed
  mail state (`relay.sh up` force-removes any previous instance), so there is
  no state carried between runs — the suite is reproducible from a cold
  `podman rm`-ed state. Ports are published to `127.0.0.1` only (HTTPS/`/new`
  on `8443`, IMAPS on `9993`, SMTPS on `9465` by default).
- The vitest globalSetup/teardown (`daemon/tests/integration/global-setup.ts`)
  drives `relay.sh up`/`down` automatically; you don't run the container
  yourself.
- To run against the **real** `nine.testrun.org` relay instead (the old
  behavior — needs network, creates throwaway accounts there), set
  `HEADWATER_TEST_RELAY=testrun`. Then podman is not used at all.

The test relay uses a self-signed cert and an `_chatmail.example` domain; the
daemon's transport connects with explicit IMAP/SMTP host+port and
accept-invalid-certificates login params (see
`daemon/src/transport/deltachat.ts`), so no DNS or valid TLS chain is needed.

## Continuous integration

`.github/workflows/ci.yml` runs for pull requests and pushes to `main`, in three
jobs:

- **daemon** — typecheck + unit suite (fast, hermetic).
- **frontend** — typecheck + Playwright suite.
- **integration** — the full federation suite against a real chatmail relay
  built and booted as a systemd **podman** container on the hosted runner
  (`ubuntu-latest` ships podman + cgroup v2). This job builds the relay image
  each run, so it takes several minutes. A warning-only preflight confirms
  Podman can launch an image containing `systemctl`; the integration job itself
  is the test that the relay can boot under systemd.

## Repo layout

- `daemon/` — TypeScript daemon: Mastodon client API in front,
  `deltachat-rpc-server` behind. Vitest unit tests and a multi-scenario
  federation suite against the disposable relay.
- `frontend/` — Headwater web UI, a fork of
  PleromaNet (a SvelteKit Pleroma frontend) reworked for invite-based
  federation and daemon sign-up. Mocked Playwright tests plus an opt-in stock
  Pleroma compatibility check.
- `daemon/testenv/` — Podman chatmail relay image and lifecycle scripts used by
  daemon integration tests.
- `docs/` — architecture decisions, substrate audit, comparisons, and design
  sketches.
- `meta/` — repository-local issue tracker and the frontend/daemon capability
  contract.
- `mise.toml`, `package.json` — pinned toolchain and root orchestration.
- `.github/workflows/` — CI for daemon, frontend, and relay integration.

## Current capabilities

- **Posts and visibility:** signed wire-v2 envelopes in public or
  followers-only broadcast channels. Direct statuses are delivered to explicit
  mentions plus the parent author of a direct reply, and do not enter feed
  timelines. A broadcast encrypts the body once with its per-channel symmetric
  secret; SMTP recipient envelopes are then fanned out to members.
- **Following:** securejoin handshake from an `https://i.delta.chat/#…` invite
  link. Locked-channel invites grant followers-only access; follow requests use
  Headwater control messages.
- **Reading and discovery:** home/public/account timelines, profiles, known-user
  and locally held post search, replies, verified boosts, thread auto-backfill,
  and explicit thread subscriptions. There is no network-wide directory,
  hashtag search, or anonymously fetchable global post URL.
- **Interactions:** favourites, emoji reactions, mentions, notifications, and
  authenticated real-time streaming. Reaction tallies are authoritative on the
  original author's node; portable signed receipts remain planned.
- **Media and profile:** one PNG/JPEG/WebP/GIF image per post with alt text,
  plus display name, bio, avatar, custom local header, and petnames.
- **Recovery:** encrypted Headwater backup/restore using the legacy-compatible
  `.dnbk` container format, with identity, history, durable store, and
  attestation-key continuity.
- **Not yet available in the bundled daemon:** human chat/message threads,
  bookmarks, federated status deletion, mute/block, polls, unlisted visibility,
  content warnings, extended profile fields, and audio/video uploads. The UI
  hides or labels these through the capability contract rather than pretending
  they work.

See `meta/frontend-daemon-capabilities.md` for the exact API contract,
`docs/decisions.md` for standing decisions, and `DEVLOG.md` for implementation
history.

## DeltaNet migration compatibility

Headwater was formerly named DeltaNet. Fresh installs and all examples above
use Headwater names. Existing nodes are migrated without changing identity or
splitting state:

- `HEADWATER_*` is preferred. Deployed `DELTANET_*` environment variables remain
  fallback aliases; if both forms are set, the Headwater value wins.
- `/api/headwater/*` and `/headwater/*` are preferred. Legacy
  `/api/deltanet/*` and `/deltanet/*` routes remain aliases for old clients.
- API metadata is published under `configuration.headwater` and
  `pleroma.headwater`. Legacy `configuration.deltanet` and `pleroma.deltanet`
  namespaces remain compatibility mirrors during migration.
- New state uses `headwater-store.json` and `headwater-signing-key.json`. When a
  legacy `deltanet-store.json` or `deltanet-signing-key.json` already exists,
  Headwater keeps using it so it does not create a replacement feed identity,
  signing key, or divergent store.
- The `.dnbk` extension, `DNBK1` backup marker, `dn: 2`, `dn2`, and `dn3` signed
  protocol identifiers are immutable compatibility bytes, not current product
  branding. Existing backups and signed history remain readable and verifiable.
- Legacy browser keys, auth hash domains, core configuration keys, and
  `ui.deltanet.*` values are read for continuity; new browser and core state uses
  `headwater.*` and `ui.headwater.*` names.

The checkout directory and git remote still use the former repository slug.
Renaming either requires coordinated external follow-up and is intentionally
outside this source-tree migration.
