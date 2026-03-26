import { describe, expect, it } from 'vitest';
import { DefaultEventPipeline } from './event-pipeline';

describe('DefaultEventPipeline', () => {
  it('runs stages in order and records trace', async () => {
    const pipeline = new DefaultEventPipeline();
    const result = await pipeline.execute({
      input: { value: 1 },
      validate: () => undefined,
      resolveAuth: async () => ({ userId: '@alice:test' }),
      authorize: () => undefined,
      buildEvent: async () => ({ event_id: '$1' }),
      persist: async () => ({ ok: true }),
      fanout: async () => undefined,
      notifyFederation: async () => undefined,
    });

    expect(result.trace).toEqual([
      'validate',
      'resolveAuth',
      'authorize',
      'buildEvent',
      'persist',
      'fanout',
      'notifyFederation',
    ]);
  });

  it('captures post-commit failures without rolling back persist', async () => {
    const pipeline = new DefaultEventPipeline();
    const result = await pipeline.execute({
      input: { value: 1 },
      validate: () => undefined,
      resolveAuth: async () => ({ userId: '@alice:test' }),
      authorize: () => undefined,
      buildEvent: async () => ({ event_id: '$1' }),
      persist: async () => ({ eventId: '$1' }),
      fanout: async () => {
        throw new Error('fanout failed');
      },
    });

    expect(result.persisted).toEqual({ eventId: '$1' });
    expect(result.postCommitErrors).toHaveLength(1);
    expect(result.postCommitErrors[0]?.stage).toBe('fanout');
  });
});

