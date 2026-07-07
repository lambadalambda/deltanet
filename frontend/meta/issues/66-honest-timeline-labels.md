# 66 Honest timeline labels: remove Local/Federated tabs (done)

## Summary

The app's left nav offered "Local" and "Federated" tabs alongside "Home". Both
promise fediverse/instance semantics that deltanet does not have. Frontend half
of `../meta/issues/hygiene-core-pin-timeline-labels.md` (the core-pin half is
handled in the daemon repo).

## Root Cause

The daemon serves `/api/v1/timelines/home` and `/api/v1/timelines/public` with
the *same* handler; the `local` query param the client sends is ignored. So
Home, Local, and Federated render byte-identical data. "Federated" is a
fediverse concept deltanet (a chatmail-federated feed) does not have, and
"Local" (own-instance public) is equally meaningless — there is only your feed.

## Decision

Remove both Local and Federated from the authenticated app: nav item, tablist
handling, route parsing, streaming, and all the `appPublicTimeline*` plumbing
that backed them. Keep a single honest "Home". The signed-out `/public` route
and the landing page carried the same misleading Local/Federated split and
fediverse copy ("The federated timeline, right now") — collapse `/public` to a
single honest "Public feed" (one `timelines/public` slice, no tabs) and soften
the landing copy so it no longer promises a federated firehose.

Removal over rename: a renamed duplicate tab would still be a second surface
showing the same posts as Home; honesty means not shipping it.

## Requirements

- No `local` / `federated` nav item, route, or tablist in the authenticated app.
- `/public` renders one honest public feed, no Local/Federated tabs.
- Landing page copy no longer promises federated/fediverse timeline semantics.
- All affected Playwright tests updated; suite stays green.

## Acceptance Criteria

- `pnpm test` and `pnpm check` are green.
- No timeline label in the app promises semantics deltanet lacks.
