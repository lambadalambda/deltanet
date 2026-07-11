# DeltaNet

Your own single-user social network that federates over **encrypted email**.

DeltaNet looks and feels like Pleroma/Mastodon, but there is no instance and
no ActivityPub: you run a small daemon on your own machine, your identity is
an email address on a [chatmail](https://chatmail.at) relay (registered for
you at sign-up, no form to fill), and your feed is an end-to-end-encrypted
broadcast channel on the Delta Chat network. Following someone means joining
their feed via an invite link. The mail servers only ever see ciphertext,
and store-and-forward delivery means your node doesn't need to be online
24/7 to receive posts.

```
frontend (SvelteKit SPA, served by the daemon)
      │  Mastodon/Pleroma client API (localhost)
daemon (this repo: Mastodon API ⇄ chat messages)
      │  JSON-RPC — deltachat-rpc-server (chatmail core)
      │  SMTP/IMAP + Autocrypt (OpenPGP)
any email / chatmail relay
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
they are installed and released as separate packages. The empty root importer
lockfile is also intentional: pnpm's root script lifecycle maintains it even
though dependencies are installed only in the two packages. Root scripts invoke
each package with the same pinned pnpm version; run them through
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
served SPA, onboarding while no account is configured, instance metadata, and
sanitized public timeline/profile projections are the only anonymous surfaces.

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
- Auth state defaults to `${DELTANET_DATA}.auth.json`. It is atomically replaced
  and forced to mode `0600`. Deleting it while the daemon is stopped rotates the
  blob-signing secret and invalidates every browser session and OAuth client.
- Existing browser storage containing the former fixed `deltanet-token` is not
  accepted. Those browsers naturally return to sign-in and receive a random
  session.
- Every message blob requires either the Bearer header or a short-lived signed
  URL capability, including public-looking, malformed, and control-message
  attachments. Signed URLs let normal `<img>` loading work without exposing the
  bearer. An already-issued capability can remain usable for at most 60 seconds
  after session/client revocation; blob responses are always `private, no-store`.
  Sanitized public avatars and headers remain anonymous projections.

CORS echoes only `DELTANET_BASE_URL`'s origin and the comma-separated origins in
`DELTANET_ALLOWED_ORIGINS`; it never emits `*`. The production SPA needs no
extra origin because the daemon serves it same-origin. For a separate Vite dev
server, start the daemon with an explicit origin, for example:

```sh
env DELTANET_ALLOWED_ORIGINS=http://localhost:5173 mise exec -- pnpm start
```

Useful environment settings are documented in `daemon/.env.example`. A
non-loopback `DELTANET_HOSTNAME` is rejected unless
`DELTANET_ALLOW_NON_LOOPBACK=1` is also set. That opt-in does not add TLS or
make Bearer tokens safe on an untrusted LAN; use an HTTPS-authenticated reverse
proxy, set `DELTANET_BASE_URL` to its real origin, and restrict
`DELTANET_ALLOWED_ORIGINS` when intentionally exposing the listener.

Signup uses `https://nine.testrun.org` by default. Custom relay selection is an
operator-controlled capability: add exact HTTPS origins to the comma-separated
`DELTANET_SIGNUP_RELAYS` setting before starting the daemon. Relay URLs with
credentials, paths, queries, or fragments are rejected, and an API caller
cannot choose an origin outside that allowlist. Selecting any non-default relay
also requires the current one-time enrollment code printed by the daemon.
Private and loopback relays use the same explicit setting and must present a valid TLS certificate. The
self-signed podman relay is enabled only inside the isolated integration-test
worker, which relaxes certificate verification for that worker process.

## Running two nodes locally (testing federation)

One checkout can run any number of nodes — each is just a port + an account
name + a data directory. From `daemon/`:

```sh
# node A on :4030 (also serves the web UI)
mise exec -- pnpm start

# node B on :4031, in a second terminal
env PORT=4031 DELTANET_ACCOUNT=second DELTANET_DATA=data/second mise exec -- pnpm start
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
curl -s localhost:4030/api/deltanet/invite \
     -H "Authorization: Bearer $DELTANET_TOKEN"       # get A's invite
curl -s -X POST localhost:4031/api/deltanet/follow \
     -H "Authorization: Bearer $DELTANET_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"invite": "<paste it here>"}'               # B follows A
```

Private API calls require a session issued by the OAuth sign-in flow; the
example assumes its raw value is available as `DELTANET_TOKEN`. Tokens are
shown only once by `/oauth/token` and are otherwise held in that browser
origin's local storage. Each node port has a separate browser origin, client,
session, and default auth file, so two local nodes do not collide.

Notes:

- Both nodes can talk to the same relay (default nine.testrun.org) — the
  federation still goes through real SMTP/IMAP, so this is a genuine
  end-to-end test, not a loopback shortcut. Use different relays per node
  to test cross-relay federation.
- `mise exec -- pnpm -C daemon test:integration` does an automated version of this
  (register two throwaway accounts, follow, post, assert delivery,
  unfollow/refollow) — a good smoke test after changes. Integration tests
  always use their own `data/int-*` dirs and fresh accounts; never point
  them at a data dir a running daemon owns.
- Killing a daemon and restarting it is safe: the mail server holds
  undelivered messages (store-and-forward), and the daemon's local index
  rebuilds from its Delta Chat database on startup.

## Backup & restore

Your node's data directory **is** your identity: the OpenPGP key lives in the
Delta Chat database, the relay stores nothing for you (and deletes addresses
idle for ~90 days), and the post-attestation signing key that followers pin
lives next to it. Losing the disk without a backup means losing the account.

- **Backup:** Settings → Backup — pick a passphrase and download a `.dnbk`
  file. It contains core's passphrase-encrypted backup tar plus an encrypted
  sidecar (the attestation signing key and the daemon's index), so a restore
  brings back *everything*: address, follows, history, and the signing key
  (followers' key pins keep verifying).
- **Restore:** on a fresh node, choose **Restore from a backup** on the
  landing page's Create-account tab instead of signing up. Or over the API:
  `POST /api/deltanet/restore` (multipart `file` + `passphrase`);
  `POST /api/deltanet/backup/export` (`{"passphrase": ...}`) produces the
  download; `GET /api/deltanet/backup` reports the last backup time.

The passphrase is not recoverable — a wrong one fails cleanly (the container
is authenticated) without touching the node.

## Testing against a local relay

By default `mise exec -- pnpm -C daemon test:integration` provisions its own **ephemeral
chatmail relay in a podman container** and runs the whole suite against it —
no accounts are created on the public `nine.testrun.org`, and the run needs
no external network once the image is built.

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
  `DELTANET_TEST_RELAY=testrun`. Then podman is not used at all.

The test relay uses a self-signed cert and an `_chatmail.example` domain; the
daemon's transport connects with explicit IMAP/SMTP host+port and
accept-invalid-certificates login params (see
`daemon/src/transport/deltachat.ts`), so no DNS or valid TLS chain is needed.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request as a second
set of checks, in three jobs:

- **daemon** — typecheck + unit suite (fast, hermetic).
- **frontend** — typecheck + Playwright suite.
- **integration** — the full federation suite against a real chatmail relay
  built and booted as a systemd **podman** container on the hosted runner
  (`ubuntu-latest` ships podman + cgroup v2). This job builds the relay image
  each run, so it takes several minutes; a preflight step smoke-tests
  systemd-in-container first so a substrate failure is distinguishable from a
  relay-build or test failure.

## Repo layout

- `daemon/` — TypeScript daemon: Mastodon client API in front,
  `deltachat-rpc-server` behind. Unit tests (vitest) + a real-network
  federation integration test (`mise exec -- pnpm test:integration` from `daemon/`).
- `frontend/` — DeltaNet web UI, a fork of
  PleromaNet (a SvelteKit Pleroma frontend) reworked for invite-based
  federation and daemon sign-up. Playwright tests.

## Model (v0)

- **Post** → message in your broadcast channel, encrypted per follower.
- **Follow** → securejoin handshake from an `https://i.delta.chat/#…`
  invite link (capability-based: the link carries key fingerprint + secret).
- **Home timeline** → all messages in all feeds you've joined.
- **DMs, reactions, media** → native Delta Chat features, mapped onto the
  Mastodon API (partially wired up so far).

See `DEVLOG.md` for findings and design decisions.
