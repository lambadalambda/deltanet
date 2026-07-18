import { describe, expect, it } from 'vitest';
import {
  browserWindowOptions,
  externalHttpUrl,
  isAllowedInternalNavigation,
  isExpectedEnrollmentSender,
  isExpectedStatusSender,
} from '../src/security.js';

describe('desktop renderer security policy', () => {
  it('sets every load-bearing BrowserWindow preference explicitly', () => {
    expect(browserWindowOptions('/absolute/preload.cjs', false).webPreferences).toMatchObject({
      preload: '/absolute/preload.cjs',
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      devTools: true,
    });
  });

  it('allows only exact-origin internal navigation', () => {
    const origin = 'http://127.0.0.1:43123';
    expect(isAllowedInternalNavigation(`${origin}/app/home`, origin)).toBe(true);
    expect(isAllowedInternalNavigation(`${origin}/auth/callback?code=secret`, origin)).toBe(true);
    expect(isAllowedInternalNavigation(`${origin}/oauth/authorize?client_id=desktop`, origin)).toBe(true);
    expect(isAllowedInternalNavigation(`${origin}/api/v1/pleroma/admin`, origin)).toBe(false);
    expect(isAllowedInternalNavigation(`${origin}/pleroma/headwater/blob/1`, origin)).toBe(false);
    expect(isAllowedInternalNavigation('http://127.0.0.1:43124/app/home', origin)).toBe(false);
    expect(isAllowedInternalNavigation('javascript:alert(1)', origin)).toBe(false);
  });

  it('selects credential-free external HTTP(S) URLs only', () => {
    const origin = 'http://127.0.0.1:43123';
    expect(externalHttpUrl('https://example.org/path', origin)).toBe('https://example.org/path');
    expect(externalHttpUrl(`${origin}/public`, origin)).toBeNull();
    expect(externalHttpUrl('https://user:pass@example.org/', origin)).toBeNull();
    expect(externalHttpUrl('file:///etc/passwd', origin)).toBeNull();
  });

  it('accepts status IPC only from the expected main frame and origin', () => {
    const frame = { url: 'http://127.0.0.1:43123/app/home' };
    const contents = { mainFrame: frame };
    expect(isExpectedStatusSender({ sender: contents, senderFrame: frame }, contents, 'http://127.0.0.1:43123')).toBe(true);
    expect(isExpectedStatusSender({ sender: contents, senderFrame: { url: frame.url } }, contents, 'http://127.0.0.1:43123')).toBe(false);
    expect(isExpectedStatusSender({ sender: {}, senderFrame: frame }, contents, 'http://127.0.0.1:43123')).toBe(false);
  });

  it('accepts enrollment IPC only from the landing document', () => {
    const frame = { url: 'http://127.0.0.1:43123/' };
    const contents = { mainFrame: frame };
    expect(isExpectedEnrollmentSender({ sender: contents, senderFrame: frame }, contents, 'http://127.0.0.1:43123')).toBe(true);
    frame.url = 'http://127.0.0.1:43123/app/home';
    expect(isExpectedEnrollmentSender({ sender: contents, senderFrame: frame }, contents, 'http://127.0.0.1:43123')).toBe(false);
    frame.url = 'http://127.0.0.1:43123/pleroma/headwater/blob/1';
    expect(isExpectedEnrollmentSender({ sender: contents, senderFrame: frame }, contents, 'http://127.0.0.1:43123')).toBe(false);
  });
});
