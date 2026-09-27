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
 * Text extraction for Office Open XML documents (docx / pptx / xlsx).
 *
 * These formats are ZIP containers holding XML parts. We read the bytes in
 * the renderer (sandboxed, no Node APIs), unzip with fflate (pure
 * Uint8Array, zero dependencies) and pull the text out of the relevant XML
 * parts with small regex-based parsers — good enough for LLM context, far
 * cheaper than full Office object models.
 *
 * Legacy binary formats (.doc / .xls / .ppt) are OLE containers, NOT zip —
 * they are intentionally not supported.
 */
import { unzipSync } from 'fflate';

/** Extensions this module can extract (lowercase, without dot). */
export const OFFICE_TEXT_EXTENSIONS = ['docx', 'pptx', 'xlsx'] as const;

export function isOfficeDocumentPath(path: string): boolean {
  const lower = (path || '').toLowerCase();
  return OFFICE_TEXT_EXTENSIONS.some((ext) => lower.endsWith(`.${ext}`));
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Concatenated text of all `<t>`-family elements inside one XML chunk. */
function extractTextRuns(chunk: string, tagPattern: RegExp): string {
  const runs: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(tagPattern.source, 'g');
  while ((match = re.exec(chunk)) !== null) {
    runs.push(decodeXmlEntities(match[1]));
  }
  return runs.join('');
}

function decodePart(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/** Collapse 3+ consecutive empty lines into one blank line. */
function normalizeBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

// ------------------------------ docx ---------------------------------------

function extractDocx(files: Record<string, Uint8Array>): string {
  const documentXml = files['word/document.xml'];
  if (!documentXml) {
    throw new Error('docx is missing word/document.xml — file may be corrupt');
  }
  const xml = decodePart(documentXml);
  const paragraphs = xml.split(/<\/w:p>/);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    // tab/br markers live OUTSIDE <w:t> runs — wrap them in synthetic runs
    // so the run extraction keeps them, then turn markers into real chars.
    const prepared = paragraph
      .replace(/<w:tab\b[^>]*\/>/g, '<w:t>\u0001</w:t>')
      .replace(/<w:(?:br|cr)\b[^>]*\/>/g, '<w:t>\u0002</w:t>');
    let text = extractTextRuns(prepared, /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/);
    if (text) {
      text = text
        .replace(/\u0001/g, '\t')
        .replace(/\u0002/g, '\n')
        .replace(/\r/g, '');
      lines.push(text);
    }
  }
  return normalizeBlankLines(lines.join('\n'));
}

// ------------------------------ pptx ---------------------------------------

/** Natural sort so slide2 comes before slide10. */
function slideNumber(name: string): number {
  const match = name.match(/slide(\d+)\.xml$/);
  return match ? parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function extractPptx(files: Record<string, Uint8Array>): string {
  const slides = Object.keys(files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  if (slides.length === 0) {
    throw new Error('pptx has no slides — file may be corrupt');
  }
  const parts: string[] = [];
  for (const name of slides) {
    const number = slideNumber(name);
    const xml = decodePart(files[name]);
    const text = extractTextRuns(xml, /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/);
    if (text.trim()) {
      parts.push(`--- Slide ${number} ---\n${text.trim()}`);
    }
  }
  return normalizeBlankLines(parts.join('\n\n'));
}

// ------------------------------ xlsx ---------------------------------------

/** Text of every `<si>` entry in xl/sharedStrings.xml (may span `<r>` runs). */
function parseSharedStrings(xml: string): string[] {
  const entries: string[] = [];
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let siMatch: RegExpExecArray | null;
  while ((siMatch = siRegex.exec(xml)) !== null) {
    entries.push(extractTextRuns(siMatch[1], /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/));
  }
  return entries;
}

/** Sheet display names in workbook order (sheetN.xml order matches). */
function parseSheetNames(xml: string): string[] {
  const names: string[] = [];
  const sheetRegex = /<sheet\b[^>]*name="([^"]*)"[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = sheetRegex.exec(xml)) !== null) {
    names.push(decodeXmlEntities(match[1]));
  }
  return names;
}

/** Column letters ("A1" → 0, "AB12" → 27) for cell ordering. */
function columnIndex(cellRef: string): number {
  const letters = cellRef.match(/^[A-Z]+/);
  if (!letters) {
    return Number.MAX_SAFE_INTEGER;
  }
  let index = 0;
  for (const char of letters[0]) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

function extractCellValue(cellXml: string, sharedStrings: string[]): string {
  const typeMatch = cellXml.match(/\bt="([^"]*)"/);
  const type = typeMatch ? typeMatch[1] : 'n';
  if (type === 'inlineStr') {
    return extractTextRuns(cellXml, /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/);
  }
  const valueMatch = cellXml.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
  if (!valueMatch) {
    return '';
  }
  if (type === 's') {
    const index = parseInt(valueMatch[1], 10);
    return sharedStrings[index] ?? '';
  }
  if (type === 'b') {
    return valueMatch[1] === '1' ? 'TRUE' : 'FALSE';
  }
  return decodeXmlEntities(valueMatch[1]);
}

/** Natural sort so sheet2 comes before sheet10. */
function sheetFileNumber(name: string): number {
  const match = name.match(/sheet(\d+)\.xml$/);
  return match ? parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function extractXlsx(files: Record<string, Uint8Array>): string {
  const sharedStringsXml = files['xl/sharedStrings.xml'];
  const sharedStrings = sharedStringsXml
    ? parseSharedStrings(decodePart(sharedStringsXml))
    : [];
  const workbookXml = files['xl/workbook.xml'];
  const sheetNames = workbookXml
    ? parseSheetNames(decodePart(workbookXml))
    : [];
  const sheets = Object.keys(files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => sheetFileNumber(a) - sheetFileNumber(b));
  if (sheets.length === 0) {
    throw new Error('xlsx has no worksheets — file may be corrupt');
  }
  const parts: string[] = [];
  sheets.forEach((name, index) => {
    const sheetName = sheetNames[index] || `Sheet${index + 1}`;
    const xml = decodePart(files[name]);
    const lines: string[] = [];
    const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRegex.exec(xml)) !== null) {
      const cells: { index: number; text: string }[] = [];
      const cellRegex = /<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g;
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
        const cellXml = cellMatch[0];
        const refMatch = cellXml.match(/\br="([A-Z]+\d+)"/);
        const text = extractCellValue(cellXml, sharedStrings);
        if (text) {
          cells.push({
            index: refMatch ? columnIndex(refMatch[1]) : cells.length,
            text,
          });
        }
      }
      if (cells.length > 0) {
        cells.sort((a, b) => a.index - b.index);
        lines.push(cells.map((c) => c.text).join('\t'));
      }
    }
    if (lines.length > 0) {
      parts.push(`# ${sheetName}\n${lines.join('\n')}`);
    }
  });
  return normalizeBlankLines(parts.join('\n\n'));
}

// ------------------------------ entry --------------------------------------

/**
 * Extract plain text from a docx/pptx/xlsx byte stream.
 * Sync on purpose — unzipping a ≤20MB document is fast; callers wrap in
 * async tool handlers anyway.
 */
export function extractOfficeText(
  bytes: ArrayBuffer | Uint8Array,
  path: string,
): string {
  const lower = (path || '').toLowerCase();
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    );
  } catch (e) {
    throw new Error('not a valid Office document (unzip failed)');
  }
  if (lower.endsWith('.docx')) {
    return extractDocx(files);
  }
  if (lower.endsWith('.pptx')) {
    return extractPptx(files);
  }
  if (lower.endsWith('.xlsx')) {
    return extractXlsx(files);
  }
  throw new Error(`unsupported office extension: ${path}`);
}
