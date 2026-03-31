import type { AppContext } from "../../foundation/app-context";
import type { SyncResponse } from "../../types";
import type { SyncRepository } from "../repositories/interfaces";
import { projectSyncResponse } from "./features/sync/project";
import { buildSyncToken, parseSyncToken, type SyncUserInput } from "./features/sync/contracts";

export { buildSyncToken, parseSyncToken, type SyncUserInput };

export class MatrixSyncService {
  constructor(
    private readonly appContext: AppContext,
    private readonly repository: SyncRepository,
  ) {}

  async syncUser(input: SyncUserInput): Promise<SyncResponse> {
    return projectSyncResponse(this.appContext, this.repository, input);
  }
}
