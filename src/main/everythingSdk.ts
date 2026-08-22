/**
 * Everything SDK wrapper for TagSpaces Windows desktop.
 *
 * Uses koffi to load Everything.dll (64/32-bit) and provides a safe,
 * serialised search interface. All calls go through the W (Unicode) APIs
 * so Chinese paths are handled correctly.
 *
 * DLL discovery order:
 *   1. Custom path from settings (install dir, exe or dll path)
 *   2. Registry: HKCU/HKLM App Paths, Uninstall InstallLocation, Run key,
 *      Everything service ImagePath (SYSTEM\CurrentControlSet\Services)
 *   3. Default:  C:\Program Files\Everything[64].dll / (x86)\Everything32.dll
 *   4. Fallback: bundled SDK dll shipped under resources/everything/
 *
 * This module is lazy-loaded in mainEvents.ts **only on win32** to avoid
 * crashing the macOS development machine.
 */

import koffi, { LibraryHandle } from 'koffi';
import path from 'path';
import fs from 'fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EverythingSearchOptions {
  /** Maximum results to return (default 200 for live search) */
  maxResults?: number;
  /** Limit search to a specific folder path */
  pathPrefix?: string;
  /** File extensions filter, e.g. ['pdf', 'doc'] */
  extensions?: string[];
  /** Minimum file size in bytes */
  minSize?: number;
  /** Maximum file size in bytes */
  maxSize?: number;
  /** Modified after (epoch ms) */
  modifiedAfter?: number;
  /** Modified before (epoch ms) */
  modifiedBefore?: number;
}

export interface EverythingResult {
  path: string;
  name: string;
  isFile: boolean;
  size: number;
  lmdt: number; // epoch ms
}

export interface EverythingSearchResponse {
  available: boolean;
  results: EverythingResult[];
  totalCount?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUEST_FLAGS = 0x54; // FULL_PATH | SIZE | DATE_MODIFIED
const DEFAULT_MAX_RESULTS = 200;
const AVAILABILITY_CACHE_TTL_MS = 30000;
const PATH_BUF_SIZE = 32767; // Windows max path length

/** YYYYMMDD in local time (Everything dm:/dc: ranges are local-time based). */
function formatLocalDate(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}${month}${day}`;
}
const DEBUG_LOG_MAX = 300;
const AUTOSTART_THROTTLE_MS = 60000;
// First-run indexing can take a while (real-world reports: 1.5b first build
// 30-60s+). Negative results are never cached, so the next search re-probes
// anyway — this timeout only bounds the explicit wait loop.
const DB_LOAD_TIMEOUT_MS = 120000;

// ---------------------------------------------------------------------------
// Debug log (ring buffer, surfaced in the Everything debug dialog)
// ---------------------------------------------------------------------------

export interface EverythingDebugEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

const debugLog: EverythingDebugEntry[] = [];

function logDebug(level: 'info' | 'warn' | 'error', message: string) {
  debugLog.push({ ts: Date.now(), level, message });
  if (debugLog.length > DEBUG_LOG_MAX) {
    debugLog.splice(0, debugLog.length - DEBUG_LOG_MAX);
  }
  if (level === 'error') {
    console.error('[Everything]', message);
  } else {
    console.log('[Everything]', message);
  }
}

// Last-known state for the debug dialog
let lastQuery: string | undefined;
let lastQueryAt: number | undefined;
let lastResultCount: number | undefined;
let lastError: string | undefined;
let lastAutoStartAt = 0;
let autoStartInFlight: Promise<boolean> | undefined;

// ---------------------------------------------------------------------------
// DLL Discovery
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Native registry access (koffi / advapi32). reg.exe prints OEM-codepage text
// and execSync(encoding:'utf8') mangles non-ASCII install paths
// (e.g. D:\软件\Everything → U+FFFD garbage, fs.existsSync() then fails).
// RegQueryValueExW returns true Unicode with no codepage involved.
// ---------------------------------------------------------------------------

const HKEY_CURRENT_USER = 0x80000001;
const HKEY_LOCAL_MACHINE = 0x80000002;
const KEY_READ_WOW64_64 = 0x20019 | 0x0100; // KEY_READ | KEY_WOW64_64KEY
const REG_SZ = 1;
const REG_EXPAND_SZ = 2;
const ERROR_MORE_DATA = 234;

let regApi:
  | { openKey: any; queryValue: any; closeKey: any }
  | undefined
  | null;

function getRegApi() {
  if (regApi !== undefined) return regApi || undefined;
  try {
    const advapi32 = koffi.load('advapi32.dll');
    regApi = {
      // LSTATUS RegOpenKeyExW(HKEY, LPCWSTR, DWORD, DWORD samDesired, PHKEY)
      openKey: advapi32.func('RegOpenKeyExW', 'int', [
        'uintptr',
        'str16',
        'uint32',
        'uint32',
        koffi.out(koffi.pointer('uintptr')),
      ]),
      // LSTATUS RegQueryValueExW(HKEY, LPCWSTR, LPDWORD reserved,
      //   LPDWORD type, LPBYTE data, LPDWORD cbData)
      // cbData is IN+OUT (in: buffer capacity, out: bytes written/required)
      // — declared as plain koffi.out() it loses the initial value and every
      // call fails with ERROR_MORE_DATA.
      queryValue: advapi32.func('RegQueryValueExW', 'int', [
        'uintptr',
        'str16',
        'uintptr', // reserved — pass 0 (NULL)
        koffi.out(koffi.pointer('uint32')),
        koffi.out(koffi.pointer('uint8')),
        koffi.inout(koffi.pointer('uint32')),
      ]),
      closeKey: advapi32.func('RegCloseKey', 'int', ['uintptr']),
    };
    return regApi;
  } catch (err: any) {
    logDebug('error', `Failed to bind advapi32 registry API: ${err.message}`);
    regApi = null;
    return undefined;
  }
}

/** Read a REG_SZ/REG_EXPAND_SZ value; undefined when missing/non-string. */
function readRegString(
  root: number,
  subKey: string,
  valueName = '', // '' = default (unnamed) value
): string | undefined {
  const api = getRegApi();
  if (!api) return undefined;
  let hkeyOut = [0n];
    const openRc = api.openKey(root, subKey, 0, KEY_READ_WOW64_64, hkeyOut);
    if (openRc !== 0) {
      // rc=2 (key absent) is the common case while probing candidates — stay
      // quiet; the caller logs a summary when nothing is found at all.
      return undefined;
    }
  const hkey = hkeyOut[0];
  try {
    let buf = new Uint8Array(4096);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const typeOut = [0];
      const sizeOut = [buf.length];
      const status = api.queryValue(hkey, valueName, 0, typeOut, buf, sizeOut);
      if (status === 0) {
        if (typeOut[0] !== REG_SZ && typeOut[0] !== REG_EXPAND_SZ) {
          return undefined;
        }
        const byteLen = Math.min(Number(sizeOut[0]), buf.length);
        const u16 = new Uint16Array(buf.buffer, 0, Math.floor(byteLen / 2));
        let strLen = u16.indexOf(0);
        if (strLen === -1) strLen = u16.length;
        const value = Buffer.from(buf.buffer, 0, strLen * 2)
          .toString('utf16le')
          .trim();
        return value.length > 0 ? value : undefined;
      }
      if (status === ERROR_MORE_DATA && attempt === 0) {
        // sizeOut now holds the required size — grow and retry once
        buf = new Uint8Array(Number(sizeOut[0]) + 2);
        // eslint-disable-next-line no-continue
        continue;
      }
      return undefined;
    }
    return undefined;
  } catch (err: any) {
    logDebug(
      'warn',
      `registry read failed (${subKey}\\${valueName}): ${err.message}`,
    );
    return undefined;
  } finally {
    try {
      api.closeKey(hkey);
    } catch {
      /* handle already invalid */
    }
  }
}

function splitRoot(regPath: string):
  | { root: number; subKey: string }
  | undefined {
  const hklm = /^HKLM\\(.+)$/i.exec(regPath);
  if (hklm) return { root: HKEY_LOCAL_MACHINE, subKey: hklm[1] };
  const hkcu = /^HKCU\\(.+)$/i.exec(regPath);
  if (hkcu) return { root: HKEY_CURRENT_USER, subKey: hkcu[1] };
  return undefined;
}

/** Default (unnamed) value of a key like "HKLM\...\App Paths\Everything.exe". */
function queryRegistry(regPath: string): string | undefined {
  const parts = splitRoot(regPath);
  return parts ? readRegString(parts.root, parts.subKey) : undefined;
}

/** Named value of a key like "HKLM\SOFTWARE\...\Uninstall\Everything". */
function queryRegistryValue(
  regPath: string,
  valueName: string,
): string | undefined {
  const parts = splitRoot(regPath);
  return parts
    ? readRegString(parts.root, parts.subKey, valueName)
    : undefined;
}

// Only log probe results when they change (the debug dialog polls every second)
let lastExeProbe: string | null | undefined;
let lastDllProbe: string | null | undefined;

// User-configured Everything location (install dir, Everything.exe or dll
// path). Set from the renderer settings via IPC on every search.
let customEverythingPath: string | undefined;

// exe/running probing spawns sync child processes (reg.exe, tasklist.exe).
// Cache the results so the debug dialog's 1s polling does not block the
// Electron main process with several process spawns per second.
const PROBE_CACHE_TTL_MS = 5000;
let probeCache:
  | { at: number; exePath: string | undefined; running: boolean }
  | undefined;

/**
 * Locate Everything.exe itself (used to auto-start the service and to find
 * the SDK dll next to it).
 */
function findEverythingExe(): string | undefined {
  // Only accept real Everything executables — a custom path pointing at an
  // unrelated .exe must not be launched.
  const EVERYTHING_EXE_RE = /^everything(64)?\.exe$/i;
  const probe = (
    exe: string | undefined,
    source: string,
  ): string | undefined => {
    if (
      exe &&
      EVERYTHING_EXE_RE.test(path.basename(exe)) &&
      fs.existsSync(exe)
    ) {
      if (lastExeProbe !== exe) {
        lastExeProbe = exe;
        logDebug('info', `Everything.exe found via ${source}: ${exe}`);
      }
      return exe;
    }
    return undefined;
  };

  // 0. User-configured custom path (install dir, exe or dll path)
  if (customEverythingPath) {
    const p = customEverythingPath;
    const customCandidates = /\.exe$/i.test(p)
      ? [p]
      : /\.dll$/i.test(p)
        ? [path.join(path.dirname(p), 'Everything.exe')]
        : [path.join(p, 'Everything.exe')];
    for (const candidate of customCandidates) {
      const hit = probe(candidate, 'custom path');
      if (hit) return hit;
    }
  }

  // 1. Registry: App Paths
  const regPaths = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Everything.exe',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Everything.exe',
  ];
  for (const regPath of regPaths) {
    const hit = probe(queryRegistry(regPath), 'registry App Paths');
    if (hit) return hit;
  }

  // 2. Registry: Uninstall key (Everything installer writes InstallLocation).
  //    MSI builds register under a product GUID subkey instead — not
  //    enumerable cheaply; those installs land in the default dir anyway.
  const uninstallKeys = [
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Everything',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Everything',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Everything',
  ];
  for (const key of uninstallKeys) {
    const location = queryRegistryValue(key, 'InstallLocation');
    if (location) {
      const hit = probe(
        path.join(location, 'Everything.exe'),
        'registry Uninstall key',
      );
      if (hit) return hit;
    }
  }

  // 3. Registry: autostart Run key — value is a command line like
  //    "C:\Program Files\Everything\Everything.exe" -startup
  const runKeys = [
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
  ];
  for (const key of runKeys) {
    const cmdLine = queryRegistryValue(key, 'Everything');
    if (cmdLine) {
      const match = cmdLine.match(/^"?([^"]+?\.exe)/i);
      if (match) {
        const hit = probe(match[1], 'registry Run key');
        if (hit) return hit;
      }
    }
  }

  // 3b. Everything Service registration — ImagePath points at the exe even
  //     when neither App Paths nor an Uninstall entry exists.
  const svcCmd = queryRegistryValue(
    'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Everything',
    'ImagePath',
  );
  if (svcCmd) {
    const match = /^"?([^"]+?\.exe)/i.exec(svcCmd.trim());
    if (match) {
      const hit = probe(match[1], 'Everything service ImagePath');
      if (hit) return hit;
    }
  }

  // 4. Default paths (machine-scope installs; LOCALAPPDATA kept as a cheap
  //    fallback for portable/per-user setups)
  const candidates = [
    'C:\\Program Files\\Everything\\Everything.exe',
    'C:\\Program Files (x86)\\Everything\\Everything.exe',
    ...(process.env.LOCALAPPDATA
      ? [
          path.join(
            process.env.LOCALAPPDATA,
            'Programs',
            'Everything',
            'Everything.exe',
          ),
        ]
      : []),
  ];
  for (const candidate of candidates) {
    const hit = probe(candidate, 'default path');
    if (hit) return hit;
  }
  if (lastExeProbe !== null) {
    lastExeProbe = null;
    logDebug(
      'warn',
      'Everything.exe not found (custom path, registry, default paths).',
    );
  }
  return undefined;
}

function findDllPath(): string | undefined {
  // 0. User-configured custom path (dir, exe or dll)
  if (customEverythingPath) {
    const p = customEverythingPath;
    if (/\.dll$/i.test(p) && fs.existsSync(p)) {
      logDebug('info', `Using custom Everything dll: ${p}`);
      return p;
    }
    const dir = /\.exe$/i.test(p) ? path.dirname(p) : p;
    for (const name of [
      'Everything64.dll',
      'Everything32.dll',
      'Everything.dll',
    ]) {
      const dll = path.join(dir, name);
      if (fs.existsSync(dll)) {
        logDebug('info', `Using dll from custom Everything path: ${dll}`);
        return dll;
      }
    }
    logDebug('warn', `Custom Everything path set but no dll found: ${p}`);
  }

  // 1. Next to Everything.exe (registry App Paths)
  const exe = findEverythingExe();
  if (exe) {
    const exeDir = path.dirname(exe);
    // Everything 1.4 ships Everything64.dll/Everything32.dll; some installs
    // only carry the plain Everything.dll — accept all three.
    for (const name of [
      'Everything64.dll',
      'Everything32.dll',
      'Everything.dll',
    ]) {
      const dll = path.join(exeDir, name);
      if (fs.existsSync(dll)) {
        if (lastDllProbe !== dll) {
          lastDllProbe = dll;
          logDebug('info', `SDK dll found next to Everything.exe: ${dll}`);
        }
        return dll;
      }
    }
    logDebug('warn', `No Everything SDK dll found next to ${exe}`);
  }

  // 2. Default install paths
  const candidates = [
    'C:\\Program Files\\Everything\\Everything64.dll',
    'C:\\Program Files (x86)\\Everything\\Everything32.dll',
    'C:\\Program Files\\Everything\\Everything.dll',
    'C:\\Program Files (x86)\\Everything\\Everything.dll',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      if (lastDllProbe !== candidate) {
        lastDllProbe = candidate;
        logDebug('info', `SDK dll found at default path: ${candidate}`);
      }
      return candidate;
    }
  }

  // 3. Bundled SDK dll shipped with TagSpaces (the voidtools installer
  // does not include the SDK dll, so we carry our own copy).
  const bundled = [
    ...(process.resourcesPath
      ? [path.join(process.resourcesPath, 'everything', 'Everything64.dll')]
      : []),
    path.join(process.cwd(), 'resources', 'everything', 'Everything64.dll'), // dev
  ];
  for (const candidate of bundled) {
    if (fs.existsSync(candidate)) {
      if (lastDllProbe !== candidate) {
        lastDllProbe = candidate;
        logDebug('info', `Using bundled Everything SDK dll: ${candidate}`);
      }
      return candidate;
    }
  }

  if (lastDllProbe !== null) {
    lastDllProbe = null;
    logDebug('error', 'Everything SDK dll not found anywhere.');
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// koffi bindings
// ---------------------------------------------------------------------------

let dllPath: string | undefined;
let lib: LibraryHandle | undefined;
// koffi's lib.func() does NOT attach the function to the library object —
// keep explicit references here. (Accessing lib.Everything_Xxx silently
// yields undefined and every call throws.)
let api: Record<string, any> | undefined;
let isAvailable = false;
let availabilityCheckedAt = 0;
let availabilityError: string | undefined;

export function setCustomEverythingPath(p?: string): void {
  const normalized = p && p.trim() ? p.trim() : undefined;
  if (normalized === customEverythingPath) return;
  customEverythingPath = normalized;
  logDebug('info', `Custom Everything path set: ${normalized ?? '(cleared)'}`);
  // Force dll re-resolution on next use (old handle stays loaded in memory,
  // koffi cannot unload — harmless).
  lib = undefined;
  dllPath = undefined;
  isAvailable = false;
  availabilityCheckedAt = 0;
  lastDllProbe = undefined;
  lastExeProbe = undefined;
  invalidateProbeCache();
}

// FILETIME struct for koffi
const FILETIME = koffi.struct('FILETIME', {
  dwLowDateTime: 'uint32',
  dwHighDateTime: 'uint32',
});

function loadLibrary(): boolean {
  if (lib) return true;

  dllPath = findDllPath();
  if (!dllPath) {
    availabilityError = 'Everything.dll not found. Is Everything installed?';
    logDebug('error', availabilityError);
    return false;
  }

  try {
    lib = koffi.load(dllPath);

    // Declare W (Unicode) functions — keep the returned callables!
    api = {
      SetSearchW: lib.func('Everything_SetSearchW', 'void', ['str16']),
      SetMax: lib.func('Everything_SetMax', 'void', ['uint32']),
      SetRequestFlags: lib.func('Everything_SetRequestFlags', 'void', [
        'uint32',
      ]),
      // Win32 BOOL is a 4-byte int; koffi 'bool' is 1 byte — declare as int.
      QueryW: lib.func('Everything_QueryW', 'int', ['int']),
      GetNumResults: lib.func('Everything_GetNumResults', 'uint32', []),
      GetTotResults: lib.func('Everything_GetTotResults', 'uint32', []),
      GetResultFullPathNameW: lib.func(
        'Everything_GetResultFullPathNameW',
        'uint32',
        // str16 out-buffers must be real typed arrays passed through a
        // pointer type — koffi.out('str16') with a prefilled string
        // silently returns nothing (prototype-style `_Out_ char *` is the
        // only form that supports string buffers, per koffi docs).
        ['uint32', koffi.out(koffi.pointer('uint16')), 'uint32'],
      ),
      GetResultSize: lib.func('Everything_GetResultSize', 'void', [
        'uint32',
        // koffi.out() only accepts pointer or string types — scalar out-params
        // must be wrapped in koffi.pointer(). Call site passes [0n].
        koffi.out(koffi.pointer('int64')),
      ]),
      GetResultDateModified: lib.func(
        'Everything_GetResultDateModified',
        'void',
        ['uint32', koffi.out(koffi.pointer(FILETIME))],
      ),
      IsFileResult: lib.func('Everything_IsFileResult', 'int', ['uint32']),
      IsFolderResult: lib.func('Everything_IsFolderResult', 'int', ['uint32']),
      GetLastError: lib.func('Everything_GetLastError', 'uint32', []),
      IsDBLoaded: lib.func('Everything_IsDBLoaded', 'int', []),
    };

    return true;
  } catch (err: any) {
    availabilityError = `Failed to load Everything.dll (${dllPath}): ${err.message} — file may be corrupt or built for another CPU architecture`;
    logDebug('error', availabilityError);
    lib = undefined;
    api = undefined;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Auto-remediation: start Everything.exe when it is installed but not running
// ---------------------------------------------------------------------------

function isEverythingRunning(): boolean {
  try {
    const { execSync } = require('child_process');
    const output = execSync('tasklist /FI "IMAGENAME eq Everything.exe"', {
      encoding: 'utf8',
      windowsHide: true,
    });
    return /Everything\.exe/i.test(output);
  } catch (err: any) {
    logDebug('warn', `tasklist check failed: ${err.message}`);
    return false;
  }
}

/**
 * Whether TagSpaces itself runs elevated (High Mandatory Level).
 * Relevant because Windows UIPI silently drops window messages sent to a
 * MORE privileged process — if Everything runs as admin and we do not,
 * every SDK call fails. S-1-16-12288 = high integrity level SID.
 */
function isSelfElevated(): boolean {
  try {
    const { execSync } = require('child_process');
    const output = execSync('whoami /groups', {
      encoding: 'utf8',
      windowsHide: true,
    });
    return /S-1-16-12288/.test(output);
  } catch {
    return false;
  }
}

function isDbLoaded(): boolean {
  try {
    return api ? api.IsDBLoaded() !== 0 : false;
  } catch (err: any) {
    logDebug('error', `IsDBLoaded call failed: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Low-level IPC probe (bypasses the SDK dll to split failure causes)
// ---------------------------------------------------------------------------

// From the official SDK (ipc/everything_ipc.h):
//   window class  = EVERYTHING_TASKBAR_NOTIFICATION
//   EVERYTHING_WM_IPC = WM_USER (0x0400), IS_DB_LOADED command = 401
const EVERYTHING_IPC_WNDCLASS = 'EVERYTHING_TASKBAR_NOTIFICATION';
const EVERYTHING_WM_IPC = 0x0400;
const EVERYTHING_IPC_IS_DB_LOADED = 401;
const SMTO_BLOCK_ABORTIFHUNG = 0x0003; // SMTO_BLOCK | SMTO_ABORTIFHUNG

let ipcFuncs: { FindWindowW: any; SendMessageTimeoutW: any } | undefined | null;

function getIpcFuncs() {
  if (ipcFuncs !== undefined) return ipcFuncs;
  try {
    const user32 = koffi.load('user32.dll');
    const FindWindowW = user32.func('FindWindowW', 'uintptr', [
      'str16',
      'str16',
    ]);
    const SendMessageTimeoutW = user32.func('SendMessageTimeoutW', 'int64', [
      'uintptr',
      'uint32',
      'uintptr',
      'uintptr',
      'uint32',
      'uint32',
      koffi.out(koffi.pointer('uint64')),
    ]);
    ipcFuncs = { FindWindowW, SendMessageTimeoutW };
  } catch (err: any) {
    logDebug('error', `Failed to bind user32 IPC probe: ${err.message}`);
    ipcFuncs = null;
  }
  return ipcFuncs;
}

export interface IpcProbeResult {
  windowFound: boolean;
  sendMessageOk: boolean;
  dbLoaded?: boolean;
  error?: string;
}

/**
 * The SDK's IsDBLoaded() collapses three distinct failures into one false:
 *  1. Everything window not found (not running / different session / 1.5
 *     named instance with a different window class)
 *  2. SendMessage blocked (UIPI privilege isolation)
 *  3. DB genuinely not loaded yet
 * This probe separates them via direct user32 calls.
 */
export function probeIpc(): IpcProbeResult {
  try {
    const funcs = getIpcFuncs();
    if (!funcs) {
      return {
        windowFound: false,
        sendMessageOk: false,
        error: 'user32 bindings unavailable',
      };
    }
    const hwnd = Number(funcs.FindWindowW(EVERYTHING_IPC_WNDCLASS, null));
    if (!hwnd) {
      return {
        windowFound: false,
        sendMessageOk: false,
        error:
          'Everything IPC window not found. Everything is not running in this session, or it is a 1.5 named instance.',
      };
    }
    const resultOut = [0n];
    const ret = funcs.SendMessageTimeoutW(
      hwnd,
      EVERYTHING_WM_IPC,
      EVERYTHING_IPC_IS_DB_LOADED,
      0,
      SMTO_BLOCK_ABORTIFHUNG,
      2000,
      resultOut,
    );
    if (ret === 0 || ret === 0n) {
      return {
        windowFound: true,
        sendMessageOk: false,
        error:
          'IPC window found but SendMessage failed/timed out — privilege isolation (UIPI) or a hung Everything.',
      };
    }
    return {
      windowFound: true,
      sendMessageOk: true,
      dbLoaded: resultOut[0] !== 0n,
    };
  } catch (err: any) {
    return {
      windowFound: false,
      sendMessageOk: false,
      error: `IPC probe error: ${err.message}`,
    };
  }
}

function getProbeCached(): { exePath: string | undefined; running: boolean } {
  if (!probeCache || Date.now() - probeCache.at > PROBE_CACHE_TTL_MS) {
    probeCache = {
      at: Date.now(),
      exePath: findEverythingExe(),
      running: isEverythingRunning(),
    };
  }
  return probeCache;
}

/** Invalidate after install/start actions so the dialog reflects reality. */
function invalidateProbeCache(): void {
  probeCache = undefined;
}

/**
 * Launch Everything.exe and wait until its database is loaded.
 * Resolves true when the DB became ready within DB_LOAD_TIMEOUT_MS.
 */
async function startEverythingAndWait(): Promise<boolean> {
  const exe = findEverythingExe();
  if (!exe) {
    logDebug('error', 'Cannot auto-start: Everything.exe not found.');
    return false;
  }

  logDebug('info', `Auto-starting Everything: ${exe}`);
  const spawned = await new Promise<boolean>((resolve) => {
    try {
      const { spawn } = require('child_process');
      const child = spawn(exe, ['-startup'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      // spawn failures (e.g. ERROR_ELEVATION_REQUIRED when Everything.exe is
      // marked "run as administrator") arrive as async error events, NOT
      // exceptions — without this listener they vanish silently.
      child.once('error', (err: any) => {
        logDebug('error', `spawn failed: ${err.message}`);
        resolve(false);
      });
      child.once('spawn', () => {
        logDebug('info', `Everything.exe spawned, pid=${child.pid}`);
        child.unref();
        resolve(true);
      });
    } catch (err: any) {
      logDebug('error', `spawn threw: ${err.message}`);
      resolve(false);
    }
  });

  if (!spawned) {
    // Fallback: cmd start goes through ShellExecute, which can show the UAC
    // prompt and launch elevated processes.
    try {
      const { exec } = require('child_process');
      exec(`cmd /c start "" /min "${exe}" -startup`, { windowsHide: true });
      logDebug(
        'info',
        'ShellExecute fallback issued (a UAC prompt may appear — please accept it).',
      );
    } catch (err: any) {
      logDebug('error', `ShellExecute fallback failed: ${err.message}`);
      return false;
    }
  }

  const deadline = Date.now() + DB_LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // Polling requires a sequential await between probes.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 1000);
    });
    if (lib && isDbLoaded()) {
      logDebug('info', 'Everything database is loaded after auto-start.');
      return true;
    }
  }
  // Distinguish "process never came up" from "running but DB not ready".
  if (!isEverythingRunning()) {
    logDebug(
      'error',
      'Everything.exe is NOT running after the start attempt. If it is marked "run as administrator" or blocked by SmartScreen/AV, please start it manually once.',
    );
  } else {
    logDebug(
      'warn',
      `Everything is running but the DB was not ready within ${DB_LOAD_TIMEOUT_MS / 1000}s. First-run indexing or the Everything Service install prompt may be pending — check the Everything window/tray.`,
    );
  }
  return false;
}

/**
 * Throttled, in-flight-safe auto-start. Fired in the background whenever the
 * dll loads but the IPC/DB is not ready (Everything.exe not running yet).
 */
function triggerAutoStart(): void {
  if (autoStartInFlight) return;
  if (Date.now() - lastAutoStartAt < AUTOSTART_THROTTLE_MS) return;
  lastAutoStartAt = Date.now();
  autoStartInFlight = startEverythingAndWait().finally(() => {
    autoStartInFlight = undefined;
  });
}

/**
 * Public, awaitable variant for the debug dialog "start Everything" button.
 */
export async function ensureEverythingRunning(): Promise<{
  success: boolean;
  message: string;
}> {
  if (!loadLibrary()) {
    return { success: false, message: availabilityError || 'dll not found' };
  }
  if (isDbLoaded()) {
    return { success: true, message: 'Everything is already running.' };
  }
  lastAutoStartAt = Date.now();
  const ok = await startEverythingAndWait();
  invalidateProbeCache();
  if (ok) {
    isAvailable = true;
    availabilityCheckedAt = Date.now();
    availabilityError = undefined;
    return { success: true, message: 'Everything started, database loaded.' };
  }
  return {
    success: false,
    message:
      'Everything.exe was launched but the database did not load in time. ' +
      'Check whether Everything is running (tray icon) and that it can index your drives (admin/service).',
  };
}

/**
 * Install Everything via winget (best effort, needs user consent in the UI).
 */
export function installEverything(): Promise<{
  success: boolean;
  output: string;
}> {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    logDebug('info', 'Attempting winget install of voidtools.Everything …');
    exec(
      'winget install --id voidtools.Everything -e --accept-source-agreements --accept-package-agreements --disable-interactivity',
      { windowsHide: true, timeout: 300000 },
      (error: any, stdout: string, stderr: string) => {
        const output = `${stdout || ''}\n${stderr || ''}`.trim();
        if (error) {
          logDebug(
            'error',
            `winget install failed: ${error.message}\n${output}`,
          );
          resolve({
            success: false,
            output:
              `${error.message}\n${output}\n\n` +
              'If winget is unavailable, download the installer manually from https://www.voidtools.com/downloads/',
          });
          return;
        }
        logDebug('info', `winget install finished.\n${output}`);
        // Re-probe dll/exe after installation and try to start Everything
        // right away so the next search just works.
        dllPath = undefined;
        lastExeProbe = undefined;
        invalidateProbeCache();
        lastAutoStartAt = 0;
        if (loadLibrary()) {
          triggerAutoStart();
        }
        resolve({ success: true, output });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Availability check (cached)
// ---------------------------------------------------------------------------

function checkAvailability(): { available: boolean; error?: string } {
  const now = Date.now();
  if (now - availabilityCheckedAt < AVAILABILITY_CACHE_TTL_MS) {
    return { available: isAvailable, error: availabilityError };
  }

  availabilityCheckedAt = now;
  availabilityError = undefined;

  if (!loadLibrary()) {
    isAvailable = false;
    return { available: false, error: availabilityError };
  }

  try {
    const dbLoaded = isDbLoaded();
    if (!dbLoaded) {
      isAvailable = false;
      // Don't cache this state — re-probe on the next call so the search
      // recovers as soon as Everything finishes loading its database.
      availabilityCheckedAt = 0;
      const ipc = probeIpc();
      logDebug(
        'warn',
        `IPC probe: window=${ipc.windowFound} sendMessage=${ipc.sendMessageOk} dbLoaded=${ipc.dbLoaded ?? '-'}${
          ipc.error ? ` (${ipc.error})` : ''
        }`,
      );
      if (!ipc.windowFound) {
        // No EVERYTHING_TASKBAR_NOTIFICATION window in THIS session. A
        // service-only install (-svc) runs headless in session 0 — invisible
        // to IPC here even though tasklist shows a process — so a user-
        // session client must be started before queries can work.
        availabilityError =
          'No Everything client is running in this session (a service-only instance does not answer SDK IPC) — auto-start was triggered.';
        logDebug('warn', availabilityError);
        triggerAutoStart();
      } else if (!ipc.sendMessageOk) {
        // Window exists but messages are dropped: UIPI privilege isolation
        // (Everything elevated, TagSpaces not) or a hung Everything.
        availabilityError =
          'Everything window found but IPC is blocked. If Everything runs as administrator while TagSpaces does not, disable "Run as administrator" for Everything.exe (Everything → Tools → Options → General) or run TagSpaces as administrator.';
        logDebug('warn', availabilityError);
      } else {
        // IPC answers, database genuinely still loading (first index build).
        availabilityError =
          'Everything is reachable but its database is still loading — retry in a moment.';
        logDebug('warn', availabilityError);
      }
      return { available: false, error: availabilityError };
    }

    isAvailable = true;
    return { available: true };
  } catch (err: any) {
    isAvailable = false;
    availabilityError = `Everything availability check failed: ${err.message}`;
    logDebug('error', availabilityError);
    availabilityCheckedAt = 0;
    triggerAutoStart();
    return { available: false, error: availabilityError };
  }
}

// ---------------------------------------------------------------------------
// Serialised search queue
// ---------------------------------------------------------------------------

let queueTail = Promise.resolve<EverythingSearchResponse>({
  available: true,
  results: [],
});

function enqueueSearch(
  query: string,
  options: EverythingSearchOptions = {},
): Promise<EverythingSearchResponse> {
  const task = async (): Promise<EverythingSearchResponse> => {
    const avail = checkAvailability();
    if (!avail.available) {
      return { available: false, results: [], error: avail.error };
    }

    try {
      const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;

      // Build Everything query string
      let everythingQuery = query || '';

      if (options.pathPrefix) {
        // path prefix must end with backslash to match contents
        let prefix = options.pathPrefix;
        if (!prefix.endsWith('\\') && !prefix.endsWith('/')) {
          prefix += '\\';
        }
        everythingQuery += ` path:"${prefix}"`;
      }

      if (options.extensions && options.extensions.length > 0) {
        everythingQuery += ` ext:${options.extensions.join(';')}`;
      }

      if (options.minSize !== undefined || options.maxSize !== undefined) {
        const min = options.minSize ?? 0;
        const max = options.maxSize ?? Number.MAX_SAFE_INTEGER;
        everythingQuery += ` size:${min}-${max}`;
      }

      if (
        options.modifiedAfter !== undefined ||
        options.modifiedBefore !== undefined
      ) {
        const after = options.modifiedAfter
          ? formatLocalDate(new Date(options.modifiedAfter))
          : '';
        const before = options.modifiedBefore
          ? formatLocalDate(new Date(options.modifiedBefore))
          : '';
        everythingQuery += ` dm:${after}-${before}`;
      }

      // Set search parameters
      lastQuery = everythingQuery.trim();
      lastQueryAt = Date.now();
      logDebug('info', `Query: "${lastQuery}" (max ${maxResults})`);
      api.SetSearchW(lastQuery);
      api.SetMax(maxResults);
      api.SetRequestFlags(REQUEST_FLAGS);

      // Execute query (true = block until results ready)
      const success = api.QueryW(1);
      if (!success) {
        const lastErrorCode = api.GetLastError();
        // Error 2 = EVERYTHING_ERROR_IPC: Everything.exe not reachable.
        if (lastErrorCode === 2) {
          triggerAutoStart();
        }
        lastError = `Everything query failed with error ${lastErrorCode}${
          lastErrorCode === 2 ? ' (IPC error — is Everything.exe running?)' : ''
        }`;
        logDebug('error', lastError);
        return {
          available: false,
          results: [],
          error: lastError,
        };
      }

      const numResults = api.GetNumResults();
      const totalResults = api.GetTotResults();
      lastResultCount = numResults;
      lastError = undefined;
      logDebug('info', `Query returned ${numResults}/${totalResults} results.`);

      const results: EverythingResult[] = [];

      for (let i = 0; i < numResults; i++) {
        // --- Get full path ---
        // UTF-16 buffer passed as a typed array; decode via Node's utf16le.
        let buf = new Uint16Array(PATH_BUF_SIZE);
        let written: number = api.GetResultFullPathNameW(i, buf, buf.length);
        // If truncated, expand buffer and retry
        if (written >= buf.length) {
          buf = new Uint16Array(written + 1);
          written = api.GetResultFullPathNameW(i, buf, buf.length);
        }
        const fullPath = Buffer.from(buf.buffer, 0, written * 2)
          .toString('utf16le')
          .replace(/\0.*$/, '');

        // --- Get size ---
        // koffi out('int64') requires a single-element array
        const sizeOut = [0n];
        api.GetResultSize(i, sizeOut);
        const size = sizeOut[0];

        // --- Get modified date ---
        // koffi out(pointer(FILETIME)) requires an empty object
        const ftOut: any = {};
        api.GetResultDateModified(i, ftOut);
        const ft = ftOut as { dwLowDateTime: number; dwHighDateTime: number };

        const isFile = api.IsFileResult(i) !== 0;

        // Convert FILETIME to epoch ms
        const filetime =
          (BigInt(ft.dwHighDateTime) << 32n) | BigInt(ft.dwLowDateTime);
        const epochMs = Number((filetime - 116444736000000000n) / 10000n);

        // Convert backslash to forward slash for TagSpaces
        const normalisedPath = fullPath.replace(/\\/g, '/');

        results.push({
          path: normalisedPath,
          name: path.basename(normalisedPath),
          isFile,
          size: Number(size),
          lmdt: epochMs,
        });
      }

      if (results.length > 0) {
        logDebug(
          'info',
          `First result: path="${results[0].path}" name="${results[0].name}" isFile=${results[0].isFile} size=${results[0].size}`,
        );
      }

      return {
        available: true,
        results,
        totalCount: totalResults,
      };
    } catch (err: any) {
      lastError = `Everything search error: ${err.message}`;
      logDebug('error', lastError);
      return {
        available: false,
        results: [],
        error: lastError,
      };
    }
  };

  queueTail = queueTail.then(task, task); // continue chain even on error
  return queueTail;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isEverythingAvailable(): {
  available: boolean;
  error?: string;
} {
  return checkAvailability();
}

export function searchEverything(
  query: string,
  options?: EverythingSearchOptions,
): Promise<EverythingSearchResponse> {
  return enqueueSearch(query, options);
}

// ---------------------------------------------------------------------------
// Debug info for the renderer debug dialog
// ---------------------------------------------------------------------------

export interface EverythingDebugInfo {
  platform: string;
  dllPath?: string;
  exePath?: string;
  customPath?: string;
  everythingInstalled: boolean;
  everythingRunning: boolean;
  tagspacesElevated: boolean;
  libraryLoaded: boolean;
  dbLoaded: boolean;
  available: boolean;
  availabilityError?: string;
  ipc?: IpcProbeResult;
  autoStartInFlight: boolean;
  lastAutoStartAt?: number;
  lastQuery?: string;
  lastQueryAt?: number;
  lastResultCount?: number;
  lastError?: string;
  log: EverythingDebugEntry[];
}

let lastDllProbeAt = 0;

export function getDebugInfo(): EverythingDebugInfo {
  const probe = getProbeCached();
  // dllPath is cached once found; while missing, re-probe at most once per
  // TTL window instead of on every poll (findDllPath spawns reg.exe).
  if (!dllPath && Date.now() - lastDllProbeAt > PROBE_CACHE_TTL_MS) {
    lastDllProbeAt = Date.now();
    dllPath = findDllPath();
  }
  return {
    platform: process.platform,
    dllPath,
    exePath: probe.exePath,
    customPath: customEverythingPath,
    everythingInstalled: !!probe.exePath,
    everythingRunning: probe.running,
    tagspacesElevated: isSelfElevated(),
    libraryLoaded: !!lib,
    dbLoaded: lib ? isDbLoaded() : false,
    available: isAvailable,
    availabilityError,
    ipc: probeIpc(),
    autoStartInFlight: !!autoStartInFlight,
    lastAutoStartAt: lastAutoStartAt || undefined,
    lastQuery,
    lastQueryAt,
    lastResultCount,
    lastError,
    log: [...debugLog],
  };
}
