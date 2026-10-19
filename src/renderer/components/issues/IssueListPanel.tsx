/**
 * Issue collection feature (需求与缺陷收集) — inline panel that replaces the
 * file-content area while open ("挤占式", mirrors TodoListPanel). The list
 * collects pending feature requests and bugs, reported either from this panel
 * or by the AI Agent via the report_issue tool. Edit form and delete
 * confirmation stay as dialogs on top.
 */

import React, { useMemo, useState } from 'react';
import TsButton from '-/components/TsButton';
import ConfirmDialog from '-/components/dialogs/ConfirmDialog';
import AddCircleOutlineOutlinedIcon from '@mui/icons-material/AddCircleOutlineOutlined';
import BugReportOutlinedIcon from '@mui/icons-material/BugReportOutlined';
import CloseIcon from '@mui/icons-material/Close';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import DoneAllOutlinedIcon from '@mui/icons-material/DoneAllOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import LightbulbOutlinedIcon from '@mui/icons-material/LightbulbOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import UndoOutlinedIcon from '@mui/icons-material/UndoOutlined';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import ListItem from '@mui/material/ListItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import List from '@mui/material/List';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import {
  buildIssueRefs,
  filterIssues,
  IssueCreateInput,
  IssueItem,
  IssueSeverity,
  IssueStatusFilter,
  IssueTypeFilter,
  IssueUpdateManyResult,
} from './issueTypes';
import IssueEditDialog from './IssueEditDialog';

interface Props {
  items: IssueItem[];
  stats: { total: number; open: number; done: number };
  loading: boolean;
  error: string | null;
  dataPath: string;
  appInfo: { version: string; platform: string };
  createIssue: (input: IssueCreateInput) => Promise<IssueItem>;
  updateIssue: (id: string, patch: Partial<IssueItem>) => Promise<IssueItem>;
  updateManyIssues: (
    ids: string[],
    status: 'open' | 'done',
  ) => Promise<IssueUpdateManyResult>;
  removeIssue: (id: string) => Promise<number>;
  exportMarkdown: () => void;
  /** Notification sink injected from RenderPerspective (panel stays prop-pure). */
  showNotification?: (
    text: string,
    notificationType?: 'default' | 'info' | 'warning' | 'error',
  ) => void;
  onClose: () => void;
}

function severityColor(severity: IssueSeverity) {
  if (severity === 'high') return 'error';
  if (severity === 'low') return 'default';
  return 'warning';
}

function IssueListPanel({
  items,
  stats,
  loading,
  error,
  dataPath,
  appInfo,
  createIssue,
  updateIssue,
  updateManyIssues,
  removeIssue,
  exportMarkdown,
  showNotification,
  onClose,
}: Props) {
  const { t } = useTranslation();

  const [typeFilter, setTypeFilter] = useState<IssueTypeFilter>('all');
  const [statusFilter, setStatusFilter] = useState<IssueStatusFilter>('all');
  const [keyword, setKeyword] = useState('');
  const [editing, setEditing] = useState<{
    open: boolean;
    item: IssueItem | null;
  }>({ open: false, item: null });
  const [deleteTarget, setDeleteTarget] = useState<IssueItem | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const visible = useMemo(
    () =>
      filterIssues(items, { type: typeFilter, status: statusFilter, keyword }),
    [items, typeFilter, statusFilter, keyword],
  );

  // Reference ids ([TAG-]BUG-001) matching the export document numbering.
  const refs = useMemo(() => buildIssueRefs(items), [items]);

  async function handleSave(input: IssueCreateInput) {
    if (editing.item) {
      await updateIssue(editing.item.id, input);
    } else {
      await createIssue({ ...input, source: 'ui' });
    }
    setEditing({ open: false, item: null });
  }

  function toggleDone(item: IssueItem) {
    updateIssue(item.id, {
      status: item.status === 'done' ? 'open' : 'done',
    });
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function markSelected(status: 'open' | 'done') {
    const result = await updateManyIssues([...selectedIds], status);
    setSelectedIds(new Set());
    if (result.missing.length > 0) {
      showNotification?.(
        t('core:issueBatchResult', { updated: result.updated }) +
          ' · ' +
          t('core:issueBatchMissing', { missing: result.missing.length }),
        'warning',
      );
    } else {
      showNotification?.(
        t('core:issueBatchResult', { updated: result.updated }),
        'info',
      );
    }
  }

  function handleDeleteConfirm(result: boolean | string) {
    if (deleteTarget && result === true) {
      removeIssue(deleteTarget.id);
    }
    setDeleteTarget(null);
  }

  const typeTabs: IssueTypeFilter[] = ['all', 'bug', 'feature'];
  const statusTabs: IssueStatusFilter[] = ['all', 'open', 'done'];
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  function renderBody() {
    if (error) {
      return (
        <Typography variant="body2" color="error">
          {error}
        </Typography>
      );
    }
    if (loading && items.length === 0) {
      return (
        <Typography variant="body2" color="text.secondary">
          {t('core:issueLoading')}
        </Typography>
      );
    }
    if (items.length === 0) {
      return (
        <Box>
          <Typography variant="body2" color="text.secondary">
            {t('core:issueEmpty')}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {t('core:issueEmptyAgentHint')}
          </Typography>
        </Box>
      );
    }
    if (visible.length === 0) {
      return (
        <Typography variant="body2" color="text.secondary">
          {t('core:issueNoMatch')}
        </Typography>
      );
    }
    return (
      <List dense>
        {visible.map((item) => (
          <ListItem
            key={item.id}
            data-tid={`issueItem-${item.id}`}
            secondaryAction={
              <Box sx={{ display: 'flex', gap: 0.5 }}>
                <Tooltip title={t('core:issueMarkDone')}>
                  <IconButton
                    size="small"
                    onClick={() => toggleDone(item)}
                    data-tid="issueToggleDone"
                  >
                    {item.status === 'done' ? (
                      <UndoOutlinedIcon fontSize="small" />
                    ) : (
                      <DoneAllOutlinedIcon fontSize="small" />
                    )}
                  </IconButton>
                </Tooltip>
                <Tooltip title={t('core:issueEdit')}>
                  <IconButton
                    size="small"
                    onClick={() => setEditing({ open: true, item })}
                    data-tid="issueEditButton"
                  >
                    <EditOutlinedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title={t('core:issueDelete')}>
                  <IconButton
                    size="small"
                    onClick={() => setDeleteTarget(item)}
                    data-tid="issueDeleteButton"
                  >
                    <DeleteOutlineOutlinedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
            }
          >
            <ListItemIcon>
              <Checkbox
                size="small"
                sx={{ p: 0.25, mr: 0.5 }}
                checked={selectedIds.has(item.id)}
                onChange={() => toggleSelected(item.id)}
                data-tid="issueSelectCheckbox"
              />
              {item.type === 'bug' ? (
                <BugReportOutlinedIcon fontSize="small" color="error" />
              ) : (
                <LightbulbOutlinedIcon fontSize="small" color="primary" />
              )}
            </ListItemIcon>
            <ListItemText
              primary={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography
                    variant="caption"
                    component="span"
                    sx={{
                      fontFamily: 'monospace',
                      color: 'text.disabled',
                      flexShrink: 0,
                    }}
                  >
                    {refs.get(item.id)}
                  </Typography>
                  <Typography
                    variant="body2"
                    component="span"
                    sx={{
                      textDecoration:
                        item.status === 'done' ? 'line-through' : 'none',
                      color:
                        item.status === 'done' ? 'text.secondary' : 'inherit',
                    }}
                  >
                    {item.title}
                  </Typography>
                  {item.type === 'bug' ? (
                    <Chip
                      size="small"
                      label={t(`core:issueSeverity${cap(item.severity)}`)}
                      color={severityColor(item.severity) as any}
                      variant="outlined"
                    />
                  ) : null}
                  <Chip
                    size="small"
                    label={
                      item.source === 'agent'
                        ? t('core:issueSourceAgent')
                        : t('core:issueSourceUi')
                    }
                    variant="outlined"
                  />
                </Box>
              }
              secondary={
                <>
                  {item.description && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      component="div"
                      sx={{
                        whiteSpace: 'pre-wrap',
                        display: '-webkit-box',
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                    >
                      {item.description}
                    </Typography>
                  )}
                  <Tooltip
                    title={
                      <Box>
                        {[
                          item.context?.appVersion &&
                            `App: v${item.context.appVersion}`,
                          item.context?.platform &&
                            `Platform: ${item.context.platform}`,
                          item.context?.osVersion &&
                            `OS: ${item.context.osVersion}`,
                          item.context?.appLanguage &&
                            `Language: ${item.context.appLanguage}`,
                          item.context?.locationPath &&
                            `Location: ${item.context.locationPath}`,
                          item.context?.folderPath &&
                            `Folder: ${item.context.folderPath}`,
                          item.context?.selectedEntries?.length &&
                            `Selected/related (${item.context.selectedEntries.length}):\n${item.context.selectedEntries.join('\n')}`,
                          item.context?.lastToolError &&
                            `Last tool error: ${item.context.lastToolError.tool}(${item.context.lastToolError.args || ''}) → ${item.context.lastToolError.error}`,
                        ]
                          .filter(Boolean)
                          .map((line: any) => (
                            <Typography
                              key={String(line).slice(0, 32)}
                              variant="caption"
                              component="div"
                              sx={{ whiteSpace: 'pre-wrap' }}
                            >
                              {line}
                            </Typography>
                          ))}
                      </Box>
                    }
                  >
                    <Typography variant="caption" color="text.disabled">
                      {[
                        item.context?.appVersion &&
                          `v${item.context.appVersion}`,
                        item.context?.locationName || item.context?.folderPath,
                        item.context?.selectedEntries?.length &&
                          `${item.context.selectedEntries.length} files`,
                        item.context?.lastToolError && '⚠ tool error',
                        item.createdAt.slice(0, 10),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Typography>
                  </Tooltip>
                </>
              }
            />
          </ListItem>
        ))}
      </List>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
        px: 2,
        pt: 1,
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          mb: 1,
          flexWrap: 'wrap',
        }}
      >
        <Typography variant="h6">{t('core:issueTitle')}</Typography>
        <Typography variant="body2" color="text.secondary">
          {t('core:issueSummary', {
            open: stats.open,
            total: stats.total,
          })}
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title={dataPath}>
          <Typography variant="caption" color="text.secondary" noWrap>
            {dataPath}
          </Typography>
        </Tooltip>
        <TsButton
          startIcon={<DownloadOutlinedIcon />}
          size="small"
          onClick={() => exportMarkdown()}
          data-tid="issueExportMarkdown"
        >
          {t('core:issueExport')}
        </TsButton>
        <Tooltip title={t('core:issueClose')}>
          <IconButton size="small" onClick={onClose} data-tid="issueClosePanel">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          mb: 1,
          flexWrap: 'wrap',
        }}
      >
        <Tabs
          value={typeTabs.indexOf(typeFilter)}
          onChange={(_e, v: number) => setTypeFilter(typeTabs[v])}
          variant="scrollable"
          scrollButtons="auto"
        >
          {typeTabs.map((s) => (
            <Tab
              key={s}
              label={t(`core:issueTypeFilter${cap(s)}`)}
              data-tid={`issueTypeFilter-${s}`}
            />
          ))}
        </Tabs>
        <Tabs
          value={statusTabs.indexOf(statusFilter)}
          onChange={(_e, v: number) => setStatusFilter(statusTabs[v])}
          variant="scrollable"
          scrollButtons="auto"
        >
          {statusTabs.map((s) => (
            <Tab
              key={s}
              label={t(`core:issueStatusFilter${cap(s)}`)}
              data-tid={`issueStatusFilter-${s}`}
            />
          ))}
        </Tabs>
        <Box sx={{ flexGrow: 1 }} />
        <TextField
          placeholder={t('core:issueSearchPlaceholder')}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          size="small"
          sx={{ minWidth: 180 }}
          data-tid="issueSearch"
        />
      </Box>

      <Divider />

      {selectedIds.size > 0 && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            py: 0.5,
            flexWrap: 'wrap',
          }}
          data-tid="issueBatchBar"
        >
          <Typography variant="body2" color="text.secondary">
            {t('core:issueSelectedCount', { count: selectedIds.size })}
          </Typography>
          <TsButton
            size="small"
            variant="contained"
            startIcon={<DoneAllOutlinedIcon />}
            onClick={() => markSelected('done')}
            data-tid="issueBatchMarkDone"
          >
            {t('core:issueBatchMarkDone')}
          </TsButton>
          <TsButton
            size="small"
            startIcon={<UndoOutlinedIcon />}
            onClick={() => markSelected('open')}
            data-tid="issueBatchMarkOpen"
          >
            {t('core:issueBatchMarkOpen')}
          </TsButton>
          <TsButton size="small" onClick={() => setSelectedIds(new Set())}>
            {t('core:issueBatchClear')}
          </TsButton>
        </Box>
      )}

      <Box sx={{ flexGrow: 1, overflowY: 'auto', py: 1 }}>{renderBody()}</Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          py: 1,
          borderTop: 1,
          borderColor: 'divider',
        }}
      >
        <Typography variant="caption" color="text.disabled">
          {appInfo.version
            ? `TagSpaces v${appInfo.version} · ${appInfo.platform}`
            : ''}
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        <TsButton
          variant="contained"
          startIcon={<AddCircleOutlineOutlinedIcon />}
          onClick={() => setEditing({ open: true, item: null })}
          data-tid="issueNewButton"
        >
          {t('core:issueNew')}
        </TsButton>
      </Box>

      <IssueEditDialog
        open={editing.open}
        item={editing.item}
        onClose={() => setEditing({ open: false, item: null })}
        onSave={handleSave}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        title={t('core:issueDeleteConfirmTitle')}
        content={deleteTarget?.title || ''}
        confirmCallback={handleDeleteConfirm}
        onClose={() => setDeleteTarget(null)}
      />
    </Box>
  );
}

export default IssueListPanel;
