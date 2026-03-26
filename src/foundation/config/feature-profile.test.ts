import { describe, expect, it } from 'vitest';
import { createFeatureProfile } from './feature-profile';

describe('createFeatureProfile', () => {
  it('defaults to full for unknown profiles', () => {
    const profile = createFeatureProfile('unknown');
    expect(profile.name).toBe('full');
    expect(profile.features.federation).toBe(true);
    expect(profile.features.pushNotifications).toBe(true);
  });

  it('exposes lite feature gates', () => {
    const profile = createFeatureProfile('lite');
    expect(profile.features.federation).toBe(false);
    expect(profile.features.slidingSync).toBe(false);
    expect(profile.features.media).toBe(true);
  });
});

