export function extractServerNameFromMatrixId(id: string | undefined | null): string | null {
  if (!id) {
    return null;
  }

  const colonIndex = id.indexOf(":");
  if (colonIndex < 0 || colonIndex === id.length - 1) {
    return null;
  }

  return id.slice(colonIndex + 1);
}

export function isLocalMatrixId(id: string | undefined | null, localServerName: string): boolean {
  return extractServerNameFromMatrixId(id) === localServerName;
}
