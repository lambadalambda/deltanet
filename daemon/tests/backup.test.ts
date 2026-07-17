import { describe, expect, it } from 'vitest';
import {
  BACKUP_MAGIC,
  BackupDecodeError,
  BackupSizeError,
  backupFilename,
  decodeBackupContainer,
  encodeBackupContainer,
  encodeBackupPrefix,
  type BackupSidecar,
} from '../src/backup.js';

const SIDECAR: BackupSidecar = {
  addr: 'alice@nine.testrun.org',
  exportedAt: 1751884800000,
  signingKey: '{"privatePem":"-----BEGIN PRIVATE KEY-----\\n...","pubkey":"abc"}\n',
  store: '{"schemaVersion":9}\n',
};

// Deliberately non-UTF8 bytes: the tar section must round-trip verbatim.
const CORE_TAR = Buffer.from([0x00, 0xff, 0x13, 0x37, 0x80, 0x00, 0x01, 0xfe]);

describe('backup container', () => {
  it('round-trips sidecar + core tar under the right passphrase', () => {
    const container = encodeBackupContainer({ sidecar: SIDECAR, coreTar: CORE_TAR }, 'hunter2');
    const decoded = decodeBackupContainer(container, 'hunter2');
    expect(decoded.sidecar).toEqual(SIDECAR);
    expect(Buffer.compare(decoded.coreTar, CORE_TAR)).toBe(0);
  });

  it('starts with the magic so files are identifiable', () => {
    const container = encodeBackupContainer({ sidecar: SIDECAR, coreTar: CORE_TAR }, 'hunter2');
    expect(container.subarray(0, BACKUP_MAGIC.length).toString('utf8')).toBe(BACKUP_MAGIC);
    expect(BACKUP_MAGIC).toBe('DNBK1\n');
  });

  it('decodes legacy DNBK1 sidecars that predate the authenticated core hash', () => {
    const prefix = encodeBackupPrefix({
      sidecar: SIDECAR,
      coreTarSha256: undefined,
    } as any, 'hunter2');
    const decoded = decodeBackupContainer(Buffer.concat([prefix, CORE_TAR]), 'hunter2');
    expect(decoded.sidecar).toEqual(SIDECAR);
    expect(decoded.coreTar).toEqual(CORE_TAR);
  });

  it('never leaks sidecar plaintext (the signing key) into the container', () => {
    const container = encodeBackupContainer({ sidecar: SIDECAR, coreTar: CORE_TAR }, 'hunter2');
    expect(container.includes(Buffer.from('privatePem'))).toBe(false);
    expect(container.includes(Buffer.from(SIDECAR.addr))).toBe(false);
  });

  it('rejects a wrong passphrase with a clean error (GCM auth failure)', () => {
    const container = encodeBackupContainer({ sidecar: SIDECAR, coreTar: CORE_TAR }, 'hunter2');
    expect(() => decodeBackupContainer(container, 'wrong')).toThrow(BackupDecodeError);
  });

  it('rejects a file without the magic', () => {
    expect(() => decodeBackupContainer(Buffer.from('not a backup at all'), 'hunter2')).toThrow(
      BackupDecodeError,
    );
  });

  it('rejects a truncated container', () => {
    const container = encodeBackupContainer({ sidecar: SIDECAR, coreTar: CORE_TAR }, 'hunter2');
    expect(() => decodeBackupContainer(container.subarray(0, 20), 'hunter2')).toThrow(
      BackupDecodeError,
    );
  });

  it('rejects a tampered sidecar (flipped ciphertext bit)', () => {
    const container = encodeBackupContainer({ sidecar: SIDECAR, coreTar: CORE_TAR }, 'hunter2');
    const tampered = Buffer.from(container);
    // Past magic(6) + len(4) + salt(16) + iv(12) + tag(16) = byte 54 is ciphertext.
    tampered[54] = tampered[54]! ^ 0x01;
    expect(() => decodeBackupContainer(tampered, 'hunter2')).toThrow(BackupDecodeError);
  });

  it('rejects a spliced or tampered core tar using the authenticated sidecar hash', () => {
    const container = encodeBackupContainer({ sidecar: SIDECAR, coreTar: CORE_TAR }, 'hunter2');
    const tampered = Buffer.from(container);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
    expect(() => decodeBackupContainer(tampered, 'hunter2')).toThrow(/core tar.*mismatch/i);
  });

  it('tolerates sidecars without optional files (fresh node with no store yet)', () => {
    const bare: BackupSidecar = { addr: 'a@b.c', exportedAt: 1 };
    const container = encodeBackupContainer({ sidecar: bare, coreTar: CORE_TAR }, 'pw');
    expect(decodeBackupContainer(container, 'pw').sidecar).toEqual(bare);
  });

  it('handles an empty core tar section', () => {
    const container = encodeBackupContainer(
      { sidecar: SIDECAR, coreTar: Buffer.alloc(0) },
      'pw',
    );
    expect(decodeBackupContainer(container, 'pw').coreTar.length).toBe(0);
  });

  it('rejects oversized containers, sidecars, and core sections before use', () => {
    const container = encodeBackupContainer({ sidecar: SIDECAR, coreTar: CORE_TAR }, 'pw');
    const blockLength = container.readUInt32BE(BACKUP_MAGIC.length);

    expect(() => decodeBackupContainer(container, 'pw', {
      maxContainerBytes: container.length - 1,
    })).toThrow(BackupSizeError);
    expect(() => decodeBackupContainer(container, 'pw', {
      maxSidecarBytes: blockLength - 1,
    })).toThrow(BackupSizeError);
    expect(() => decodeBackupContainer(container, 'pw', {
      maxCoreBytes: CORE_TAR.length - 1,
    })).toThrow(BackupSizeError);
  });

  it('rejects authenticated sidecars with an invalid runtime shape', () => {
    const container = encodeBackupContainer({ sidecar: null as unknown as BackupSidecar, coreTar: CORE_TAR }, 'pw');
    expect(() => decodeBackupContainer(container, 'pw')).toThrow(/malformed backup sidecar/);
  });
});

describe('backupFilename', () => {
  it('derives a dated, addr-tagged .dnbk name', () => {
    expect(backupFilename('alice@nine.testrun.org', 1751884800000)).toBe(
      'headwater-backup-alice-nine.testrun.org-2025-07-07.dnbk',
    );
  });

  it('strips characters that are unsafe in filenames', () => {
    expect(backupFilename('we/ird"addr\\x', 0)).toBe('headwater-backup-we-ird-addr-x-1970-01-01.dnbk');
  });
});
