/**
 * TagSpaces - universal file and folder organizer
 * Copyright (C) 2024-present TagSpaces GmbH
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License (version 3) as
 * published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 */

/**
 * Query-string operator parser for the agent's search_files tool, modeled
 * after the official tscmd search syntax:
 *
 *   word                free-text term (AND-combined)
 *   "quoted phrase"     free-text phrase
 *   +tag                entry must have this tag (AND)
 *   -tag                entry must NOT have this tag
 *   |tag                any of these tags (OR group)
 *   --type:documents    file-type group or extension filter
 *                       (groups: any/images/notes/documents/audio/video/
 *                        archives/bookmarks/ebooks/emails/folders/files/
 *                        untagged; unknown values are treated as
 *                        comma-separated extensions, e.g. --type:pdf,docx)
 *
 * Everything else becomes the free-text query, AND-combined by the engine.
 */
import { SearchTypeGroups } from '@tagspaces/tagspaces-common/AppConfig';

export type ParsedSearchQuery = {
  textQuery: string;
  tagsAND: string[];
  tagsOR: string[];
  tagsNOT: string[];
  fileTypes: string[];
};

function resolveFileTypeToken(token: string): string[] {
  const group = SearchTypeGroups[token.toLowerCase()];
  if (group) {
    return [...group];
  }
  // not a known group — treat as comma-separated extension filter
  return token
    .split(',')
    .map((ext) => ext.replace(/^\./, '').trim().toLowerCase())
    .filter(Boolean);
}

export function parseSearchOperators(raw: string): ParsedSearchQuery {
  const textTerms: string[] = [];
  const tagsAND: string[] = [];
  const tagsOR: string[] = [];
  const tagsNOT: string[] = [];
  let fileTypes: string[] = [];

  // whitespace split, but keep double-quoted phrases as single text tokens
  const tokenRegex = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  let pendingType = false;
  while ((match = tokenRegex.exec(raw || '')) !== null) {
    const phrase = match[1];
    const token = match[2];
    if (pendingType) {
      // --type consumed the previous token; this token is the value
      fileTypes = fileTypes.concat(resolveFileTypeToken(token));
      pendingType = false;
      continue;
    }
    if (phrase !== undefined) {
      if (phrase.trim()) {
        textTerms.push(phrase.trim());
      }
      continue;
    }
    if (token === '--type' || token.startsWith('--type:')) {
      const inline = token.slice('--type:'.length).trim();
      if (inline) {
        fileTypes = fileTypes.concat(resolveFileTypeToken(inline));
      } else {
        pendingType = true;
      }
      continue;
    }
    if (token.startsWith('+') && token.length > 1) {
      tagsAND.push(decodeXmlEntities(token.slice(1)));
      continue;
    }
    if (
      token.startsWith('-') &&
      token.length > 1 &&
      !/^\d/.test(token.slice(1))
    ) {
      tagsNOT.push(decodeXmlEntities(token.slice(1)));
      continue;
    }
    if (token.startsWith('|') && token.length > 1) {
      tagsOR.push(decodeXmlEntities(token.slice(1)));
      continue;
    }
    if (token.trim()) {
      textTerms.push(decodeXmlEntities(token.trim()));
    }
  }

  return {
    textQuery: textTerms.join(' ').trim(),
    tagsAND,
    tagsOR,
    tagsNOT,
    fileTypes,
  };
}

// local helper — kept tiny and dependency-free
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
