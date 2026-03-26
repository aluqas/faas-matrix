export type FeatureName =
  | 'adminApi'
  | 'e2ee'
  | 'federation'
  | 'media'
  | 'mediaPreviews'
  | 'presence'
  | 'pushNotifications'
  | 'slidingSync';

export type FeatureProfileName = 'full' | 'core' | 'lite';

export interface FeatureProfile {
  name: FeatureProfileName;
  features: Record<FeatureName, boolean>;
}

const FEATURE_PROFILES: Record<FeatureProfileName, Record<FeatureName, boolean>> = {
  full: {
    adminApi: true,
    e2ee: true,
    federation: true,
    media: true,
    mediaPreviews: true,
    presence: true,
    pushNotifications: true,
    slidingSync: true,
  },
  core: {
    adminApi: true,
    e2ee: false,
    federation: true,
    media: true,
    mediaPreviews: false,
    presence: true,
    pushNotifications: false,
    slidingSync: true,
  },
  lite: {
    adminApi: false,
    e2ee: false,
    federation: false,
    media: true,
    mediaPreviews: false,
    presence: false,
    pushNotifications: false,
    slidingSync: false,
  },
};

function isFeatureProfileName(value: string | undefined): value is FeatureProfileName {
  return value === 'full' || value === 'core' || value === 'lite';
}

export function createFeatureProfile(profileName?: string): FeatureProfile {
  const name = isFeatureProfileName(profileName) ? profileName : 'full';
  return {
    name,
    features: { ...FEATURE_PROFILES[name] },
  };
}

