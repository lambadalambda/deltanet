import type { Transport } from './transport/types.js';
import type { ChatmailCredentials } from './transport/deltachat.js';

export type PreparedRestore = {
  transport: Transport;
  commit(persistCredentials: (credentials: ChatmailCredentials) => void): Promise<void>;
  abort(): void | Promise<void>;
};

type PreparedRestoreOptions = {
  transport: Transport;
  prepareCommit(persistCredentials: (credentials: ChatmailCredentials) => void): Promise<void>;
  publish(): void;
  rollback(): void;
  close(): void | Promise<void>;
  afterPublish?(): void;
};

/** Owns an opened restored transport until validated server-side and committed. */
export const createPreparedRestore = (options: PreparedRestoreOptions): PreparedRestore => {
  let state: 'prepared' | 'published' | 'closed' = 'prepared';

  const closePrepared = async (): Promise<void> => {
    if (state !== 'prepared') return;
    state = 'closed';
    await options.close();
  };

  return {
    transport: options.transport,
    abort: closePrepared,
    commit: async (persistCredentials) => {
      if (state === 'published') return;
      if (state === 'closed') throw new Error('prepared restore is already closed');
      try {
        await options.prepareCommit(persistCredentials);
        options.publish();
        state = 'published';
        try {
          options.afterPublish?.();
        } catch (error) {
          console.error('post-restore background startup failed (non-fatal):', error);
        }
      } catch (error) {
        try {
          options.rollback();
        } finally {
          await closePrepared();
        }
        throw error;
      }
    },
  };
};
