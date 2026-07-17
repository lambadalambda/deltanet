# Second-device pairing (backup-transfer QR)

## Summary

Split from the backup issue's stretch goal. Core supports live
device-to-device transfer: `provideBackup`/`getBackupQr` on the existing
device, `getBackup(qr)` on the new one — no file juggling. Expose it:

- Settings: "Add another device" → daemon calls `provideBackup`, shows
  the QR/text (time-limited); status feedback until retrieved/cancelled.
- Onboarding: "Set up from another device" → paste/scan the QR →
  `getBackup` imports (the restore-instead-of-signup flow shares
  everything after the transfer: creds read-back, sidecar handling needs
  a solution — NOTE: unlike restore from the legacy-compatible `.dnbk` format,
  the DEVICE TRANSFER carries only core's data; the Headwater sidecar (signing
  key + store) must ride separately, e.g. via a follow-up self-DM or by reusing
  the `.dnbk` compatibility sidecar packing over the transfer channel. This is
  the design question to solve before implementing.)
- Concurrent-device caveat (document): two daemons on one account is NOT
  a supported steady state (feed chat ids, store divergence); pairing is
  for MIGRATION or cold-spare setup. Decide + enforce/warn.

## Acceptance Criteria

- Existing device can offer a transfer; a fresh daemon can adopt the
  account from it, ending with identity + follows + history + SIGNING KEY
  + store intact (integration test, mirroring the legacy `.dnbk` restore test).
