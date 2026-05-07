import { Effect } from "effect";
import type { AppContext } from "../../ports/runtime/app-context";
import type { SyncResponse } from "../../../fatrix-model/types";
import type { InfraError } from "../domain-error";
import type { SyncRepository } from "../../ports/repositories";
import {
  projectSyncResponseEffect,
  type SyncApplicationPorts,
} from "../features/sync/use-cases/project-sync-response";
import {
  buildSyncToken,
  parseSyncToken,
  type SyncUserInput,
} from "../features/sync/types/contracts";

export { buildSyncToken, parseSyncToken, type SyncUserInput };

export class MatrixSyncService {
  constructor(
    private readonly appContext: AppContext,
    private readonly repository: SyncRepository,
    private readonly applicationPorts: SyncApplicationPorts,
  ) {}

  syncUser(input: SyncUserInput): Effect.Effect<SyncResponse, InfraError> {
    return projectSyncResponseEffect(
      this.appContext,
      this.repository,
      this.applicationPorts,
      input,
    );
  }
}
