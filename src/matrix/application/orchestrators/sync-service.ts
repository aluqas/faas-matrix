import { Effect } from "effect";
import type { AppContext } from "../../../shared/runtime/app-context";
import type { SyncResponse } from "../../../shared/types";
import type { InfraError } from "../domain-error";
import type { SyncRepository } from "../../../infra/repositories/interfaces";
import { projectSyncResponseEffect } from "../../../features/sync/project";
import { buildSyncToken, parseSyncToken, type SyncUserInput } from "../../../features/sync/contracts";

export { buildSyncToken, parseSyncToken, type SyncUserInput };

export class MatrixSyncService {
  constructor(
    private readonly appContext: AppContext,
    private readonly repository: SyncRepository,
  ) {}

  syncUser(input: SyncUserInput): Effect.Effect<SyncResponse, InfraError> {
    return projectSyncResponseEffect(this.appContext, this.repository, input);
  }
}
