import type {
  SessionFabricSearchResult,
  SessionFabricSessionRecord,
} from "@t3tools/contracts/session-fabric";
import { isPublicScaffoldSessionRecord } from "@t3tools/shared/sessionFabricCapability";

export interface SessionDirectorySearchEntry {
  readonly session: SessionFabricSessionRecord;
  readonly embedding: ReadonlyArray<number> | null;
}

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

const tokens = (value: string): ReadonlySet<string> =>
  new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);

export function lexicalSimilarity(query: string, candidate: string): number {
  const queryTokens = tokens(query);
  const candidateTokens = tokens(candidate);
  if (queryTokens.size === 0 || candidateTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) overlap += 1;
  }
  const coverage = overlap / queryTokens.size;
  const phraseBonus = candidate.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? 0.2 : 0;
  return clampUnit(coverage * 0.8 + phraseBonus);
}

export function cosineSimilarity(
  left: ReadonlyArray<number>,
  right: ReadonlyArray<number>,
): number | null {
  if (left.length === 0 || left.length !== right.length) return null;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return null;
  return clampUnit(dot / Math.sqrt(leftMagnitude * rightMagnitude));
}

function matchText(session: SessionFabricSessionRecord, query: string): string {
  const preferred = session.summary ?? session.initialPrompt ?? session.searchableText;
  const normalized = preferred.replace(/\s+/g, " ").trim();
  if (normalized.length <= 280) return normalized;
  const index = normalized.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return `${normalized.slice(0, 277)}...`;
  const start = Math.max(0, index - 100);
  const end = Math.min(normalized.length, start + 280);
  return `${start > 0 ? "..." : ""}${normalized.slice(start, end)}${end < normalized.length ? "..." : ""}`;
}

export function rankSessionDirectoryEntries(input: {
  readonly entries: ReadonlyArray<SessionDirectorySearchEntry>;
  readonly query: string;
  readonly queryEmbedding: ReadonlyArray<number> | null;
  readonly limit: number;
}): ReadonlyArray<SessionFabricSearchResult> {
  return input.entries
    .filter((entry) => isPublicScaffoldSessionRecord(entry.session))
    .map((entry) => {
      const lexical = lexicalSimilarity(input.query, entry.session.searchableText);
      const semantic =
        input.queryEmbedding === null || entry.embedding === null
          ? null
          : cosineSimilarity(input.queryEmbedding, entry.embedding);
      const score = semantic === null ? lexical : clampUnit(semantic * 0.85 + lexical * 0.15);
      return {
        session: entry.session,
        score,
        matchText: matchText(entry.session, input.query),
      } satisfies SessionFabricSearchResult;
    })
    .filter((result) => result.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || right.session.updatedAt.localeCompare(left.session.updatedAt),
    )
    .slice(0, input.limit);
}
