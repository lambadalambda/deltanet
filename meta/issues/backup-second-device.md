# Backup & identity survival UX

## Summary

The data dir is the identity (private key in dc.db); the relay retains
nothing (20-day bus) and deletes accounts after 90 idle days. Losing the
disk = ceasing to exist. Core has everything needed (encrypted backup
export/import, device-to-device transfer, self-sync messages); the daemon
exposes none of it.

## Investigation findings (2026-07-07)

- Core RPCs exist and run to completion when awaited (jsonrpc 2.53.0):
  `exportBackup(accountId, destDir, passphrase)` writes a
  passphrase-encrypted `.tar` into `destDir`; `importBackup(accountId,
  path, passphrase)` restores it into a fresh account (config incl.
  addr/password/displayname included). `provideBackup`/`getBackup` (QR
  second-device transfer) also exist — deferred to a split issue.
- **The core backup is NOT the whole deltanet identity.** Two sidecar
  files in the data dir must survive too:
  - `deltanet-signing-key.json` — the ed25519 post-attestation key.
    NON-RECOVERABLE and TOFU-pinned by followers: losing it means every
    follower's pin breaks on our next post. MUST be in the backup, and
    it is secret material, so it must be encrypted.
  - `deltanet-store.json` — held envelopes / reaction tallies / pinned
    keys / thread subscriptions / hosted threads. Derived indices rebuild
    from dc.db on re-index, but held envelopes, pins, and thread chatIds
    do not. Should be in the backup.

## Design

**Container format `.dnbk`** (single downloadable file), pure functions in
`daemon/src/backup.ts` (unit-testable without core):

```
"DNBK1\n" (6 bytes) | u32BE sidecar-length | sidecar | core-backup-tar
sidecar = salt(16) | iv(12) | gcm-tag(16) | ciphertext
          AES-256-GCM, key = scryptSync(passphrase, salt, 32)
sidecar plaintext = JSON { addr, exportedAt, signingKey?, store? }
```

The core tar is already passphrase-encrypted by core (same passphrase);
the GCM tag gives an early, clean wrong-passphrase error before core
import is ever attempted. Passphrase is required non-empty. v0 assembles
the container in memory (single-user dc.db is tens of MB; noted as a
follow-up if media-heavy accounts make this a problem).

**Daemon:**

- `Transport.exportBackup(destDir, passphrase)` → path of the tar core
  wrote; stamps `ui.deltanet.last_backup_at` config on success (travels
  with future backups). `Transport.lastBackupAt()` reads it.
- `restoreTransport(dataDir, backupTarPath, passphrase)` in deltachat.ts:
  start core on the fresh dir → addAccount → importBackup → read
  addr/password/displayname back out of config → startIo → same transport
  object as `openTransport` (shared builder). Returns creds too so main.ts
  can persist them to accounts.local.json (a restarted daemon then boots
  normally).
- `store.reload()` + `attestor.reload()`: both are lazy file-backed
  caches; restore writes the sidecar files to the data dir then drops the
  in-memory cache so the restored state is live without a daemon restart.
- Sidecar-write timing (found live): core REFUSES to initialize an
  accounts structure in a non-empty dir ("<dir> is not empty", immediate
  exit → swallowed "Server quit" → RPC hang). So the sidecar files are
  written by a `beforeOpen` hook that `restoreTransport` invokes after
  `importBackup` created the structure and before `startIo` — which is
  also the window that avoids the ingest-vs-restored-store race.
- Endpoints:
  - `GET  /api/deltanet/backup` → `{ last_backup_at }` (transport-gated)
  - `POST /api/deltanet/backup/export` `{passphrase}` → `.dnbk` download
    (transport-gated)
  - `POST /api/deltanet/restore` multipart `{file, passphrase}` → 409 if
    already configured, 422 on bad container/passphrase, else restores
    and returns `{account}` like signup.
- `AppContext.restore(backupTarPath, passphrase)` mirrors `signup` in
  main.ts.

**Frontend:**

- Settings: a "Backup" card — passphrase input, "Download encrypted
  backup" button, last-backup line with a nag when never/old (>30 days).
- Landing, Create-account tab: "Restore from a backup" affordance (file +
  passphrase) that flows into sign-in on success, like signup does.
- Onboarding copy: warn that the identity lives only on this node and the
  relay expires idle addresses after ~90 days.

## Requirements

- Daemon endpoints wrapping core imex: export encrypted backup
  (passphrase) to a download; import/restore path documented for a fresh
  node (restore-instead-of-signup during onboarding).
- The backup must carry the ed25519 signing key + deltanet store sidecar,
  encrypted under the same passphrase.
- Frontend: a Backup section in settings (export button + last-backup
  nag), and a restore affordance on the landing/create-account flow.
- Onboarding copy warns about the 90-day inactivity expiry and
  data-dir-is-identity.
- Stretch (split into its own issue when reached): second-device pairing
  via core's backup-transfer QR (`provideBackup`/`getBackup`).

## Acceptance Criteria

- Export → wipe test node → restore → identity, follows, and history
  intact — including the attestation key (a post-restore post must verify
  under followers' existing TOFU pin). Integration test against the local
  podman relay.
- Wrong passphrase on restore fails cleanly (422) without touching state.
- Settings shows backup UI; onboarding shows the warning; landing offers
  restore-instead-of-signup.
