# 62 Invite and follow-by-invite UI

## Summary

Following someone in deltanet means joining their feed via an invite link (an `https://i.delta.chat/#...` URL), not searching a federated firehose. Add UI to share your own invite link and to follow someone else's.

## API (daemon-provided, contract fixed)

- `GET /api/deltanet/invite` → `{"invite": "https://i.delta.chat/#..."}`
- `POST /api/deltanet/follow` JSON `{"invite": string}` → `{"chat_id": number}` | 422

## Requirements

- "Share your feed": fetch `GET /api/deltanet/invite` and show the invite link with a copy-to-clipboard button. Placed as a card on the authenticated home sidebar under the profile stats (`ProfileMini`), matching existing card styling.
- Follow-by-invite: detect when the header search input contains a feed invite (starts with `https://i.delta.chat/` or `OPENPGP4FPR:`) and, instead of normal search behavior, offer a "Follow this feed" action in the dropdown.
- On confirm, `POST /api/deltanet/follow`; show a success/failure toast (reuse the existing `post-control-toast` pattern).

## Acceptance Criteria

- Playwright coverage: invite card fetch + copy-to-clipboard, follow-by-invite detection in header search + confirm + success toast, and a failure/422 toast path.
- `pnpm run check` and the full test suite pass.

## Notes

- Part of the larger deltanet frontend pivot.

## Current Status

Done (2026-07-06, pending orchestrator commit). `src/lib/pleroma/deltanet.ts` gained `fetchDeltanetInvite`, `isFeedInvite`, and `followDeltanetInvite`. The app shell's left sidebar shows a "Share your feed" card (`data-testid="invite-card"`) under ProfileMini with the invite link and a copy-to-clipboard button (reuses writeClipboardText + post-control toast); loading/error states are handled and the card resets on session change/sign-out. The header search detects invites (https://i.delta.chat/ or OPENPGP4FPR:), suppresses normal search/submit, and offers a "Follow this feed" action in the dropdown; confirm POSTs /api/deltanet/follow and toasts "Followed that feed" or "Could not follow: <reason>". 4 tests in app-invite.e2e.ts cover invite render+copy, invite load failure, follow happy path with request-body assertion, and the OPENPGP4FPR 422 failure toast.
