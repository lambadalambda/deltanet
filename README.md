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

Requirements: [mise](https://mise.jdx.dev) (or node 24+ and pnpm yourself).

```sh
pnpm run setup     # install daemon + frontend deps
pnpm run build     # build the frontend
pnpm start         # daemon on http://localhost:4030, serving the UI
```

Open http://localhost:4030, pick a display name on the **Create account**
tab, and you're federated: you get a fresh address on a chatmail relay and
your feed's invite link. Share the invite so people can follow you; paste
someone else's invite into the search box to follow them.

## Running two nodes locally (testing federation)

One checkout can run any number of nodes — each is just a port + an account
name + a data directory. From `daemon/`:

```sh
# node A on :4030 (also serves the web UI)
pnpm start

# node B on :4031, in a second terminal
env PORT=4031 DELTANET_ACCOUNT=second DELTANET_DATA=data/second pnpm start
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
curl -s localhost:4030/api/deltanet/invite            # get A's invite
curl -s -X POST localhost:4031/api/deltanet/follow \
     -H 'Content-Type: application/json' \
     -d '{"invite": "<paste it here>"}'               # B follows A
```

Notes:

- Both nodes can talk to the same relay (default nine.testrun.org) — the
  federation still goes through real SMTP/IMAP, so this is a genuine
  end-to-end test, not a loopback shortcut. Use different relays per node
  to test cross-relay federation.
- `daemon/pnpm test:integration` does an automated version of this
  (register two throwaway accounts, follow, post, assert delivery,
  unfollow/refollow) — a good smoke test after changes. Integration tests
  always use their own `data/int-*` dirs and fresh accounts; never point
  them at a data dir a running daemon owns.
- Killing a daemon and restarting it is safe: the mail server holds
  undelivered messages (store-and-forward), and the daemon's local index
  rebuilds from its Delta Chat database on startup.

## Repo layout

- `daemon/` — TypeScript daemon: Mastodon client API in front,
  `deltachat-rpc-server` behind. Unit tests (vitest) + a real-network
  federation integration test (`pnpm test:integration`).
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
