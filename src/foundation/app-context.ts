import type { FeatureProfile } from './config/feature-profile';
import type { RuntimeCapabilities } from './runtime-capabilities';

export interface AppContext<TServices = unknown> {
  capabilities: RuntimeCapabilities;
  profile: FeatureProfile;
  services: TServices;
  defer(task: Promise<unknown>): void;
}

