/**
 * Todo feature — create / edit form dialog.
 */

import React, { useEffect, useState } from 'react';
import TsButton from '-/components/TsButton';
import TsDialogActions from '-/components/dialogs/components/TsDialogActions';
import TsDialogTitle from '-/components/dialogs/components/TsDialogTitle';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import FormControl from '@mui/material/FormControl';
import Grid from '@mui/material/Grid';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import { useTranslation } from 'react-i18next';
import {
  RecurrenceFrequency,
  TodoCreateInput,
  TodoItem,
  TodoPriority,
  TodoStatus,
  TODO_PRIORITIES,
  TODO_RECURRENCE_FREQUENCIES,
  TODO_STATUSES,
} from './todoTypes';

interface Props {
  open: boolean;
  item: TodoItem | null;
  onClose: () => void;
  onSave: (input: TodoCreateInput) => Promise<void>;
}

function TodoEditDialog({ open, item, onClose, onSave }: Props) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<TodoStatus>('open');
  const [priority, setPriority] = useState<TodoPriority>('medium');
  const [tags, setTags] = useState('');
  const [project, setProject] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [recurrenceFreq, setRecurrenceFreq] = useState<
    RecurrenceFrequency | ''
  >('');
  const [recurrenceInterval, setRecurrenceInterval] = useState<string>('1');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle(item?.title ?? '');
      setDescription(item?.description ?? '');
      setStatus(item?.status ?? 'open');
      setPriority(item?.priority ?? 'medium');
      setTags(item?.tags?.join(', ') ?? '');
      setProject(item?.project ?? '');
      setDueDate(item?.dueDate ?? '');
      setDueTime(item?.dueTime ?? '');
      setRecurrenceFreq(item?.recurrence?.frequency ?? '');
      setRecurrenceInterval(String(item?.recurrence?.interval ?? 1));
      setSaving(false);
    }
  }, [open, item]);

  function handleSave() {
    if (!title.trim()) return;
    setSaving(true);
    const input: TodoCreateInput = {
      title: title.trim(),
      description: description.trim() || undefined,
      status,
      priority,
      tags: tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      project: project.trim() || undefined,
      dueDate: dueDate || undefined,
      dueTime: dueTime || undefined,
      recurrence:
        recurrenceFreq !== ''
          ? {
              frequency: recurrenceFreq,
              interval: Number(recurrenceInterval) || 1,
            }
          : null,
    };
    onSave(input)
      .then(() => setSaving(false))
      .catch(() => setSaving(false));
  }

  const freqLabel = (f: RecurrenceFrequency): string =>
    t(`core:todoRecurrence${f}`);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      keepMounted
      scroll="paper"
      fullWidth
      maxWidth="sm"
    >
      <TsDialogTitle
        dialogTitle={item ? t('core:todoEditTitle') : t('core:todoNewTitle')}
        closeButtonTestId="closeTodoEditTID"
        onClose={onClose}
      />
      <DialogContent>
        <Grid container spacing={2} sx={{ mt: 0 }}>
          <Grid size={12}>
            <TextField
              label={t('core:todoFieldTitle')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              fullWidth
              autoFocus
              required
              data-tid="todoEditTitle"
            />
          </Grid>
          <Grid size={12}>
            <TextField
              label={t('core:todoDescription')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              fullWidth
              multiline
              minRows={2}
            />
          </Grid>
          <Grid size={6}>
            <FormControl fullWidth>
              <InputLabel>{t('core:todoStatus')}</InputLabel>
              <Select
                value={status}
                label={t('core:todoStatus')}
                onChange={(e) => setStatus(e.target.value as TodoStatus)}
              >
                {TODO_STATUSES.map((s) => (
                  <MenuItem key={s} value={s}>
                    {t(
                      `core:todoStatus${s.charAt(0).toUpperCase()}${s.slice(1)}`,
                    )}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>
          <Grid size={6}>
            <FormControl fullWidth>
              <InputLabel>{t('core:todoPriority')}</InputLabel>
              <Select
                value={priority}
                label={t('core:todoPriority')}
                onChange={(e) => setPriority(e.target.value as TodoPriority)}
              >
                {TODO_PRIORITIES.map((p) => (
                  <MenuItem key={p} value={p}>
                    {t(
                      `core:todoPriority${p.charAt(0).toUpperCase()}${p.slice(1)}`,
                    )}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>
          <Grid size={12}>
            <TextField
              label={t('core:todoTags')}
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              fullWidth
              helperText={t('core:todoTagsHint')}
            />
          </Grid>
          <Grid size={6}>
            <TextField
              label={t('core:todoProject')}
              value={project}
              onChange={(e) => setProject(e.target.value)}
              fullWidth
            />
          </Grid>
          <Grid size={6}>
            <TextField
              label={t('core:todoDueDate')}
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              fullWidth
              slotProps={{ inputLabel: { shrink: true } }}
            />
          </Grid>
          <Grid size={6}>
            <TextField
              label={t('core:todoDueTime')}
              type="time"
              value={dueTime}
              onChange={(e) => setDueTime(e.target.value)}
              fullWidth
              slotProps={{ inputLabel: { shrink: true } }}
            />
          </Grid>
          <Grid size={6}>
            <FormControl fullWidth>
              <InputLabel>{t('core:todoRecurrence')}</InputLabel>
              <Select
                value={recurrenceFreq}
                label={t('core:todoRecurrence')}
                onChange={(e) =>
                  setRecurrenceFreq(e.target.value as RecurrenceFrequency | '')
                }
              >
                <MenuItem value="">{t('core:todoRecurrenceNone')}</MenuItem>
                {TODO_RECURRENCE_FREQUENCIES.map((f) => (
                  <MenuItem key={f} value={f}>
                    {freqLabel(f)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>
          {recurrenceFreq !== '' && (
            <Grid size={6}>
              <TextField
                label={t('core:todoRecurrenceInterval')}
                type="number"
                slotProps={{ htmlInput: { min: 1, max: 365 } }}
                value={recurrenceInterval}
                onChange={(e) => setRecurrenceInterval(e.target.value)}
                fullWidth
              />
            </Grid>
          )}
        </Grid>
      </DialogContent>
      <TsDialogActions>
        <Box sx={{ flexGrow: 1 }} />
        <TsButton onClick={onClose}>{t('core:cancel')}</TsButton>
        <TsButton
          variant="contained"
          onClick={handleSave}
          disabled={saving || !title.trim()}
        >
          {t('core:save')}
        </TsButton>
      </TsDialogActions>
    </Dialog>
  );
}

export default TodoEditDialog;
