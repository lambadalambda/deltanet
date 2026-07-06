import { describe, expect, it } from 'vitest';
import { shouldIngest } from '../src/transport/deltachat.js';
import { makeMessage } from './entities.test.js';

describe('shouldIngest', () => {
  it('accepts an ordinary text message', () => {
    expect(shouldIngest(makeMessage({ text: 'hello' }))).toBe(true);
  });

  it('rejects info/system messages', () => {
    expect(shouldIngest(makeMessage({ isInfo: true, text: 'Member added' }))).toBe(false);
  });

  it('rejects messages with sender id 0', () => {
    expect(shouldIngest(makeMessage({ fromId: 0, text: 'hello' }))).toBe(false);
  });

  it('rejects messages with no text and no file', () => {
    expect(shouldIngest(makeMessage({ text: '', file: null }))).toBe(false);
  });

  it('accepts a fileless-text message with only a file attached', () => {
    expect(shouldIngest(makeMessage({ text: '', file: '/blobs/pic.jpg' }))).toBe(true);
  });

  it('accepts a message with text but no file', () => {
    expect(shouldIngest(makeMessage({ text: 'reacted with ❤', file: null }))).toBe(true);
  });
});
