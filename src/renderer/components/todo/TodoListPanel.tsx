/**
 * Todo feature — inline panel that replaces the file-content area while open
 * ("挤占式": the middle content region becomes the todo list). Edit form and
 * delete confirmation stay as dialogs on top.
 */

import React, { useMemo, useState } from 'react';
import TsButton from '-/components/TsButton';
import ConfirmDialog from '-/components/dialogs/ConfirmDialog';
import AddCircleOutlineOutlinedIcon from '@mui/icons-material/AddCircleOutlineOutlined';
import CloseIcon from '@mui/icons-material/Close';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import IconButton from '@mui/material/IconButton';
import InputLabel from '@mui/material/InputLabel';
import List from '@mui/material/List';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import {
  TodoCreateInput,
  TodoItem,
  TodoSortKey,
  TodoStats,
  TodoStatusFilter,
  TodoUpdateInput,
} from './todoTypes';
import { filterTodos, sortTodos } from './todoUtils';
import TodoEditDialog from './TodoEditDialog';
import TodoItemView from './TodoItem';

interface Props {
  items: TodoItem[];
  stats: TodoStats;
  loading: boolean;
  error: string | null;
  dataPath: string;
  createTodo: (input: TodoCreateInput) => Promise<TodoItem>;
  updateTodo: (id: string, patch: TodoUpdateInput) => Promise<TodoItem>;
  removeTodo: (id: string) => Promise<number>;
  exportMarkdown: (includeDone: boolean) => void;
  onClose: () => void;
}

function TodoListPanel({
  items,
  stats,
  loading,
  error,
  dataPath,
  createTodo,
  updateTodo,
  removeTodo,
  exportMarkdown,
  onClose,
}: Props) {
  const { t } = useTranslation();

  const [statusFilter, setStatusFilter] = useState<TodoStatusFilter>('all');
  const [keyword, setKeyword] = useState('');
  const [sort, setSort] = useState<TodoSortKey>('manual');
  const [editing, setEditing] = useState<{
    open: boolean;
    item: TodoItem | null;
  }>({ open: false, item: null });
  const [deleteTarget, setDeleteTarget] = useState<TodoItem | null>(null);

  const visible = useMemo(() => {
    const filtered = filterTodos(items, { status: statusFilter, keyword });
    return sortTodos(filtered, sort);
  }, [items, statusFilter, keyword, sort]);

  const tabs: TodoStatusFilter[] = ['all', 'open', 'doing', 'done'];

  async function handleSave(input: TodoCreateInput) {
    if (editing.item) {
      await updateTodo(editing.item.id, input);
    } else {
      await createTodo(input);
    }
    setEditing({ open: false, item: null });
  }

  function toggleDone(item: TodoItem) {
    updateTodo(item.id, { status: item.status === 'done' ? 'open' : 'done' });
  }

  function markDoing(item: TodoItem) {
    updateTodo(item.id, { status: 'doing' });
  }

  function handleDeleteConfirm(result: boolean | string) {
    if (deleteTarget && result === true) {
      removeTodo(deleteTarget.id);
    }
    setDeleteTarget(null);
  }

  function renderBody() {
    if (error) {
      return (
        <Typography variant="body2" color="error">
          {error}
        </Typography>
      );
    }
    if (loading && visible.length === 0) {
      return (
        <Typography variant="body2" color="text.secondary">
          {t('core:todoLoading')}
        </Typography>
      );
    }
    if (items.length === 0) {
      return (
        <Typography variant="body2" color="text.secondary">
          {t('core:todoEmpty')}
        </Typography>
      );
    }
    if (visible.length === 0) {
      return (
        <Typography variant="body2" color="text.secondary">
          {t('core:todoNoMatch')}
        </Typography>
      );
    }
    return (
      <List dense>
        {visible.map((item) => (
          <TodoItemView
            key={item.id}
            item={item}
            onToggleDone={toggleDone}
            onMarkDoing={markDoing}
            onEdit={(i) => setEditing({ open: true, item: i })}
            onDelete={setDeleteTarget}
          />
        ))}
      </List>
    );
  }

  const statusLabel = (s: TodoStatusFilter): string =>
    s === 'all'
      ? t('core:todoFilterAll')
      : t(`core:todoStatus${s.charAt(0).toUpperCase()}${s.slice(1)}`);

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
        <Typography variant="h6">{t('core:todoTitle')}</Typography>
        <Typography variant="body2" color="text.secondary">
          {t('core:todoSummary', {
            pending: stats.open + stats.doing,
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
          onClick={() => exportMarkdown(false)}
          data-tid="todoExportMarkdown"
        >
          {t('core:todoExport')}
        </TsButton>
        <Tooltip title={t('core:todoClose')}>
          <IconButton size="small" onClick={onClose} data-tid="todoClosePanel">
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
          value={tabs.indexOf(statusFilter)}
          onChange={(_e, v: number) => setStatusFilter(tabs[v])}
          variant="scrollable"
          scrollButtons="auto"
        >
          {tabs.map((s) => (
            <Tab key={s} label={statusLabel(s)} data-tid={`todoFilter-${s}`} />
          ))}
        </Tabs>
        <Box sx={{ flexGrow: 1 }} />
        <TextField
          placeholder={t('core:todoSearchPlaceholder')}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          size="small"
          sx={{ minWidth: 180 }}
          data-tid="todoSearch"
        />
        <FormControl size="small" sx={{ minWidth: 140 }}>
          <InputLabel>{t('core:todoSort')}</InputLabel>
          <Select
            value={sort}
            label={t('core:todoSort')}
            onChange={(e) => setSort(e.target.value as TodoSortKey)}
          >
            {(
              [
                'manual',
                'priority',
                'dueDate',
                'createdAt',
                'updatedAt',
              ] as TodoSortKey[]
            ).map((k) => (
              <MenuItem key={k} value={k}>
                {t(`core:todoSort${k.charAt(0).toUpperCase()}${k.slice(1)}`)}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>

      <Divider />

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
        <Box sx={{ flexGrow: 1 }} />
        <TsButton
          variant="contained"
          startIcon={<AddCircleOutlineOutlinedIcon />}
          onClick={() => setEditing({ open: true, item: null })}
          data-tid="todoNewButton"
        >
          {t('core:todoNew')}
        </TsButton>
      </Box>

      <TodoEditDialog
        open={editing.open}
        item={editing.item}
        onClose={() => setEditing({ open: false, item: null })}
        onSave={handleSave}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        title={t('core:todoDeleteConfirmTitle')}
        content={deleteTarget ? deleteTarget.title : undefined}
        confirmCallback={handleDeleteConfirm}
        onClose={() => setDeleteTarget(null)}
      />
    </Box>
  );
}

export default TodoListPanel;
