import type { MediaChoice } from "./parse/request";
import { quoteQualified } from "./quote";
import { relKey, type FunctionDef, type SchemaCache } from "./schema";

const choiceFor = (mediaType: string, bytea: boolean, extra: Partial<MediaChoice>): MediaChoice => ({
  mediaType,
  // `*/*` is not a real content type: PostgREST answers application/octet-stream.
  contentType:
    mediaType === "*/*" || bytea
      ? mediaType === "*/*"
        ? "application/octet-stream"
        : mediaType
      : `${mediaType}; charset=utf-8`,
  bytea,
  ...extra,
});

/** Aggregates in the exposed schemas that render rows of `relation` (or of any type) as a custom media type. */
const aggregateChoices = (
  cache: SchemaCache,
  schema: string,
  relation: { schema: string; name: string },
  allowTyped: boolean,
) =>
  cache.mediaHandlers
    .filter((h) => h.schema === schema)
    .filter((h) =>
      h.argRelation
        ? allowTyped && h.argRelation.schema === relation.schema && h.argRelation.name === relation.name
        : true,
    )
    .map((h) =>
      choiceFor(h.mediaType, h.bytea, {
        aggregate: quoteQualified(h.schema, h.mediaType),
        ...(h.argRelation ? { rowType: quoteQualified(h.argRelation.schema, h.argRelation.name) } : {}),
      }),
    );

/**
 * The custom media types a request can be answered with. Handlers that take a specific table apply only when
 * the request returns whole rows of it (no `select`); `anyelement` handlers apply to any rows.
 */
export const mediaChoices = (
  cache: SchemaCache,
  schema: string,
  target: { type: "table" | "rpc"; name: string },
  hasSelect: boolean,
): MediaChoice[] => {
  if (
    cache.mediaHandlers.length === 0 &&
    ![...cache.functions.values()].some((fs) => fs.some((f) => f.returnMediaType))
  )
    return [];
  if (target.type === "table") {
    const rel = cache.relations.get(relKey(schema, target.name));
    return rel ? aggregateChoices(cache, schema, rel, !hasSelect) : [];
  }
  const fns: readonly FunctionDef[] = cache.functions.get(relKey(schema, target.name)) ?? [];
  const out: MediaChoice[] = [];
  for (const f of fns) {
    if (f.returnMediaType) {
      out.push(choiceFor(f.returnMediaType.name.toLowerCase(), f.returnMediaType.bytea, {}));
    } else if (f.returnRelation && f.returnsSet) {
      out.push(...aggregateChoices(cache, schema, f.returnRelation, !hasSelect));
    }
  }
  // A scalar result can also be returned raw through the catch-all handler.
  if (fns.some((f) => !f.returnsSet && !f.returnsComposite && !f.returnsVoid)) {
    const any = cache.mediaHandlers.find((h) => h.schema === schema && h.mediaType === "*/*" && !h.argRelation);
    if (any) out.push(choiceFor("*/*", any.bytea, {}));
  }
  return out;
};
