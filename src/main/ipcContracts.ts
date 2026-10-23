/**
 * IPC channel contracts shared by main-process handlers and renderer
 * callers. preload's invoke() passes args as unknown[] with zero runtime
 * validation, so parameter drift between the two sides (e.g. addDir vs
 * addDirs) can only be caught at compile time — which requires both sides
 * to import the SAME type definitions from this file.
 *
 * Conventions for adding a channel here:
 * - one entry per channel in IpcContracts: tuple `args` + `result`;
 * - request/response shapes as named types (not inline) so either side
 *   can reference individual fields;
 * - pure types only (no imports) — safe to bundle on both sides.
 */

export type ScannedSkill = {
  /** Absolute folder path — the stable handle for import. */
  dir: string;
  name: string;
  description: string;
  instruction: string;
  truncated: boolean;
  sizeBytes: number;
};

export type ScannedToolServer = {
  name: string;
  /** stdio = local command, http/sse = remote endpoint, unknown */
  transport: 'stdio' | 'http' | 'sse' | 'unknown';
  /** Config file the entry was found in. */
  sourceFile: string;
  /** command + args (stdio) or url (http/sse) for reference. */
  detail: string;
};

/** skillsScan request. Canonical form is the plural addDirs array — the
 * singular addDir string accepted by the handler is a legacy-compat shim
 * only (see scanAll in skillScanner.ts) and deliberately NOT part of the
 * contract. */
export type SkillScanRequest = {
  addDirs?: string[];
  removeDir?: string;
};

export type SkillScanResult = {
  defaultDirs: string[];
  extraDirs: string[];
  skills: ScannedSkill[];
  toolServers: ScannedToolServer[];
};

/** skillsImportDir response: the transformed custom-skill draft, with the
 * copied supporting-files folder recorded in destDir. */
export type PreparedSkillImport = {
  name: string;
  description: string;
  instruction: string;
  truncated: boolean;
  destDir: string;
};

/** skillsDeleteCopy request: removes the copied folder of an imported
 * skill (cleanup when the custom skill is deleted). */
export type SkillDeleteCopyRequest = {
  name: string;
  sourceDir: string;
};

export type IpcContracts = {
  skillsScan: {
    args: [options?: SkillScanRequest];
    result: SkillScanResult;
  };
  skillsImportDir: {
    args: [srcDir: string];
    result: PreparedSkillImport;
  };
  skillsDeleteCopy: {
    args: [request: SkillDeleteCopyRequest];
    result: { removed: boolean };
  };
};
