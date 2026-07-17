import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto';

/**
 * The `.dnbk` backup container (see ../meta/issues/backup-second-device.md).
 *
 * Core's `exportBackup` tar is NOT the whole Headwater identity: the ed25519
 * post-attestation key (`headwater-signing-key.json`, with the deployed
 * `deltanet-signing-key.json` name retained when present) and the Headwater
 * store (`headwater-store.json`, likewise retaining a deployed
 * `deltanet-store.json`, whose
 * held envelopes / pins / thread chatIds cannot be re-derived from dc.db)
 * must survive too. This container packs both alongside the core tar in ONE
 * downloadable file:
 *
 *   "DNBK1\n" | u32BE sidecar-length | sidecar | core-backup-tar
 *   sidecar = salt(16) | iv(12) | gcm-tag(16) | ciphertext
 *
 * The sidecar is AES-256-GCM under scrypt(passphrase) — the signing key is
 * secret material and may not travel in plaintext. The core tar section is
 * already passphrase-encrypted by core itself (same passphrase), so the GCM
 * tag doubles as an early, clean wrong-passphrase check before a core import
 * is ever attempted. New writers include the core tar's SHA-256 inside the
 * authenticated sidecar, binding the otherwise-separate tar bytes while old
 * DNBK1 sidecars without that optional field remain readable.
 */

export const BACKUP_MAGIC = 'DNBK1\n';

const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

/** Everything the backup carries beyond core's own tar. File fields hold raw file contents. */
export type BackupSidecar = {
  addr: string;
  exportedAt: number;
  /** Contents of the active Headwater or legacy signing-key file. */
  signingKey?: string;
  /** Contents of the active Headwater or legacy store file. */
  store?: string;
};

type EncodedBackupSidecar = BackupSidecar & { coreTarSha256?: string };

/** Anything wrong with a container a user handed us: bad magic, truncation, wrong passphrase. */
export class BackupDecodeError extends Error {}
export class BackupSizeError extends BackupDecodeError {}

export type BackupDecodeLimits = {
  maxContainerBytes?: number;
  maxSidecarBytes?: number;
  maxCoreBytes?: number;
};

const deriveKey = (passphrase: string, salt: Buffer): Buffer =>
  scryptSync(passphrase, salt, KEY_LEN);

export const encodeBackupContainer = (
  { sidecar, coreTar }: { sidecar: BackupSidecar; coreTar: Buffer },
  passphrase: string,
): Buffer => {
  const prefix = encodeBackupPrefix({
    sidecar,
    coreTarSha256: createHash('sha256').update(coreTar).digest('hex'),
  }, passphrase);
  return Buffer.concat([prefix, coreTar]);
};

/** Encodes the bounded encrypted prefix so the large core tar can stream separately. */
export const encodeBackupPrefix = (
  { sidecar, coreTarSha256 }: { sidecar: BackupSidecar; coreTarSha256: string },
  passphrase: string,
): Buffer => {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const encodedSidecar: EncodedBackupSidecar = {
    ...sidecar,
    coreTarSha256,
  };
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(encodedSidecar), 'utf8')),
    cipher.final(),
  ]);
  const block = Buffer.concat([salt, iv, cipher.getAuthTag(), ciphertext]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(block.length);
  return Buffer.concat([Buffer.from(BACKUP_MAGIC, 'utf8'), len, block]);
};

export const backupPrefixLength = (header: Buffer, limits: BackupDecodeLimits = {}): number => {
  const headerLen = BACKUP_MAGIC.length + 4;
  if (
    header.length < headerLen ||
    header.subarray(0, BACKUP_MAGIC.length).toString('utf8') !== BACKUP_MAGIC
  ) {
    throw new BackupDecodeError('not a Headwater backup file');
  }
  const blockLen = header.readUInt32BE(BACKUP_MAGIC.length);
  if (limits.maxSidecarBytes !== undefined && blockLen > limits.maxSidecarBytes) {
    throw new BackupSizeError('backup sidecar exceeds the configured size limit');
  }
  return headerLen + blockLen;
};

export const decodeBackupPrefix = (
  prefix: Buffer,
  passphrase: string,
  limits: BackupDecodeLimits = {},
): { sidecar: BackupSidecar; coreTarSha256?: string; prefixLength: number } => {
  const headerLen = BACKUP_MAGIC.length + 4;
  const blockEnd = backupPrefixLength(prefix, limits);
  const blockLen = blockEnd - headerLen;
  if (blockLen < SALT_LEN + IV_LEN + TAG_LEN || prefix.length < blockEnd) {
    throw new BackupDecodeError('truncated backup file');
  }
  const block = prefix.subarray(headerLen, blockEnd);
  const salt = block.subarray(0, SALT_LEN);
  const iv = block.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = block.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
  const ciphertext = block.subarray(SALT_LEN + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM auth failure — wrong passphrase or corrupted sidecar; indistinguishable by design.
    throw new BackupDecodeError('wrong passphrase or corrupted backup file');
  }
  let encodedSidecar: EncodedBackupSidecar;
  try {
    encodedSidecar = JSON.parse(plaintext.toString('utf8')) as EncodedBackupSidecar;
  } catch (cause) {
    throw new BackupDecodeError('malformed backup sidecar', { cause });
  }
  if (
    typeof encodedSidecar !== 'object' ||
    encodedSidecar === null ||
    typeof encodedSidecar.addr !== 'string' ||
    !encodedSidecar.addr ||
    typeof encodedSidecar.exportedAt !== 'number' ||
    !Number.isFinite(encodedSidecar.exportedAt) ||
    (encodedSidecar.signingKey !== undefined && typeof encodedSidecar.signingKey !== 'string') ||
    (encodedSidecar.store !== undefined && typeof encodedSidecar.store !== 'string') ||
    (encodedSidecar.coreTarSha256 !== undefined && !/^[0-9a-f]{64}$/.test(encodedSidecar.coreTarSha256))
  ) {
    throw new BackupDecodeError('malformed backup sidecar');
  }
  const { coreTarSha256, ...sidecar } = encodedSidecar;
  return { sidecar, ...(coreTarSha256 ? { coreTarSha256 } : {}), prefixLength: blockEnd };
};

export const decodeBackupContainer = (
  container: Buffer,
  passphrase: string,
  limits: BackupDecodeLimits = {},
): { sidecar: BackupSidecar; coreTar: Buffer } => {
  if (limits.maxContainerBytes !== undefined && container.length > limits.maxContainerBytes) {
    throw new BackupSizeError('backup file exceeds the configured size limit');
  }
  const decoded = decodeBackupPrefix(container, passphrase, limits);
  const coreTar = container.subarray(decoded.prefixLength);
  if (limits.maxCoreBytes !== undefined && coreTar.length > limits.maxCoreBytes) {
    throw new BackupSizeError('backup core exceeds the configured size limit');
  }
  if (
    decoded.coreTarSha256 !== undefined &&
    decoded.coreTarSha256 !== createHash('sha256').update(coreTar).digest('hex')
  ) {
    throw new BackupDecodeError('core tar hash mismatch');
  }
  return { sidecar: decoded.sidecar, coreTar };
};

/** `headwater-backup-<addr, filename-safe>-<utc date>.dnbk` for the download header. */
export const backupFilename = (addr: string, exportedAt: number): string => {
  const safeAddr = addr.replace(/[^a-zA-Z0-9.@_-]+/g, '-').replace(/@/g, '-');
  const date = new Date(exportedAt).toISOString().slice(0, 10);
  return `headwater-backup-${safeAddr}-${date}.dnbk`;
};
