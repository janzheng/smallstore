/**
 * Timeline Operations
 *
 * Operations for working with episodes as time-ordered sequences.
 * Provides temporal filtering, sequence management, and timeline views.
 */

import type { Episode, Sequence, RecallQuery } from './types.ts';

// ============================================================================
// Timeline Filtering
// ============================================================================

/**
 * Filter episodes by time range
 *
 * @param episodes - Episodes to filter
 * @param start - Start timestamp (inclusive, optional)
 * @param end - End timestamp (inclusive, optional)
 * @returns Episodes within time range
 */
export function filterByTimeRange(
  episodes: Episode[],
  start?: number,
  end?: number
): Episode[] {
  return episodes.filter((episode) => {
    if (start !== undefined && episode.timestamp < start) return false;
    if (end !== undefined && episode.timestamp > end) return false;
    return true;
  });
}

/**
 * Filter episodes by sequence ID
 *
 * @param episodes - Episodes to filter
 * @param sequenceId - Sequence ID to match
 * @returns Episodes in the sequence
 */
export function filterBySequence(
  episodes: Episode[],
  sequenceId: string
): Episode[] {
  return episodes.filter((episode) => episode.sequence === sequenceId);
}

/**
 * Filter episodes by tags (matches any tag)
 *
 * @param episodes - Episodes to filter
 * @param tags - Tags to match (OR logic)
 * @returns Episodes with any matching tag
 */
export function filterByTags(
  episodes: Episode[],
  tags: string[]
): Episode[] {
  if (tags.length === 0) return episodes;
  return episodes.filter((episode) => {
    const episodeTags = episode.context.tags || [];
    return tags.some((tag) => episodeTags.includes(tag));
  });
}

/**
 * Filter episodes by context fields
 *
 * @param episodes - Episodes to filter
 * @param context - Context fields to match (partial match)
 * @returns Episodes with matching context
 */
export function filterByContext(
  episodes: Episode[],
  context: Partial<Episode['context']>
): Episode[] {
  return episodes.filter((episode) => {
    for (const [key, value] of Object.entries(context)) {
      // Special handling for tags (array matching)
      if (key === 'tags' && Array.isArray(value)) {
        const episodeTags = episode.context.tags || [];
        if (!value.some((tag) => episodeTags.includes(tag))) {
          return false;
        }
        continue;
      }

      // Special handling for related (array matching)
      if (key === 'related' && Array.isArray(value)) {
        const relatedIds = episode.context.related || [];
        if (!value.some((id) => relatedIds.includes(id))) {
          return false;
        }
        continue;
      }

      // Regular field matching
      if (episode.context[key] !== value) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Filter episodes by importance range
 *
 * @param episodes - Episodes to filter
 * @param min - Minimum importance (inclusive)
 * @param max - Maximum importance (inclusive)
 * @returns Episodes within importance range
 */
export function filterByImportance(
  episodes: Episode[],
  min?: number,
  max?: number
): Episode[] {
  return episodes.filter((episode) => {
    if (min !== undefined && episode.importance < min) return false;
    if (max !== undefined && episode.importance > max) return false;
    return true;
  });
}

// ============================================================================
// Sorting
// ============================================================================

/**
 * Sort episodes by timestamp
 *
 * @param episodes - Episodes to sort
 * @param direction - Sort direction ('asc' or 'desc')
 * @returns Sorted episodes (new array)
 */
export function sortByTimestamp(
  episodes: Episode[],
  direction: 'asc' | 'desc' = 'desc'
): Episode[] {
  return [...episodes].sort((a, b) => {
    const diff = a.timestamp - b.timestamp;
    return direction === 'asc' ? diff : -diff;
  });
}

/**
 * Sort episodes by recall count
 *
 * @param episodes - Episodes to sort
 * @param direction - Sort direction ('asc' or 'desc')
 * @returns Sorted episodes (new array)
 */
export function sortByRecalled(
  episodes: Episode[],
  direction: 'asc' | 'desc' = 'desc'
): Episode[] {
  return [...episodes].sort((a, b) => {
    const diff = a.recalled - b.recalled;
    return direction === 'asc' ? diff : -diff;
  });
}

/**
 * Sort episodes by original importance
 *
 * @param episodes - Episodes to sort
 * @param direction - Sort direction ('asc' or 'desc')
 * @returns Sorted episodes (new array)
 */
export function sortByOriginalImportance(
  episodes: Episode[],
  direction: 'asc' | 'desc' = 'desc'
): Episode[] {
  return [...episodes].sort((a, b) => {
    const diff = a.importance - b.importance;
    return direction === 'asc' ? diff : -diff;
  });
}

// ============================================================================
// Query Execution
// ============================================================================

/**
 * Apply a recall query to filter and sort episodes
 *
 * @param episodes - All episodes
 * @param query - Query options
 * @returns Filtered and sorted episodes
 */
export function applyQuery(
  episodes: Episode[],
  query: RecallQuery
): Episode[] {
  let result = [...episodes];

  // Apply filters
  if (query.timeRange) {
    result = filterByTimeRange(result, query.timeRange.start, query.timeRange.end);
  }

  if (query.sequence) {
    result = filterBySequence(result, query.sequence);
  }

  if (query.tags && query.tags.length > 0) {
    result = filterByTags(result, query.tags);
  }

  if (query.context) {
    result = filterByContext(result, query.context);
  }

  if (query.importance) {
    result = filterByImportance(result, query.importance.min, query.importance.max);
  }

  // Apply sorting
  const sortBy = query.sortBy || 'timestamp';
  const sortDirection = query.sortDirection || 'desc';

  switch (sortBy) {
    case 'timestamp':
      result = sortByTimestamp(result, sortDirection);
      break;
    case 'recalled':
      result = sortByRecalled(result, sortDirection);
      break;
    case 'importance':
      result = sortByOriginalImportance(result, sortDirection);
      break;
  }

  // Apply pagination
  if (query.offset) {
    result = result.slice(query.offset);
  }

  if (query.limit) {
    result = result.slice(0, query.limit);
  }

  return result;
}

// ============================================================================
// Sequence Operations
// ============================================================================

/**
 * Create a new sequence
 *
 * @param id - Sequence ID
 * @param name - Sequence name
 * @param description - Optional description
 * @returns New sequence object
 */
export function createSequence(
  id: string,
  name: string,
  description?: string
): Sequence {
  const now = new Date().toISOString();
  return {
    id,
    name,
    description,
    created: now,
    updated: now,
  };
}

/**
 * Get unique sequences from episodes
 *
 * @param episodes - Episodes to analyze
 * @returns Unique sequence IDs
 */
export function getUniqueSequences(episodes: Episode[]): string[] {
  const sequences = new Set<string>();
  for (const episode of episodes) {
    if (episode.sequence) {
      sequences.add(episode.sequence);
    }
  }
  return Array.from(sequences);
}

/**
 * Group episodes by sequence
 *
 * @param episodes - Episodes to group
 * @returns Map of sequence ID to episodes
 */
export function groupBySequence(
  episodes: Episode[]
): Map<string | undefined, Episode[]> {
  const groups = new Map<string | undefined, Episode[]>();

  for (const episode of episodes) {
    const key = episode.sequence;
    const existing = groups.get(key) || [];
    existing.push(episode);
    groups.set(key, existing);
  }

  return groups;
}

// ============================================================================
// Timeline Utilities
// ============================================================================

/**
 * Get episodes around a timestamp (before and after)
 *
 * @param episodes - All episodes
 * @param timestamp - Center timestamp
 * @param windowMs - Window size in milliseconds
 * @returns Episodes within the time window
 */
export function getTimeWindow(
  episodes: Episode[],
  timestamp: number,
  windowMs: number
): Episode[] {
  const start = timestamp - windowMs;
  const end = timestamp + windowMs;
  return filterByTimeRange(episodes, start, end);
}

/**
 * Get the most recent episode
 *
 * @param episodes - Episodes to check
 * @returns Most recent episode or undefined
 */
export function getMostRecent(episodes: Episode[]): Episode | undefined {
  if (episodes.length === 0) return undefined;
  return episodes.reduce((latest, current) =>
    current.timestamp > latest.timestamp ? current : latest
  );
}

/**
 * Get the oldest episode
 *
 * @param episodes - Episodes to check
 * @returns Oldest episode or undefined
 */
export function getOldest(episodes: Episode[]): Episode | undefined {
  if (episodes.length === 0) return undefined;
  return episodes.reduce((oldest, current) =>
    current.timestamp < oldest.timestamp ? current : oldest
  );
}

/**
 * Get episode by ID
 *
 * @param episodes - Episodes to search
 * @param id - Episode ID
 * @returns Episode or undefined
 */
export function getById(episodes: Episode[], id: string): Episode | undefined {
  return episodes.find((episode) => episode.id === id);
}

/**
 * Get related episodes (by related IDs in context)
 *
 * @param episodes - All episodes
 * @param episodeId - Source episode ID
 * @returns Related episodes
 */
export function getRelated(episodes: Episode[], episodeId: string): Episode[] {
  const source = getById(episodes, episodeId);
  if (!source || !source.context.related) return [];

  const relatedIds = new Set(source.context.related);
  return episodes.filter((ep) => relatedIds.has(ep.id));
}
