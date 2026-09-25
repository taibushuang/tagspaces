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

import DraggablePaper from '-/components/DraggablePaper';
import TsButton from '-/components/TsButton';
import TsDialogActions from '-/components/dialogs/components/TsDialogActions';
import TsDialogTitle from '-/components/dialogs/components/TsDialogTitle';
import {
  actions as SettingsActions,
  getEverythingPath,
} from '-/reducers/settings';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface DebugEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

interface DebugInfo {
  platform: string;
  esPath?: string;
  exePath?: string;
  customPath?: string;
  everythingInstalled: boolean;
  everythingRunning: boolean;
  tagspacesElevated: boolean;
  libraryLoaded: boolean;
  dbLoaded: boolean;
  available: boolean;
  availabilityError?: string;
  ipc?: {
    windowFound: boolean;
    sendMessageOk: boolean;
    dbLoaded?: boolean;
    error?: string;
  };
  autoStartInFlight: boolean;
  lastAutoStartAt?: number;
  lastQuery?: string;
  lastQueryAt?: number;
  lastResultCount?: number;
  lastError?: string;
  log: DebugEntry[];
}

const POLL_INTERVAL_MS = 1000;

// The global minireset.css applies user-select:none to EVERY element via
// :not(input):not(textarea) (specificity 0,0,2). Setting user-select on a
// container does NOT propagate, because each descendant has its own direct
// declaration. The '& *' subtree override (specificity 0,1,1 > 0,0,2)
// re-enables selection for the whole dialog content. Buttons are excluded
// so they keep their pointer cursor.
const selectableSx = {
  userSelect: 'text',
  '& *:not(.MuiButtonBase-root)': {
    userSelect: 'text',
    cursor: 'text',
  },
} as const;

function StatusChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Chip
      label={label}
      color={ok ? 'success' : 'error'}
      size="small"
      variant={ok ? 'filled' : 'outlined'}
      sx={{ mr: 1, mb: 1 }}
    />
  );
}

function formatTime(ts?: number): string {
  return ts ? new Date(ts).toLocaleTimeString() : '-';
}

function EverythingDebugDialog(props: Props) {
  const { open, onClose } = props;
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const savedEverythingPath = useSelector(getEverythingPath);

  const [info, setInfo] = useState<DebugInfo | undefined>(undefined);
  const [testQuery, setTestQuery] = useState<string>('');
  const [testResult, setTestResult] = useState<string>('');
  const [actionOutput, setActionOutput] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [customPath, setCustomPath] = useState<string>(
    savedEverythingPath || '',
  );
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;

    const poll = async () => {
      try {
        const result: DebugInfo = await window.electronIO.ipcRenderer.invoke(
          'getEverythingDebugInfo',
        );
        if (!cancelled) setInfo(result);
      } catch (err: any) {
        if (!cancelled) {
          setActionOutput(`getEverythingDebugInfo failed: ${err.message}`);
        }
      }
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [open]);

  // Auto-scroll the log to the bottom on new entries
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [info?.log?.length]);

  function saveCustomPath() {
    const value = customPath.trim();
    dispatch(SettingsActions.setEverythingPath(value || undefined));
    setActionOutput(t('core:everythingDebugPathSaved'));
    // Push the new path to the main process immediately via a probe search
    window.electronIO.ipcRenderer.invoke('searchEverything', '', {
      maxResults: 1,
      everythingPath: value || undefined,
    });
  }

  async function runTestSearch() {
    setBusy(true);
    setTestResult('');
    try {
      const response = await window.electronIO.ipcRenderer.invoke(
        'searchEverything',
        testQuery,
        {
          maxResults: 10,
          everythingPath: savedEverythingPath || undefined,
        },
      );
      if (!response.available) {
        setTestResult(
          `${t('core:everythingDebugUnavailable')}: ${response.error}`,
        );
      } else {
        const paths = response.results
          .slice(0, 10)
          .map((r: any) => r.path)
          .join('\n');
        setTestResult(
          `${t('core:everythingDebugTestSummary', {
            shown: response.results.length,
            total: response.totalCount ?? response.results.length,
          })}${paths ? `\n${paths}` : ''}`,
        );
      }
    } catch (err: any) {
      setTestResult(`IPC error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function startEverything() {
    setBusy(true);
    setActionOutput('');
    try {
      const result = await window.electronIO.ipcRenderer.invoke(
        'everythingEnsureRunning',
      );
      setActionOutput(
        (result.success ? 'OK: ' : `${t('core:failed')}: `) + result.message,
      );
    } catch (err: any) {
      setActionOutput(`IPC error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function installEverything() {
    if (!window.confirm(t('core:everythingDebugInstallConfirm'))) {
      return;
    }
    setBusy(true);
    setActionOutput(t('core:everythingDebugInstalling'));
    try {
      const result =
        await window.electronIO.ipcRenderer.invoke('installEverything');
      setActionOutput(
        (result.success ? 'OK\n' : `${t('core:failed')}\n`) + result.output,
      );
    } catch (err: any) {
      setActionOutput(`IPC error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  const row = (label: string, value: ReactNode) => (
    <Box sx={{ display: 'flex', mb: 0.5 }} key={label}>
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ minWidth: 180, flexShrink: 0 }}
      >
        {label}
      </Typography>
      <Typography
        variant="body2"
        sx={{ wordBreak: 'break-all', ...selectableSx }}
      >
        {value}
      </Typography>
    </Box>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      keepMounted
      scroll="paper"
      PaperComponent={DraggablePaper}
      fullWidth
      maxWidth="md"
    >
      <TsDialogTitle
        dialogTitle={t('core:everythingDebugTitle')}
        closeButtonTestId="closeEverythingDebugTID"
        onClose={onClose}
      />
      <DialogContent
        sx={{ overflowX: 'hidden', overflowY: 'auto', ...selectableSx }}
      >
        {info ? (
          <>
            <Box sx={{ mb: 1 }}>
              <StatusChip
                ok={info.available}
                label={
                  info.available
                    ? t('core:everythingDebugAvailable')
                    : t('core:everythingDebugUnavailable')
                }
              />
              <StatusChip
                ok={info.everythingInstalled}
                label={t('core:everythingDebugInstalled')}
              />
              <StatusChip
                ok={info.everythingRunning}
                label={t('core:everythingDebugRunning')}
              />
              <StatusChip
                ok={info.libraryLoaded}
                label={t('core:everythingDebugDllLoaded')}
              />
              <StatusChip
                ok={info.dbLoaded}
                label={t('core:everythingDebugDbLoaded')}
              />
              {info.everythingRunning &&
                !info.dbLoaded &&
                !info.tagspacesElevated && (
                  <Chip
                    label={t('core:everythingDebugUipiSuspect')}
                    color="warning"
                    size="small"
                    sx={{ mr: 1, mb: 1 }}
                  />
                )}
              {info.autoStartInFlight && (
                <Chip
                  label={t('core:everythingDebugAutoStarting')}
                  color="warning"
                  size="small"
                  sx={{ mr: 1, mb: 1 }}
                />
              )}
            </Box>
            {row('platform', info.platform)}
            {row(
              t('core:everythingDebugElevated'),
              info.tagspacesElevated ? '✓' : '✗',
            )}
            {row(
              t('core:everythingDebugIpc'),
              info.ipc
                ? `window=${info.ipc.windowFound ? '✓' : '✗'} message=${
                    info.ipc.sendMessageOk ? '✓' : '✗'
                  } db=${
                    info.ipc.dbLoaded === undefined
                      ? '-'
                      : info.ipc.dbLoaded
                        ? '✓'
                        : '✗'
                  }${info.ipc.error ? ` — ${info.ipc.error}` : ''}`
                : '-',
            )}
            {row('Everything.exe', info.exePath || '-')}
            {row('es.exe', info.esPath || '-')}
            {row(t('core:everythingDebugCustomPath'), info.customPath || '-')}
            {row(
              t('core:everythingDebugLastError'),
              info.availabilityError || info.lastError || '-',
            )}
            {row(
              t('core:everythingDebugLastQuery'),
              info.lastQuery
                ? `"${info.lastQuery}" @ ${formatTime(info.lastQueryAt)} → ${
                    info.lastResultCount ?? '?'
                  } ${t('core:entries')}`
                : '-',
            )}
          </>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {t('core:loading')}…
          </Typography>
        )}

        {/* Custom Everything location */}
        <Box sx={{ display: 'flex', gap: 1, mt: 2, alignItems: 'center' }}>
          <TextField
            size="small"
            fullWidth
            label={t('core:everythingDebugCustomPath')}
            placeholder={t('core:everythingDebugCustomPathHint')}
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
          />
          <TsButton
            data-tid="everythingDebugSavePathTID"
            disabled={busy}
            onClick={saveCustomPath}
          >
            {t('core:save')}
          </TsButton>
        </Box>

        {/* Test search */}
        <Box sx={{ display: 'flex', gap: 1, mt: 2, alignItems: 'center' }}>
          <TextField
            size="small"
            fullWidth
            label={t('core:everythingDebugTestQuery')}
            value={testQuery}
            onChange={(e) => setTestQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) runTestSearch();
            }}
          />
          <TsButton
            data-tid="everythingDebugTestSearchTID"
            disabled={busy}
            onClick={runTestSearch}
          >
            {t('core:everythingDebugRunTest')}
          </TsButton>
        </Box>
        {testResult && (
          <Box
            component="pre"
            sx={{
              mt: 1,
              p: 1,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              backgroundColor: 'action.hover',
              borderRadius: 1,
              maxHeight: 140,
              overflowY: 'auto',
              ...selectableSx,
            }}
          >
            {testResult}
          </Box>
        )}

        {/* Action output */}
        {actionOutput && (
          <Box
            component="pre"
            sx={{
              mt: 1,
              p: 1,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              backgroundColor: 'action.hover',
              borderRadius: 1,
              maxHeight: 140,
              overflowY: 'auto',
              ...selectableSx,
            }}
          >
            {actionOutput}
          </Box>
        )}

        {/* Live debug log */}
        <Typography variant="subtitle2" sx={{ mt: 2 }}>
          {t('core:everythingDebugLog')}
        </Typography>
        <Box
          ref={logRef}
          component="pre"
          data-tid="everythingDebugLogTID"
          sx={{
            mt: 0.5,
            p: 1,
            fontSize: 11,
            lineHeight: 1.5,
            backgroundColor: 'action.hover',
            borderRadius: 1,
            height: 200,
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            ...selectableSx,
          }}
        >
          {info && info.log.length > 0
            ? info.log
                .map(
                  (e) =>
                    `${new Date(e.ts).toLocaleTimeString()} [${e.level}] ${
                      e.message
                    }`,
                )
                .join('\n')
            : t('core:everythingDebugLogEmpty')}
        </Box>
      </DialogContent>
      <TsDialogActions>
        <TsButton
          data-tid="everythingDebugStartTID"
          disabled={busy || info?.platform !== 'win32'}
          onClick={startEverything}
        >
          {t('core:everythingDebugStart')}
        </TsButton>
        <TsButton
          data-tid="everythingDebugInstallTID"
          disabled={busy || info?.platform !== 'win32'}
          onClick={installEverything}
        >
          {t('core:everythingDebugInstall')}
        </TsButton>
        <TsButton data-tid="closeEverythingDebug2TID" onClick={onClose}>
          {t('core:closeButton')}
        </TsButton>
      </TsDialogActions>
    </Dialog>
  );
}

export default EverythingDebugDialog;
