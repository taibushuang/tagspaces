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
import TsTextField from '-/components/TsTextField';
import DialogCloseButton from '-/components/dialogs/DialogCloseButton';
import SelectedItemsSummary from '-/components/dialogs/components/SelectedItemsSummary';
import TsDialogActions from '-/components/dialogs/components/TsDialogActions';
import { TS } from '-/tagspaces.namespace';
import BulletIcon from '@mui/icons-material/Remove';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import { ChangeEvent, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  open: boolean;
  title: string;
  content?: string;
  customConfirmText?: string;
  customCancelText?: string;
  cancelDialogTID?: string;
  confirmDialogTID?: string;
  confirmDialogContentTID?: string;
  prompt?: string;
  helpText?: string;
  list?: string[];
  entriesList?: TS.FileSystemEntry[];
  /** Optional checkbox above the actions; `checked` is passed to the callback. */
  checkLabel?: string;
  checkDefaultChecked?: boolean;
  confirmCallback: (result: boolean | string, checked?: boolean) => void;
  onClose: () => void;
  /**
   * Called when the dialog is dismissed WITHOUT a button click (Esc / ✕ /
   * backdrop). Defaults to onClose when omitted. Dialog callers that resolve
   * an async operation from confirmCallback (e.g. agent authorization
   * promises) MUST provide this — otherwise the promise hangs forever on
   * dismissal.
   */
  onDismiss?: () => void;
}

function ConfirmDialog(props: Props) {
  const {
    open,
    onClose,
    onDismiss,
    title,
    content,
    confirmCallback,
    prompt,
    helpText,
    customCancelText,
    customConfirmText,
    list,
    entriesList,
    checkLabel,
    checkDefaultChecked,
    confirmDialogContentTID,
    cancelDialogTID,
    confirmDialogTID,
  } = props;
  const { t } = useTranslation();
  const [promptValue, setPromptValue] = useState<string>('');
  const [checked, setChecked] = useState<boolean>(!!checkDefaultChecked);

  // Reset the optional checkbox every time the dialog opens (it stays mounted).
  useEffect(() => {
    if (open) {
      setChecked(!!checkDefaultChecked);
    }
  }, [open, checkDefaultChecked]);

  const onConfirm = useCallback(
    (result: boolean | string) => {
      confirmCallback(result && prompt ? promptValue : result, checked);
      onClose();
    },
    [confirmCallback, prompt, promptValue, checked, onClose],
  );

  const handleToggleChecked = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setChecked(event.target.checked);
    },
    [],
  );

  const handleCancel = useCallback(() => {
    onConfirm(false);
  }, [onConfirm]);

  const handleOk = useCallback(() => {
    onConfirm(true);
  }, [onConfirm]);

  // Esc / ✕ / backdrop: no button was pressed. Route to onDismiss when the
  // caller needs to observe dismissal (else the async caller hangs).
  const handleDismiss = useCallback(() => {
    if (onDismiss) {
      onDismiss();
    } else {
      onClose();
    }
  }, [onDismiss, onClose]);

  return (
    <Dialog
      aria-labelledby="draggable-dialog-title"
      PaperComponent={DraggablePaper}
      open={open}
      onClose={handleDismiss}
      keepMounted
      scroll="paper"
      sx={{ zIndex: 1301 }}
    >
      <DialogTitle sx={{ cursor: 'move' }} id="draggable-dialog-title">
        {title}
        <DialogCloseButton testId="closeConfirmTID" onClose={handleDismiss} />
      </DialogTitle>
      <DialogContent>
        <DialogContentText data-tid={confirmDialogContentTID} component="span">
          {content}
          {prompt && (
            <TsTextField
              fullWidth
              label={helpText}
              value={promptValue}
              focused
              onChange={(e) => setPromptValue(e.target.value)}
              placeholder={prompt}
            />
          )}
          {entriesList && entriesList.length > 0 ? (
            <Box sx={{ marginTop: 1.25 }}>
              <SelectedItemsSummary
                entries={entriesList}
                defaultCollapsed={entriesList.length >= 5}
              />
            </Box>
          ) : (
            list && (
              <List dense>
                {list.map((listItem) => (
                  <ListItem key={listItem.toString()}>
                    <ListItemIcon>
                      <BulletIcon />
                    </ListItemIcon>
                    <ListItemText primary={listItem} />
                  </ListItem>
                ))}
              </List>
            )
          )}
        </DialogContentText>
      </DialogContent>
      {checkLabel && (
        <Box sx={{ paddingX: 3 }}>
          <FormControlLabel
            control={
              <Checkbox
                data-tid="confirmDialogCheckboxTID"
                checked={checked}
                onChange={handleToggleChecked}
              />
            }
            label={checkLabel}
            sx={{
              '& .MuiFormControlLabel-label': {
                fontSize: '0.85rem',
                lineHeight: 1.35,
              },
            }}
          />
        </Box>
      )}
      <TsDialogActions>
        <TsButton onClick={handleCancel} data-tid={cancelDialogTID}>
          {customCancelText || t('core:no')}
        </TsButton>
        <TsButton data-tid={confirmDialogTID} onClick={handleOk}>
          {customConfirmText || t('core:yes')}
        </TsButton>
      </TsDialogActions>
    </Dialog>
  );
}

ConfirmDialog.defaultProps = {
  content: '',
  customConfirmText: undefined,
  customCancelText: undefined,
  cancelDialogTID: 'confirmDialogCancelButton',
  confirmDialogTID: 'confirmDialogOkButton',
  confirmDialogContentTID: 'confirmDialogContentTID',
  list: [],
  prompt: undefined,
  helpText: undefined,
  entriesList: undefined,
  checkLabel: undefined,
  checkDefaultChecked: false,
  onDismiss: undefined,
};

export default ConfirmDialog;
