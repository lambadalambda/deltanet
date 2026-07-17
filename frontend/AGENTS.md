## Project Configuration

- **Language**: TypeScript
- **Package Manager**: pnpm
- **Add-ons**: playwright, sveltekit-adapter

---

# AGENTS.md

## Project

Headwater is the frontend for the Headwater daemon, speaking the Pleroma/Mastodon client API, with a reduced, refined visual style. The current design handoff is captured as implementation issues under `meta/issues.md` and should guide UI work.

## Core Rules

- Practice TDD: red, green, refactor.
- Prefer small, topical changes over broad rewrites.
- Make atomic, topical commits. Larger features should be split into smaller commits that each represent one logical change.
- Use `pnpm` for package management. Pin tool versions through `mise.toml` and, once scaffolded, `packageManager` plus the lockfile.
- Use mise tasks for complicated or repeated workflows, especially dockerized testing.
- Use TypeScript for application code, component props, and API client boundaries.
- Use SvelteKit as the application framework, configured for SPA/static output rather than SSR.
- Use Svelte 5 with current, non-legacy patterns. Keep dependency upgrades intentional through the lockfile.
- Follow the Svelte 5 docs: https://svelte.dev/docs/svelte/overview
- Use the Svelte 5 migration guide as a checklist for legacy patterns to avoid: https://svelte.dev/docs/svelte/v5-migration-guide
- Avoid legacy Svelte patterns: no `export let`, `on:` directives, `createEventDispatcher`, `<slot>`, `$:` reactive statements, or `new Component()` usage in application code.
- Use a functional TypeScript style: arrow functions, no application classes, and small composable functions.

## Testing

- Write tests before implementation when adding behavior.
- Use Playwright for headless browser testing.
- Use `pnpm exec playwright test` for `*.e2e.ts` route/browser tests.
- In this workspace, use `PLAYWRIGHT_BROWSERS_PATH="/var/folders/_k/0yhtrj754g59m75jw73827q80000gn/T/opencode/ms-playwright"` for local Playwright runs.
- Run focused Playwright suites with `--workers=1`; parallel Playwright can race on SvelteKit webServer output and cause `ERR_CONNECTION_REFUSED` or `.svelte-kit/output` copy errors.
- Default tests should be fast, deterministic, and not require Docker or a live Pleroma instance.
- Mock Pleroma backend behavior in default tests when needed.
- Integration tests should be dockerized and use an ephemeral dockerized Pleroma backend.
- Dockerized integration tests are not run by default.
- Keep dockerized integration tests in a clearly separated location or tag group, such as `tests/integration` or `@integration`.
- Run dockerized integration tests after larger changes, especially changes touching API behavior, authentication, persistence, or cross-page flows.
- Put dockerized integration test commands behind explicit mise tasks, such as `mise run test:integration`, once those commands exist.

## Pleroma API

- API documentation: https://api.pleroma.social/
- Target Pleroma directly and assume Pleroma-specific features are present.
- Do not add Mastodon-compatibility abstractions unless they serve a concrete Headwater need.
- Prefer typed, isolated API client code once the application scaffold exists.
- Keep API-facing tests independent from a live backend unless explicitly running integration tests.
- Mock Pleroma HTTP, WebSocket, and media upload endpoints in default tests.
- Media upload/status tests should assert multipart upload and `media_ids[]` serialization without a live backend.

## Implementation Preferences

- Keep changes minimal and direct.
- Preserve the project's reduced/refined direction; avoid generic dashboard aesthetics.
- Extract reusable Svelte components early so application development stays manageable; showcase stable components in `/design-system` with mock data when useful.
- Do not introduce backward-compatibility layers unless there is a concrete need.
- Do not write class declarations or class inheritance in application code. Framework internals and third-party APIs are exempt.
- Keep code comments rare and focused on non-obvious behavior.
- Agents should only create commits when explicitly requested.
- For larger UI/handoff slices, request a focused review before committing, especially when porting canonical design behavior into the real app.

## Composer Behavior

- Composer posts are valid with either text or uploaded media. Do not require both.
- Visible composer controls should work, be clearly disabled, or be hidden until implemented.
- Keep composer autocomplete, emoji picker, and attachment behavior keyboard-accessible and covered by Playwright tests.

## Canonical Design Handoff

- The canonical design bundle lives in `meta/design/claude-handoff/`.
- Treat `meta/design/claude-handoff/project/design-system.jsx` as the source of truth for the `/design-system` page structure and section order.
- Treat `meta/design/claude-handoff/project/design-system.css` as the source of truth for `/design-system` page styling.
- Treat `meta/design/claude-handoff/project/components.jsx` as the source of truth for shared reusable app primitives.
- Treat `meta/design/claude-handoff/project/styles.css` as the source of truth for global tokens, themes, app layout, and primitive CSS classes.
- Treat `meta/design/claude-handoff/project/attachments.jsx` as the source of truth for media and attachment behavior.
- Treat `meta/design/claude-handoff/project/mention-editor.jsx` as the source of truth for autocomplete editor behavior.
- Treat `meta/design/claude-handoff/project/emoji-picker.jsx` as the source of truth for full emoji picker behavior.
- Treat `meta/design/claude-handoff/project/composer-dropzone.jsx` as the source of truth for composer attachment/dropzone behavior.
- `/design-system` may include static state specimens; real app interactions should be implemented as reusable Svelte components when the behavior exists in the app.
- Port `/design-system` section by section from the JSX handoff into Svelte, stopping after each section for visual confirmation before continuing.
