# Frontend-daemon capability contract

The bundled frontend reads `configuration.headwater.capabilities` from
`GET /api/v2/instance`. Missing metadata is treated conservatively until the
request completes; a non-Headwater Pleroma instance retains the ordinary
Pleroma feature set.

During migration, the daemon also emits the same data under the legacy
`configuration.deltanet` and `pleroma.deltanet` namespaces, and readers may
fall back to those names for deployed nodes. New responses, frontend requests,
tests, and documentation must prefer `configuration.headwater` and
`pleroma.headwater`. Headwater-specific API and resource calls likewise prefer
`/api/headwater/*` and `/headwater/*`; the former `/api/deltanet/*` and
`/deltanet/*` routes are compatibility aliases only.

## Implemented

| Surface | Frontend calls | Contract |
| --- | --- | --- |
| Instance and auth | `GET /api/v1|v2/instance`, app registration, OAuth authorize/token/revoke | Persisted OAuth clients and bearer sessions; stable JSON errors. |
| Accounts and profiles | verify/update credentials, account/lookup/search/relationships, follow/unfollow, follow requests | Delta Chat contacts and channel membership are authoritative; profile media is local/core-backed. |
| Timelines and status reads | home/public/account timelines, status/context, search | Control chats are excluded; public projections enforce feed provenance. |
| Posting | create status/reply with one media id and public/private/direct visibility | Signed durable envelopes; one transport file; direct and private delivery semantics are daemon-enforced. |
| Interactions | favourite/unfavourite, reblog/unreblog, emoji reactions, thread subscribe/unsubscribe | Persisted/derived through signed control envelopes and Store state; unknown targets return 404. |
| Media | upload, update description, explicit staged-media delete | 40 MiB file and 4 KiB description limits; one-hour staging; alt text enters the signed envelope. |
| Notifications and streaming | notifications, stream ticket, user WebSocket | Store-backed notifications and one-use session-bound stream tickets. |
| Headwater extensions | invite/follow, petname, locked-access request, backup/export/restore | Explicit Headwater JSON contracts covered by daemon tests. |

Read-only custom emoji, trends, suggestions, filters, markers, and preferences
are intentionally empty discovery surfaces. They do not imply a mutable
feature.

## Unavailable

| Capability flag | Decision in bundled frontend | Missing daemon contract |
| --- | --- | --- |
| `bookmarks` | Post controls hidden; route retained with unavailable copy; no API request | Bookmark/unbookmark mutation and persisted bookmark timeline. |
| `status_deletion` | Delete controls hidden | Retraction/deletion federation and durable tombstones. |
| `account_moderation` | Mute/block controls hidden | Persisted moderation state and filtering semantics. |
| `media_description` | Enabled | Implemented `PUT /api/v1/media/:id`; not deferred. |
| `chats` | Messages route retained with unavailable copy; no chat API request | Chat list/thread/send/read/delete mapping and persistence. |
| `polls` | Poll composition hidden; received polls render read-only with disabled voting copy | Poll creation, voting, expiry, persistence, and federation. |
| `unlisted_visibility` | Unlisted is removed from the visibility menu | A non-public-feed delivery/projection contract. |
| `content_warnings` | Home and reply CW controls are hidden | Signed warning text and copy/backfill semantics. |
| `extended_profile` | Website, location, discoverability, and follower-count controls are replaced by unavailable copy | Persistent profile fields and privacy preferences. |

The upload picker is also constrained by
`configuration.media_attachments.supported_mime_types`; the bundled daemon
advertises PNG, JPEG, WebP, and GIF images only. One attachment is accepted,
matching `configuration.statuses.max_media_attachments` and the transport.

The daemon deliberately returns 404 for unavailable mutable and collection
routes rather than returning success-shaped stubs. A frontend action may be
enabled only when its advertised capability is true and a daemon contract test
covers the route and response shape.
