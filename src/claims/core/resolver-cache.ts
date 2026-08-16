import type { EvidenceResolver, ResolvedEvidence } from "./types.js";

/**
 * Memoizes evidence resolutions for one explicitly scoped processing phase.
 *
 * Callers create a fresh wrapper for preflight, one mutation batch, or one
 * finalization pass so caching never crosses a freshness boundary.
 *
 * @param resolver - Underlying evidence resolver.
 * @returns Resolver that resolves each resource at most once.
 */
export function cacheEvidenceResolver(
  resolver: EvidenceResolver,
): EvidenceResolver {
  const cache = new Map<string, Promise<ResolvedEvidence | null>>();

  return {
    resolve(resource: string): Promise<ResolvedEvidence | null> {
      const cached = cache.get(resource);
      if (cached) return cached;
      const pending = resolver.resolve(resource);
      cache.set(resource, pending);
      return pending;
    },
  };
}
