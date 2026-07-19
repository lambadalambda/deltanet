# Audit whole-app improvement opportunities

## Summary

Review Headwater across product behavior, protocol trust, recovery, security,
accessibility, performance, desktop distribution, operations, testing, and
maintainability, then produce a prioritized improvement list.

## Requirements

- Inspect the implementation and existing roadmap rather than relying on generic
  product advice.
- Separate verified risks from optional enhancements.
- Rank recommendations by user impact, urgency, and implementation effort.
- Preserve strengths that should not regress during follow-up work.

## Acceptance Criteria

- The review covers the major frontend, daemon, desktop, persistence, release,
  and operational surfaces.
- Recommendations cite concrete implementation evidence.
- The final list identifies a practical order of work.

## Notes

- Browser dogfooding was unavailable because `agent-browser` is not installed in
  the current environment; the review uses implementation, test, documentation,
  and independent specialist audits.
- Highest-priority trust work: sign visibility and all rendered/routing
  semantics, bind embedded originals to their outer references, make follower
  revocation durable and verifiable, require proof for every initial
  signup/restore, and strictly bound hostile wire input.
- Highest-priority recovery/release work: complete transactional backups,
  replace the whole-file JSON persistence ceiling, add desktop PR CI and
  operational recovery, then sign/notarize packages and updates.
- Highest-priority product work: remove fictitious discovery/community/filter
  surfaces, implement moderation and honest deletion semantics, explain relay
  constraints, and establish an accessibility baseline.
- Small high-return work includes pagination clamps, CSP/security headers,
  self-hosted fonts, request timeouts/response limits, media byte validation,
  reduced-motion support, consistent focus rings, and removal of inert controls.
- Preserve the existing strengths: extensive protocol/failure tests, atomic
  two-generation store recovery, mandatory desktop backup gate, narrow Electron
  privilege boundary, capability gating, and consistent loading/error states.
