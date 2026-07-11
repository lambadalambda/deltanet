# DeltaNet

DeltaNet is the frontend for the deltanet daemon, speaking the Pleroma/Mastodon client API, focused on a reduced, refined interface. The visual design source file is now represented by the implementation plan in `meta/issues.md`.

## Status

This repository contains a SvelteKit TypeScript SPA/static frontend without SSR, backed by the real Pleroma API.

### Real App Surface

- `/` is the signed-out landing with the OAuth sign-in and create-account flows.
- `/app/...` is the authenticated app: home/local/federated timelines with streaming and pagination, thread detail with inline replies, profiles with follow/unfollow, search (header dropdown and full page), notifications with streaming and badge counts, and profile settings backed by `update_credentials`.
- The composer supports media uploads (browse, drag-and-drop, paste), content warnings, polls, mention and custom emoji autocomplete, and the full emoji picker. Posts render emoji reaction rows with reaction toggling.
- `/app/profiles/...` is also viewable signed out against `PUBLIC_PLEROMA_INSTANCE_URL`, with sign-in prompts on authenticated actions.
- `/public` shows anonymous local/federated public timelines.

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

DeltaNet targets the Pleroma-flavored client API directly and can rely on Pleroma-specific features being present. Pleroma API documentation is available at https://api.pleroma.social/.
