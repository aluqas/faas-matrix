import { createKyselyBuilder, executeKyselyQueryFirst } from "../db/kysely";

interface MediaRow {
  media_id: string;
  content_type: string;
  filename: string | null;
}

interface MediaDatabase {
  media: MediaRow;
}

export interface FederationMediaMetadata {
  contentType: string;
  filename: string | null;
}

const qb = createKyselyBuilder<MediaDatabase>();

export async function getFederationMediaMetadata(
  db: D1Database,
  mediaId: string,
): Promise<FederationMediaMetadata | null> {
  const row = await executeKyselyQueryFirst<Pick<MediaRow, "content_type" | "filename">>(
    db,
    qb.selectFrom("media").select(["content_type", "filename"]).where("media_id", "=", mediaId),
  );
  return row
    ? {
        contentType: row.content_type,
        filename: row.filename,
      }
    : null;
}

export async function getFederationMediaContentType(
  db: D1Database,
  mediaId: string,
): Promise<string | null> {
  const metadata = await getFederationMediaMetadata(db, mediaId);
  return metadata?.contentType ?? null;
}
