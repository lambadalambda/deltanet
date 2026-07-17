import {
  MAX_MEDIA_BYTES,
  MAX_MEDIA_DESCRIPTION_BYTES,
  MAX_MESSAGE_DESCRIPTIONS,
  MAX_STAGED_MEDIA,
  MEDIA_TTL_MS,
} from './media.js';

const MIB = 1024 * 1024;

export type ResourceLimits = {
  maxRequestBodyBytes: number;
  maxMediaBytes: number;
  maxRestoreBytes: number;
  maxBackupSidecarBytes: number;
  maxBackupCoreBytes: number;
  maxBackupExportBytes: number;
  maxStagedMedia: number;
  maxMessageDescriptions: number;
  maxMediaDescriptionBytes: number;
  mediaTtlMs: number;
  multipartOverheadBytes: number;
  maxInFlightRequestBytes: number;
};

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  maxRequestBodyBytes: 1 * MIB,
  maxMediaBytes: MAX_MEDIA_BYTES,
  maxRestoreBytes: 256 * MIB,
  maxBackupSidecarBytes: 2 * MIB,
  maxBackupCoreBytes: 253 * MIB,
  maxBackupExportBytes: 256 * MIB,
  maxStagedMedia: MAX_STAGED_MEDIA,
  maxMessageDescriptions: MAX_MESSAGE_DESCRIPTIONS,
  maxMediaDescriptionBytes: MAX_MEDIA_DESCRIPTION_BYTES,
  mediaTtlMs: MEDIA_TTL_MS,
  multipartOverheadBytes: 1 * MIB,
  maxInFlightRequestBytes: 600 * MIB,
};

export const resolveResourceLimits = (input: Partial<ResourceLimits> = {}): ResourceLimits => ({
  ...DEFAULT_RESOURCE_LIMITS,
  ...input,
});

export const requestBodyLimitFor = (path: string, limits: ResourceLimits): number => {
  if (path === '/api/headwater/restore' || path === '/api/deltanet/restore') {
    return limits.maxRestoreBytes + limits.multipartOverheadBytes;
  }
  if (
    path === '/api/v1/media' ||
    path === '/api/v1/accounts/update_credentials'
  ) {
    return path === '/api/v1/accounts/update_credentials'
      ? (2 * limits.maxMediaBytes) + limits.multipartOverheadBytes
      : limits.maxMediaBytes + limits.multipartOverheadBytes;
  }
  return limits.maxRequestBodyBytes;
};

export const formatByteLimit = (bytes: number): string =>
  bytes % MIB === 0 ? `${bytes / MIB} MiB` : `${bytes} bytes`;
