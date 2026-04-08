import type { AppContext } from "../../foundation/app-context";

export interface AdminService {
  getStats(refresh?: boolean): Promise<Record<string, unknown>>;
  invalidateStatsCache(): Promise<void>;
}

export class CloudflareBackedAdminService implements AdminService {
  constructor(private readonly appContext: AppContext) {}

  getStats(refresh: boolean = false): Promise<Record<string, unknown>> {
    const capability = this.appContext.capabilities;
    const namespace = capability.rateLimit.namespace;
    void namespace;
    return Promise.resolve({
      server: {
        name: capability.config.serverName,
        version: capability.config.serverVersion,
      },
      refresh,
    });
  }

  async invalidateStatsCache(): Promise<void> {}
}
