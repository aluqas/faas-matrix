import { getServerName } from "./ids";

export function extractServerNameFromMatrixId(id: string | undefined | null): string | null {
  return getServerName(id);
}

export function isLocalMatrixId(id: string | undefined | null, localServerName: string): boolean {
  return extractServerNameFromMatrixId(id) === localServerName;
}
