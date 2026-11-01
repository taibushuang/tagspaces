/**
 * TagSpaces - universal file and folder organizer
 * Copyright (C) 2017-present TagSpaces GmbH
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
 * Style overrides injected into viewer extension iframes by FileView.
 *
 * The bundled md-editor extension (@tagspaces/extensions/md-editor, Milkdown
 * Crepe theme) hardcodes heading sizes up to 32-42px against 16px body text,
 * and forces tables to `table-layout: fixed; width: 100%`, so tables always
 * stretch full-width regardless of their content. Both rules live in the
 * extension's prebuilt CSS, which is wiped on every npm install — so instead
 * of patching node_modules, the host app injects this stylesheet into the
 * same-origin iframe after each viewer load.
 *
 * Everything is scoped under `.milkdown` so other viewer extensions (pdf,
 * image, …) that share this FileView iframe are not affected.
 */
export const MD_VIEWER_STYLE_ID = 'ts-md-viewer-overrides';

/** Scroll container inside the md-editor extension page (its #app div). */
export const MD_VIEWER_SCROLL_ROOT = '#app';

export const MD_VIEWER_OVERRIDES_CSS = `
/* Heading-to-body contrast: Crepe ships h1=32px/h2=28px/h3=24px against 16px
   body. Align with common markdown viewers (h1 24px … h6 14px). */
.milkdown .ProseMirror h1 { font-size: 24px; line-height: 32px; margin-top: 24px; }
.milkdown .ProseMirror h2 { font-size: 20px; line-height: 28px; margin-top: 20px; }
.milkdown .ProseMirror h3 { font-size: 18px; line-height: 26px; margin-top: 18px; }
.milkdown .ProseMirror h4 { font-size: 16px; line-height: 24px; margin-top: 16px; }
.milkdown .ProseMirror h5 { font-size: 15px; line-height: 22px; margin-top: 14px; }
.milkdown .ProseMirror h6 { font-size: 14px; line-height: 20px; margin-top: 14px; font-weight: 600; }

/* Tables: fit content instead of stretching to 100% of the pane; wide tables
   scroll horizontally inside their block wrapper. */
.milkdown .ProseMirror table { table-layout: auto !important; width: auto !important; max-width: 100%; }
.milkdown .milkdown-table-block { overflow-x: auto; }
`;
