/**
 * Issue collection feature — create / edit form dialog.
 */

import React, { useEffect, useState } from 'react';
import TsButton from '-/components/TsButton';
import TsDialogActions from '-/components/dialogs/components/TsDialogActions';
import TsDialogTitle from '-/components/dialogs/components/TsDialogTitle';
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
  IssueCreateInput,
  IssueItem,
  IssueSeverity,
  ISSUE_SEVERITIES,
  ISSUE_TYPES,
  IssueType,
} from './issueTypes';

interface Props {
  open: boolean;
  item: IssueItem | null;
  onClose: () => void;
  onSave: (input: IssueCreateInput) => Promise<void>;
}

function IssueEditDialog({ open, item, onClose, onSave }: Props) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<IssueType>('bug');
  const [severity, setSeverity] = useState<IssueSeverity>('medium');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle(item?.title ?? '');
      setDescription(item?.description ?? '');
      setType(item?.type ?? 'bug');
      setSeverity(item?.severity ?? 'medium');
      setSaving(false);
    }
  }, [open, item]);

  function handleSave() {
    if (!title.trim()) return;
    setSaving(true);
    const input: IssueCreateInput = {
      title: title.trim(),
      description: description.trim() || undefined,
      type,
      severity,
      ...(item ? { status: item.status } : {}),
    };
    onSave(input)
      .then(() => setSaving(false))
      .catch(() => setSaving(false));
  }

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
        dialogTitle={item ? t('core:issueEditTitle') : t('core:issueNewTitle')}
        closeButtonTestId="closeIssueEditTID"
        onClose={onClose}
      />
      <DialogContent>
        <Grid container spacing={2} sx={{ mt: 0 }}>
          <Grid size={12}>
            <TextField
              label={t('core:issueFieldTitle')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              fullWidth
              autoFocus
              required
              data-tid="issueEditTitle"
            />
          </Grid>
          <Grid size={6}>
            <FormControl fullWidth>
              <InputLabel>{t('core:issueType')}</InputLabel>
              <Select
                value={type}
                label={t('core:issueType')}
                onChange={(e) => setType(e.target.value as IssueType)}
              >
                {ISSUE_TYPES.map((v) => (
                  <MenuItem key={v} value={v}>
                    {t(
                      `core:issueType${v.charAt(0).toUpperCase()}${v.slice(1)}`,
                    )}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>
          <Grid size={6}>
            <FormControl fullWidth>
              <InputLabel>{t('core:issueSeverity')}</InputLabel>
              <Select
                value={severity}
                label={t('core:issueSeverity')}
                onChange={(e) => setSeverity(e.target.value as IssueSeverity)}
              >
                {ISSUE_SEVERITIES.map((v) => (
                  <MenuItem key={v} value={v}>
                    {t(
                      `core:issueSeverity${v.charAt(0).toUpperCase()}${v.slice(1)}`,
                    )}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>
          <Grid size={12}>
            <TextField
              label={t('core:issueDescription')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              fullWidth
              multiline
              minRows={4}
              placeholder={t('core:issueDescriptionPlaceholder')}
            />
          </Grid>
        </Grid>
      </DialogContent>
      <TsDialogActions>
        <TsButton onClick={onClose}>{t('core:cancel')}</TsButton>
        <TsButton
          data-tid="issueEditSaveTID"
          disabled={!title.trim() || saving}
          onClick={handleSave}
        >
          {t('core:save')}
        </TsButton>
      </TsDialogActions>
    </Dialog>
  );
}

export default IssueEditDialog;
