// @effect-diagnostics returnEffectInGen:off -- Alchemy Durable Objects intentionally use a two-phase outer/inner Effect.
import type {
  SessionFabricSearchRequest,
  SessionFabricSearchResponse,
  SessionFabricSessionRecord,
  SessionFabricSnapshot,
} from "@t3tools/contracts/session-fabric";
import {
  SessionFabricSessionRecord as SessionFabricSessionRecordSchema,
  SessionFabricSnapshot as SessionFabricSnapshotSchema,
} from "@t3tools/contracts/session-fabric";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  isPublicScaffoldSessionRecord,
  isPublicScaffoldSnapshot,
} from "@t3tools/shared/sessionFabricCapability";

import { rankSessionDirectoryEntries } from "./SessionDirectoryModel.ts";

interface DirectoryRow {
  readonly [key: string]: string | number | null;
  readonly session_json: string;
  readonly searchable_text: string;
  readonly embedding_json: string | null;
}

const EMBEDDING_MODEL = "qwen3-embedding";
const EMBEDDING_DIMENSIONS = 1024;

const EmbeddingRequest = Schema.Struct({
  input: Schema.Array(Schema.String),
  model: Schema.String,
  dimensions: Schema.Int,
});
const EmbeddingResponse = Schema.Struct({
  data: Schema.Array(Schema.Struct({ embedding: Schema.Array(Schema.Number) })),
});
const SessionRecordJson = Schema.fromJsonString(SessionFabricSessionRecordSchema);
const EmbeddingJson = Schema.fromJsonString(Schema.Array(Schema.Number));
const encodeSessionRecord = Schema.encodeSync(SessionRecordJson);
const decodeSessionRecord = Schema.decodeUnknownEffect(SessionRecordJson);
const decodeSnapshot = Schema.decodeUnknownEffect(SessionFabricSnapshotSchema);
const encodeEmbedding = Schema.encodeSync(EmbeddingJson);
const decodeEmbedding = Schema.decodeUnknownEffect(EmbeddingJson);

function embeddingEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/v1/embeddings") ? normalized : `${normalized}/v1/embeddings`;
}

export default class SessionDirectory extends Cloudflare.DurableObjectNamespace<SessionDirectory>()(
  "SessionDirectory",
  Effect.gen(function* () {
    const basetenUrl = yield* Config.string("BASETEN_EMBEDDING_URL").pipe(Config.option);
    const basetenApiKey = yield* Config.redacted("BASETEN_API_KEY").pipe(Config.option);

    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const httpClient = yield* HttpClient.HttpClient;
      const { sql } = state.storage;

      yield* sql
        .exec(
          "CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, session_json TEXT NOT NULL, searchable_text TEXT NOT NULL, embedding_json TEXT, embedding_model TEXT, updated_at TEXT NOT NULL)",
        )
        .pipe(Effect.asVoid);

      const embed = Effect.fn("session_fabric_directory.embed")(function* (text: string) {
        if (Option.isNone(basetenUrl) || Option.isNone(basetenApiKey)) return null;
        return yield* HttpClientRequest.post(embeddingEndpoint(basetenUrl.value)).pipe(
          HttpClientRequest.setHeader(
            "authorization",
            `Api-Key ${Redacted.value(basetenApiKey.value)}`,
          ),
          HttpClientRequest.schemaBodyJson(EmbeddingRequest)({
            input: [text],
            model: EMBEDDING_MODEL,
            dimensions: EMBEDDING_DIMENSIONS,
          }),
          Effect.flatMap(httpClient.execute),
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(EmbeddingResponse)),
          Effect.map((response) => response.data[0]?.embedding ?? null),
          Effect.catchCause((cause) =>
            Effect.logWarning("session fabric semantic embedding failed", { cause }).pipe(
              Effect.as(null),
            ),
          ),
        );
      });

      const readEntries = Effect.fn("session_fabric_directory.read_entries")(function* () {
        const cursor = yield* sql.exec<DirectoryRow>(
          "SELECT session_json, searchable_text, embedding_json FROM sessions ORDER BY updated_at DESC",
        );
        return yield* Effect.forEach(yield* cursor.toArray(), (row) =>
          Effect.all({
            session: decodeSessionRecord(row.session_json),
            embedding:
              row.embedding_json === null
                ? Effect.succeed(null)
                : decodeEmbedding(row.embedding_json),
          }).pipe(Effect.option),
        ).pipe(
          Effect.map((entries) =>
            entries.flatMap((entry) =>
              Option.isSome(entry) && isPublicScaffoldSessionRecord(entry.value.session)
                ? [entry.value]
                : [],
            ),
          ),
        );
      });

      const upsert = Effect.fn("session_fabric_directory.upsert")(function* (
        snapshot: SessionFabricSnapshot,
      ) {
        const validated = yield* decodeSnapshot(snapshot);
        if (!isPublicScaffoldSnapshot(validated)) {
          yield* sql
            .exec("DELETE FROM sessions WHERE session_id = ?", validated.session.sessionId)
            .pipe(Effect.asVoid);
          return;
        }
        const existingCursor = yield* sql.exec<DirectoryRow>(
          "SELECT session_json, searchable_text, embedding_json FROM sessions WHERE session_id = ? LIMIT 1",
          validated.session.sessionId,
        );
        const existing = (yield* existingCursor.toArray()).at(0);
        const embedding =
          existing?.searchable_text === validated.session.searchableText &&
          existing.embedding_json !== null
            ? yield* decodeEmbedding(existing.embedding_json)
            : yield* embed(validated.session.searchableText);
        yield* sql
          .exec(
            "INSERT INTO sessions (session_id, session_json, searchable_text, embedding_json, embedding_model, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET session_json = excluded.session_json, searchable_text = excluded.searchable_text, embedding_json = excluded.embedding_json, embedding_model = excluded.embedding_model, updated_at = excluded.updated_at",
            validated.session.sessionId,
            encodeSessionRecord(validated.session),
            validated.session.searchableText,
            embedding === null ? null : encodeEmbedding(embedding),
            embedding === null ? null : EMBEDDING_MODEL,
            validated.session.updatedAt,
          )
          .pipe(Effect.asVoid);
      });

      const search = Effect.fn("session_fabric_directory.search")(function* (
        input: SessionFabricSearchRequest,
      ) {
        return {
          results: rankSessionDirectoryEntries({
            entries: yield* readEntries(),
            query: input.query,
            queryEmbedding: yield* embed(input.query),
            limit: input.limit,
          }),
        } satisfies SessionFabricSearchResponse;
      });

      const list = Effect.fn("session_fabric_directory.list")(function* () {
        return (yield* readEntries()).map((entry): SessionFabricSessionRecord => entry.session);
      });

      const remove = Effect.fn("session_fabric_directory.remove")(function* (sessionId: string) {
        yield* sql.exec("DELETE FROM sessions WHERE session_id = ?", sessionId).pipe(Effect.asVoid);
      });

      return { upsert, search, list, remove };
    });
  }).pipe(Effect.orDie),
) {}
