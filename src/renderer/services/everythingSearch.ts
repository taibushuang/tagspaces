/**
 * Everything search service for the renderer process.
 *
 * Bridges TagSpaces' TS.SearchQuery to Everything's search syntax,
 * converts results to TS.FileSystemEntry, and merges metadata from
 * existing Location indexes.
 */

import { TS } from '-/tagspaces.namespace';
import {
  formatDateTime,
  formatFileSize,
} from '@tagspaces/tagspaces-common/misc';
import { getUuid } from '@tagspaces/tagspaces-common/utils-io';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EverythingSearchResponse {
  available: boolean;
  results: TS.FileSystemEntry[];
  totalCount?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Query translation: TS.SearchQuery → Everything search syntax
// ---------------------------------------------------------------------------

/**
 * Escape Everything search operators in a text query.
 * Everything treats these as special: ! | < > - " * ? ( )
 */
function escapeEverythingQuery(text: string): string {
  if (!text) return '';
  // If the query contains spaces or special chars, wrap in quotes and escape inner quotes
  const specialChars = /[!|<>\-"*?()]/;
  const hasSpaces = /\s/.test(text);
  if (hasSpaces || specialChars.test(text)) {
    // Escape inner double quotes
    const escaped = text.replace(/"/g, '""');
    return `"${escaped}"`;
  }
  return text;
}

/**
 * Translate TagSpaces search query to Everything search syntax.
 */
export function translateToEverythingQuery(
  searchQuery: TS.SearchQuery,
  currentDirectoryPath?: string,
): string {
  const parts: string[] = [];

  // Text query
  if (searchQuery.textQuery) {
    parts.push(escapeEverythingQuery(searchQuery.textQuery));
  }

  // Tags (AND) — search in filename
  if (searchQuery.tagsAND && searchQuery.tagsAND.length > 0) {
    for (const tag of searchQuery.tagsAND) {
      parts.push(escapeEverythingQuery(tag.title));
    }
  }

  // File types — the "any" group is represented as [""], so empty strings
  // must be dropped or Everything receives a bare `ext:` filter that matches
  // only extension-less files and wipes out the results.
  if (searchQuery.fileTypes && searchQuery.fileTypes.length > 0) {
    const exts = searchQuery.fileTypes
      .filter((ext) => ext && ext.trim() && ext !== 'any')
      .join(';');
    if (exts) {
      parts.push(`ext:${exts}`);
    }
  }

  // File size
  if (searchQuery.fileSize) {
    const sizeQuery = translateFileSize(searchQuery.fileSize);
    if (sizeQuery) parts.push(sizeQuery);
  }

  // Last modified date
  if (searchQuery.lastModified) {
    const dateQuery = translateLastModified(searchQuery.lastModified);
    if (dateQuery) parts.push(dateQuery);
  }

  // Date created
  if (searchQuery.dateCreated) {
    const dateQuery = translateDateCreated(searchQuery.dateCreated);
    if (dateQuery) parts.push(dateQuery);
  }

  // Scope / path prefix
  if (searchQuery.searchBoxing === 'folder' && currentDirectoryPath) {
    // Current directory scope
    let prefix = currentDirectoryPath.replace(/\//g, '\\');
    if (!prefix.endsWith('\\')) prefix += '\\';
    parts.push(`path:"${prefix}"`);
  } else if (searchQuery.searchBoxing === 'location' && currentDirectoryPath) {
    // Location scope — use the location path
    let prefix = currentDirectoryPath.replace(/\//g, '\\');
    if (!prefix.endsWith('\\')) prefix += '\\';
    parts.push(`path:"${prefix}"`);
  }
  // global scope has no path restriction

  return parts.join(' ');
}

function translateFileSize(sizeKey: string): string | undefined {
  // Map TagSpaces SearchSizes.key → Everything size syntax
  // Thresholds from AppConfig.SearchSizes (node_modules/@tagspaces/tagspaces-common/AppConfig.js)
  const sizeMap: Record<string, string> = {
    sizeEmpty: 'size:0',
    sizeTiny: 'size:0-10kb', // 0 - 10KB
    sizeVerySmall: 'size:10kb-100kb', // 10KB - 100KB
    sizeSmall: 'size:100kb-1mb', // 100KB - 1MB
    sizeMedium: 'size:1mb-100mb', // 1MB - 100MB
    sizeLarge: 'size:100mb-1gb', // 100MB - 1GB
    sizeHuge: 'size:>1gb', // > 1GB
  };
  return sizeMap[sizeKey];
}

/**
 * Format a Date as YYYYMMDD in **local** time. Everything's dm:/dc: ranges
 * are interpreted in local time — using toISOString() (UTC) here would shift
 * the range by one day for users ahead of UTC (e.g. UTC+8 before 8 AM).
 */
function formatLocalDate(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}${month}${day}`;
}

function translateLastModified(periodKey: string): string | undefined {
  // Everything 1.4 compatible date ranges (YYYYMMDD-YYYYMMDD format)
  // 1.5 supports dm:today, dm:last7days etc. but 1.4 needs explicit ranges
  const now = new Date();
  const today = formatLocalDate(now);

  const getDateStr = (daysAgo: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo);
    return formatLocalDate(d);
  };

  const periodMap: Record<string, string> = {
    today: `dm:${today}-${today}`,
    yesterday: `dm:${getDateStr(1)}-${getDateStr(1)}`,
    past7Days: `dm:${getDateStr(7)}-${today}`,
    past30Days: `dm:${getDateStr(30)}-${today}`,
    past6Months: `dm:${getDateStr(180)}-${today}`,
    pastYear: `dm:${getDateStr(365)}-${today}`,
    olderThanYear: `dm:-${getDateStr(365)}`,
    moreThanYear: `dm:-${getDateStr(365)}`,
  };
  return periodMap[periodKey];
}

function translateDateCreated(periodKey: string): string | undefined {
  // Everything 1.4 compatible date ranges (YYYYMMDD-YYYYMMDD format)
  const now = new Date();
  const today = formatLocalDate(now);

  const getDateStr = (daysAgo: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo);
    return formatLocalDate(d);
  };

  const periodMap: Record<string, string> = {
    today: `dc:${today}-${today}`,
    yesterday: `dc:${getDateStr(1)}-${getDateStr(1)}`,
    past7Days: `dc:${getDateStr(7)}-${today}`,
    past30Days: `dc:${getDateStr(30)}-${today}`,
    past6Months: `dc:${getDateStr(180)}-${today}`,
    pastYear: `dc:${getDateStr(365)}-${today}`,
    olderThanYear: `dc:-${getDateStr(365)}`,
    moreThanYear: `dc:-${getDateStr(365)}`,
  };
  return periodMap[periodKey];
}

// ---------------------------------------------------------------------------
// Result conversion: Everything result → TS.FileSystemEntry
// ---------------------------------------------------------------------------

interface RawEverythingResult {
  path: string;
  name: string;
  isFile: boolean;
  size: number;
  lmdt: number;
}

function convertToFileSystemEntry(
  raw: RawEverythingResult,
  locationID?: string,
): TS.FileSystemEntry {
  // Defensive defaults — renderers and sorting helpers assume these fields
  // are never undefined:
  // - uuid: selection/marquee and data-entry-id DOM lookups key off it
  // - extension: sortByExtension (tagspaces-common) calls
  //   `a.extension.toString()` without a null check — crashes on undefined
  // - tags: sortByFirstTag reads `a.tags.length` when the other side has tags
  const ext =
    raw.isFile && raw.name.includes('.') ? raw.name.split('.').pop() : '';

  return {
    uuid: getUuid(),
    name: raw.name,
    isFile: raw.isFile,
    extension: ext,
    tags: [],
    size: raw.size,
    lmdt: raw.lmdt,
    path: raw.path,
    locationID,
    // meta will be merged later from location index if available
  };
}

// ---------------------------------------------------------------------------
// Metadata merge: enrich Everything results with Location index metadata
// ---------------------------------------------------------------------------

/**
 * Merge metadata from a Location's index into Everything results.
 * @param entries Everything results
 * @param locationIndex The location's in-memory index (from LocationIndexContext)
 * @param locationID The location's UUID
 */
export function mergeLocationMetadata(
  entries: TS.FileSystemEntry[],
  locationIndex: TS.FileSystemEntry[] | undefined,
  locationID: string,
): TS.FileSystemEntry[] {
  if (!locationIndex || locationIndex.length === 0) {
    return entries.map((e) => ({ ...e, locationID }));
  }

  // Build a map for O(1) lookup by path
  const metaMap = new Map<string, TS.FileSystemEntry>();
  for (const entry of locationIndex) {
    if (entry.path) {
      metaMap.set(entry.path, entry);
    }
  }

  return entries.map((entry) => {
    const meta = metaMap.get(entry.path);
    if (meta) {
      return {
        ...entry,
        locationID,
        uuid: meta.uuid ?? entry.uuid,
        meta: meta.meta,
        tags: meta.tags,
        parsedNameTags: meta.parsedNameTags,
        isEncrypted: meta.isEncrypted,
        isSymbolicLink: meta.isSymbolicLink,
        symlinkTargetPath: meta.symlinkTargetPath,
      };
    }
    return { ...entry, locationID };
  });
}

// ---------------------------------------------------------------------------
// Main search function
// ---------------------------------------------------------------------------

/**
 * Search using Everything SDK via IPC.
 *
 * @param searchQuery TagSpaces search query
 * @param locations All configured locations (for result grouping and metadata merge)
 * @param currentDirectoryPath Current directory path (for scope=folder/location)
 * @param locationIndex Optional in-memory index for metadata merge
 * @returns Search response with available flag for graceful fallback
 */
export async function searchWithEverything(
  searchQuery: TS.SearchQuery,
  locations: TS.Location[],
  currentDirectoryPath?: string,
  locationIndex?: TS.FileSystemEntry[],
  everythingPath?: string,
): Promise<EverythingSearchResponse> {
  if (!window.electronIO) {
    return {
      available: false,
      results: [],
      error: 'Not running in Electron',
    };
  }

  const everythingQuery = translateToEverythingQuery(
    searchQuery,
    currentDirectoryPath,
  );

  try {
    const response = await window.electronIO.ipcRenderer.invoke(
      'searchEverything',
      everythingQuery,
      {
        maxResults: searchQuery.maxSearchResults ?? 200,
        everythingPath: everythingPath ?? undefined,
      },
    );
    if (!response.available || !response.results) {
      // eslint-disable-next-line no-console
      console.warn(
        '[everythingSearch] unavailable:',
        response.error || 'no results field',
      );
    }

    if (!response.available) {
      return {
        available: false,
        results: [],
        error: response.error,
      };
    }

    // Convert raw results to FileSystemEntry
    const entries: TS.FileSystemEntry[] = response.results.map(
      (raw: RawEverythingResult) => convertToFileSystemEntry(raw),
    );

    // Group by location and merge metadata
    const locationMap = new Map<string, TS.Location>();
    for (const loc of locations) {
      locationMap.set(loc.uuid, loc);
    }

    // Find which location each result belongs to
    const enrichedEntries: TS.FileSystemEntry[] = [];
    const unmatchedEntries: TS.FileSystemEntry[] = [];

    for (const entry of entries) {
      let matched = false;
      for (const loc of locations) {
        // Windows paths are case-insensitive: Everything returns the on-disk
        // casing, the configured location path may differ in case.
        const locPath = loc.path.replace(/\\/g, '/').toLowerCase();
        const entryPath = entry.path.toLowerCase();
        if (
          entryPath === locPath.replace(/\/$/, '') ||
          entryPath.startsWith(locPath.endsWith('/') ? locPath : `${locPath}/`)
        ) {
          const enriched = mergeLocationMetadata(
            [entry],
            locationIndex,
            loc.uuid,
          );
          enrichedEntries.push(enriched[0]);
          matched = true;
          break;
        }
      }
      if (!matched) {
        unmatchedEntries.push(entry);
      }
    }

    // Unmatched entries are "system files" (no location, read-only)
    const systemEntries = unmatchedEntries.map((e) => ({
      ...e,
      locationID: undefined,
    }));

    return {
      available: true,
      results: [...enrichedEntries, ...systemEntries],
      totalCount: response.totalCount,
    };
  } catch (err: any) {
    return {
      available: false,
      results: [],
      error: `Everything search failed: ${err.message}`,
    };
  }
}

/**
 * Check if Everything search is available on this system.
 */
export async function isEverythingSearchAvailable(): Promise<boolean> {
  if (!window.electronIO) return false;
  try {
    const response = await window.electronIO.ipcRenderer.invoke(
      'searchEverything',
      '',
      { maxResults: 1 },
    );
    return response.available;
  } catch {
    return false;
  }
}
