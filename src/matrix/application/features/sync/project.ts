import type { AppContext } from "../../../../foundation/app-context";
import type { SyncResponse } from "../../../../types";
import type { SyncRepository } from "../../../repositories/interfaces";
import { assembleSyncResponse } from "./assembler";
import type { SyncUserInput } from "./contracts";

export async function projectSyncResponse(
  appContext: AppContext,
  repository: SyncRepository,
  input: SyncUserInput,
): Promise<SyncResponse> {
  return assembleSyncResponse({ appContext, repository }, input);
}
