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

## Repo layout

- `daemon/` — TypeScript daemon: Mastodon client API in front,
  `deltachat-rpc-server` behind. Unit tests (vitest) + a real-network
  federation integration test (`pnpm test:integration`).
- `frontend/` — DeltaNet web UI, a fork of
  [PleromaNet](https://github.com/…/pleromanet) reworked for invite-based
  federation and daemon sign-up. Playwright tests.

## Model (v0)

- **Post** → message in your broadcast channel, encrypted per follower.
- **Follow** → securejoin handshake from an `https://i.delta.chat/#…`
  invite link (capability-based: the link carries key fingerprint + secret).
- **Home timeline** → all messages in all feeds you've joined.
- **DMs, reactions, media** → native Delta Chat features, mapped onto the
  Mastodon API (partially wired up so far).

See `DEVLOG.md` for findings and design decisions.
