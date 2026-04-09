import type { AppEnv } from "../../shared/types";
import {
  getFederationMediaContentType,
  getFederationMediaMetadata,
} from "../../infra/repositories/federation-media-repository";

export async function loadFederationMediaDownload(input: {
  env: Pick<AppEnv["Bindings"], "DB" | "MEDIA">;
  mediaId: string;
}): Promise<{ object: R2ObjectBody; contentType: string; filename: string | null } | null> {
  const object = await input.env.MEDIA.get(input.mediaId);
  if (!object) {
    return null;
  }
  const metadata = await getFederationMediaMetadata(input.env.DB, input.mediaId);
  return {
    object,
    contentType: metadata?.contentType ?? "application/octet-stream",
    filename: metadata?.filename ?? null,
  };
}

export async function loadFederationMediaThumbnail(input: {
  env: Pick<AppEnv["Bindings"], "DB" | "MEDIA">;
  mediaId: string;
  width: number;
  height: number;
  method: string;
}): Promise<
  | { kind: "cached"; object: R2ObjectBody }
  | { kind: "original"; object: R2ObjectBody; contentType: string }
  | null
> {
  const contentType = await getFederationMediaContentType(input.env.DB, input.mediaId);
  if (!contentType) {
    return null;
  }

  const thumbnailKey = `thumb_${input.mediaId}_${input.width}x${input.height}_${input.method}`;
  const existingThumb = await input.env.MEDIA.get(thumbnailKey);
  if (existingThumb) {
    return { kind: "cached", object: existingThumb };
  }

  const object = await input.env.MEDIA.get(input.mediaId);
  if (!object) {
    return null;
  }

  return {
    kind: "original",
    object,
    contentType,
  };
}
