# Headwater

Headwater is the SvelteKit frontend for the Headwater daemon. It speaks a
Pleroma/Mastodon-shaped client API while presenting the invite-based encrypted
social model directly. The canonical visual handoff and implementation issues
live under `meta/`.

## Status

This directory contains a SvelteKit TypeScript SPA/static frontend without SSR.
It works with the bundled Headwater daemon and retains an opt-in compatibility
check against stock Pleroma. The bundled daemon publishes capability metadata;
mutable controls and routes are hidden or labeled when their persistence or
federation semantics are not implemented. The current Explore page is static
design/demo content, not real Headwater network discovery.

### Real App Surface

- `/` is the signed-out landing with the OAuth sign-in and create-account flows.
- `/app/...` is the authenticated app: a streaming/paginated home timeline,
  thread detail with inline replies and subscriptions, profiles with
  follow/unfollow, known-content search, notifications, invite sharing, backup,
  and profile settings.
- The composer supports public, followers-only, and mentioned-recipient direct
  statuses; one image upload through the bundled daemon; mention/custom-emoji
  autocomplete; and the full emoji picker. Content-warning and poll controls
  exist for compatible Pleroma servers but remain capability-disabled on
  Headwater until their signed federation contracts are implemented.
- Posts render replies, verified boosts, image media, favourites, and emoji
  reactions. Human chat threads, bookmarks, deletion, moderation, polls,
  unlisted visibility, content warnings, extended profiles, and audio/video are
  explicitly unavailable when connected to the bundled daemon.
- `/app/profiles/...` can also render signed-out public projections, with
  sign-in prompts on authenticated actions.
- `/public` is a stock-Pleroma compatibility/demo route backed by
  `PUBLIC_PLEROMA_INSTANCE_URL`; it is not Headwater-wide discovery. A daemon's
  anonymous public timeline is its own sanitized local projection.
- `/app/explore` is also a static design specimen today; its hashtags,
  communities, and Join toggles do not represent daemon-backed discovery.

### Design Reference Surfaces

- `/design-system` is the component/design showcase with mocked content, ported section by section from the canonical handoff in `meta/design/claude-handoff/`.

## Development Principles

- TDD first: red, green, refactor.
- pnpm 11.5.2 is the package manager, with Node 24 and tool versions managed by mise.
- TypeScript is the application language.
- SvelteKit is the application framework, configured as an SPA/static frontend without SSR.
- Svelte 5 only, using current patterns and no legacy usage.
- Functional TypeScript style: arrow functions, no application classes.
- Small, topical commits. Large features are split into smaller commits.
- Detailed contributor and agent rules live in `AGENTS.md`.

## Developing

Install dependencies:

```sh
mise exec -- pnpm install
```

Start a development server:

```sh
mise exec -- pnpm dev

# or start the server and open the app in a new browser tab
mise exec -- pnpm dev -- --open
```

## Testing

Default tests are Playwright headless browser tests with mocked/local data only. They do not require Docker or a live Pleroma instance.

```sh
mise exec -- pnpm test
```

Run type checks:

```sh
mise exec -- pnpm check
```

Equivalent mise tasks are available:

```sh
mise run test
mise run check
mise run build
```

Dockerized integration tests are opt-in:

```sh
mise run test:integration
```

See `docs/integration.md` for backend version, debugging, and cleanup details.

## Building

To create a production version of your app:

```sh
mise exec -- pnpm build
```

Preview the production build:

```sh
mise exec -- pnpm preview
```

## API Reference

The frontend targets a Pleroma-flavored client API. Stock Pleroma-specific
features are used only when the connected server supports them; bundled
Headwater behavior follows the explicit contract in
`../meta/frontend-daemon-capabilities.md`. Pleroma API documentation is
available at https://api.pleroma.social/.
