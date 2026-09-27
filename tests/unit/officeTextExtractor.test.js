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
import { describe, expect, test } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
import {
  extractOfficeText,
  isOfficeDocumentPath,
} from '-/services/officeTextExtractor';

function docxFixture(documentXml) {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(documentXml),
  });
}

function pptxFixture(slideFiles) {
  const files = {
    '[Content_Types].xml': strToU8('<Types/>'),
  };
  Object.keys(slideFiles).forEach((name) => {
    files[`ppt/slides/${name}`] = strToU8(slideFiles[name]);
  });
  return zipSync(files);
}

function xlsxFixture(sharedStringsXml, workbookXml, worksheets) {
  const files = {
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/sharedStrings.xml': strToU8(sharedStringsXml),
    'xl/workbook.xml': strToU8(workbookXml),
  };
  Object.keys(worksheets).forEach((name) => {
    files[`xl/worksheets/${name}`] = strToU8(worksheets[name]);
  });
  return zipSync(files);
}

describe('officeTextExtractor', () => {
  describe('isOfficeDocumentPath', () => {
    test('accepts docx/pptx/xlsx (case-insensitive)', () => {
      expect(isOfficeDocumentPath('a/b.Report.DOCX')).toBe(true);
      expect(isOfficeDocumentPath('slides.PPTX')).toBe(true);
      expect(isOfficeDocumentPath('C:\\data\\table.xlsx')).toBe(true);
    });

    test('rejects text, legacy OLE and unknown types', () => {
      expect(isOfficeDocumentPath('notes.txt')).toBe(false);
      expect(isOfficeDocumentPath('legacy.doc')).toBe(false);
      expect(isOfficeDocumentPath('legacy.xls')).toBe(false);
      expect(isOfficeDocumentPath('legacy.ppt')).toBe(false);
      expect(isOfficeDocumentPath('scan.pdf')).toBe(false);
      expect(isOfficeDocumentPath('')).toBe(false);
    });
  });

  describe('extractOfficeText — docx', () => {
    test('extracts paragraphs, entities, tabs and CJK text', () => {
      const bytes = docxFixture(
        '<?xml version="1.0"?>' +
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          '<w:body>' +
          '<w:p><w:r><w:t>Hello &amp; welcome</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>需求文档&#x7B2C;三版</w:t><w:tab/><w:t>优先级:高</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>line1</w:t><w:br/><w:t>line2</w:t></w:r></w:p>' +
          '<w:p><w:pPr><w:spacing/></w:pPr></w:p>' +
          '</w:body></w:document>',
      );
      const text = extractOfficeText(bytes, '需求文档.docx');
      expect(text).toContain('Hello & welcome');
      expect(text).toContain('需求文档第三版\t优先级:高');
      expect(text).toContain('line1\nline2');
      // empty paragraph collapses — no 3+ blank lines
      expect(text).not.toMatch(/\n{3,}/);
    });

    test('rejects broken docx (missing document.xml)', () => {
      const bytes = zipSync({ 'junk.xml': strToU8('<x/>') });
      expect(() => extractOfficeText(bytes, 'broken.docx')).toThrow(
        /missing word\/document\.xml/,
      );
    });
  });

  describe('extractOfficeText — pptx', () => {
    test('extracts slides in natural order with headers', () => {
      const bytes = pptxFixture({
        'slide1.xml':
          '<p:sld><p:txBody><a:p><a:r><a:t>封面 标题</a:t></a:r></a:p></p:txBody></p:sld>',
        'slide2.xml':
          '<p:sld><p:txBody><a:p><a:r><a:t>agenda</a:t></a:r></a:p></p:txBody></p:sld>',
        'slide10.xml':
          '<p:sld><p:txBody><a:p><a:r><a:t>thanks &amp; bye</a:t></a:r></a:p></p:txBody></p:sld>',
      });
      const text = extractOfficeText(bytes, 'deck.pptx');
      const positions = [
        text.indexOf('--- Slide 1 ---'),
        text.indexOf('--- Slide 2 ---'),
        text.indexOf('--- Slide 10 ---'),
      ];
      expect(positions).toEqual([
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
      ]);
      expect(positions[0]).toBeLessThan(positions[1]);
      expect(positions[1]).toBeLessThan(positions[2]);
      expect(text).toContain('封面 标题');
      expect(text).toContain('thanks & bye');
    });

    test('rejects pptx without slides', () => {
      const bytes = zipSync({ 'junk.xml': strToU8('<x/>') });
      expect(() => extractOfficeText(bytes, 'broken.pptx')).toThrow(
        /no slides/,
      );
    });
  });

  describe('extractOfficeText — xlsx', () => {
    const sharedStrings =
      '<?xml version="1.0"?><sst>' +
      '<si><t>客户名称</t></si>' +
      '<si><r><t>旺</t></r><r><t>财</t></r></si>' +
      '</sst>';
    const workbook =
      '<?xml version="1.0"?><workbook><sheets>' +
      '<sheet name="任务表" sheetId="1" r:id="rId1"/>' +
      '<sheet name="数据" sheetId="2" r:id="rId2"/>' +
      '</sheets></workbook>';

    test('resolves shared strings, inline strings, numbers, booleans', () => {
      const bytes = xlsxFixture(
        sharedStrings,
        workbook,
        {
          'sheet1.xml':
            '<worksheet><sheetData>' +
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row>' +
            '<row r="2"><c r="A2" t="inlineStr"><is><t>待办事项</t></is></c>' +
            '<c r="B2" t="s"><v>1</v></c></row>' +
            '<row r="3"><c r="A3" t="b"><v>1</v></c></row>' +
            '</sheetData></worksheet>',
          'sheet2.xml':
            '<worksheet><sheetData>' +
            '<row r="1"><c r="A1"><v>7.5</v></c></row>' +
            '</sheetData></worksheet>',
        },
      );
      const text = extractOfficeText(bytes, '任务表.xlsx');
      expect(text).toContain('# 任务表');
      expect(text).toContain('客户名称\t42');
      expect(text).toContain('待办事项\t旺财');
      expect(text).toContain('TRUE');
      expect(text).toContain('# 数据');
      expect(text).toContain('7.5');
    });

    test('sorts cells by column when file order differs', () => {
      const bytes = xlsxFixture(
        '<?xml version="1.0"?><sst><si><t>b</t></si><si><t>a</t></si></sst>',
        '<?xml version="1.0"?><workbook><sheets><sheet name="S1" sheetId="1"/></sheets></workbook>',
        {
          // file lists B before A — output must reorder
          'sheet1.xml':
            '<worksheet><sheetData><row r="1">' +
            '<c r="B1" t="s"><v>0</v></c><c r="A1" t="s"><v>1</v></c>' +
            '</row></sheetData></worksheet>',
        },
      );
      const text = extractOfficeText(bytes, 't.xlsx');
      expect(text).toContain('a\tb');
    });

    test('rejects xlsx without worksheets', () => {
      const bytes = zipSync({ 'junk.xml': strToU8('<x/>') });
      expect(() => extractOfficeText(bytes, 'broken.xlsx')).toThrow(
        /no worksheets/,
      );
    });
  });

  test('rejects non-zip bytes with a clear error', () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(() => extractOfficeText(garbage, 'fake.docx')).toThrow(
      /unzip failed/,
    );
  });
});
