import { describe, expect, it } from 'vitest';
import {
  electronSmokeArguments,
  electronSmokeEnvironment,
  validateDesktopSmokePaths,
} from '../src/smoke.js';

describe('Electron smoke launcher', () => {
  it('places Chromium switches before the application directory', () => {
    expect(electronSmokeArguments({
      appDir: '/repo/desktop',
      userData: '/tmp/headwater-smoke',
      marker: '/tmp/headwater-smoke/result.json',
    })).toEqual([
      '--user-data-dir=/tmp/headwater-smoke',
      '--headwater-desktop-smoke-marker=/tmp/headwater-smoke/result.json',
      '/repo/desktop',
    ]);
  });

  it('passes the isolated smoke root and marker through the child environment', () => {
    expect(electronSmokeEnvironment({
      PATH: '/usr/bin',
    }, {
      userData: '/tmp/headwater-smoke',
      marker: '/tmp/headwater-smoke/result.json',
    })).toMatchObject({
      PATH: '/usr/bin',
      HEADWATER_DESKTOP_SMOKE_ROOT: '/tmp/headwater-smoke',
      HEADWATER_DESKTOP_SMOKE_MARKER: '/tmp/headwater-smoke/result.json',
    });
  });

  it('accepts only development markers directly inside the isolated root', () => {
    const input = { root: '/tmp/headwater-smoke', marker: '/tmp/headwater-smoke/result.json' };
    expect(validateDesktopSmokePaths({ ...input, isPackaged: false })).toEqual(input);
    expect(validateDesktopSmokePaths({ ...input, isPackaged: true })).toBeNull();
    expect(validateDesktopSmokePaths({ ...input, marker: '/tmp/outside.json', isPackaged: false })).toBeNull();
    expect(validateDesktopSmokePaths({ ...input, root: 'relative', isPackaged: false })).toBeNull();
    expect(validateDesktopSmokePaths({ ...input, marker: 'relative', isPackaged: false })).toBeNull();
    expect(validateDesktopSmokePaths({ ...input, marker: '/tmp/headwater-smoke/nested/result.json', isPackaged: false })).toBeNull();
    expect(validateDesktopSmokePaths({ ...input, marker: '/tmp/headwater-smoke/../outside.json', isPackaged: false })).toBeNull();
  });
});
