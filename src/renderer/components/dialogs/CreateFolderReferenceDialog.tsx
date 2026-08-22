/**
 * TagSpaces - universal file and folder organizer
 * Copyright (C) 2017-present TagSpaces GmbH
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License (version 3) as
 * published by the Free Software Foundation.
 */

import DraggablePaper from '-/components/DraggablePaper';
import TsButton from '-/components/TsButton';
import TsTextField from '-/components/TsTextField';
import TsDialogActions from '-/components/dialogs/components/TsDialogActions';
import TsDialogTitle from '-/components/dialogs/components/TsDialogTitle';
import { dirNameValidation, selectDirectoryDialog } from '-/services/utils-io';
import { extractDirectoryName } from '@tagspaces/tagspaces-common/paths';
import {
  Dialog,
  DialogContent,
  FormControl,
  FormHelperText,
  Paper,
  useMediaQuery,
} from '@mui/material';
import { styled, useTheme } from '@mui/material/styles';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

const TargetPathTextField = styled(TsTextField)(() => ({
  marginTop: 16,
}));

interface Props {
  open: boolean;
  onClose: () => void;
  directoryPath: string;
  dirSeparator: string;
  createFolderSymlink: (
    targetPath: string,
    linkName: string,
    directoryPath: string,
  ) => Promise<boolean>;
  showNotification: (message: string, type: string, autoHide?: boolean) => void;
}

function CreateFolderReferenceDialog(props: Props) {
  const { t } = useTranslation();
  const {
    open,
    onClose,
    directoryPath,
    dirSeparator,
    createFolderSymlink,
    showNotification,
  } = props;

  const [name, setName] = useState('');
  const [targetPath, setTargetPath] = useState('');
  const [inputError, setInputError] = useState(false);
  const [disableConfirmButton, setDisableConfirmButton] = useState(true);

  const resetState = useCallback(() => {
    setName('');
    setTargetPath('');
    setInputError(false);
    setDisableConfirmButton(true);
  }, []);

  const validate = useCallback((dirName: string, target: string): boolean => {
    const nameValid = dirNameValidation(dirName);
    const valid = !nameValid && target.length > 0;
    setInputError(nameValid);
    setDisableConfirmButton(!valid);
    return valid;
  }, []);

  const handleNameChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const { value } = event.target;
      setName(value);
      validate(value, targetPath);
    },
    [targetPath, validate],
  );

  const handleSelectTarget = useCallback(() => {
    selectDirectoryDialog()
      .then((result) => {
        if (result && result.length > 0) {
          const [selectedPath] = result;
          setTargetPath(selectedPath);
          const defaultName = extractDirectoryName(selectedPath, dirSeparator);
          if (!name) {
            setName(defaultName);
            validate(defaultName, selectedPath);
          } else {
            validate(name, selectedPath);
          }
        }
        return undefined;
      })
      .catch((error) => {
        console.log('Error selecting target folder:', error);
      });
  }, [dirSeparator, name, validate]);

  const handleConfirm = useCallback(() => {
    if (!validate(name, targetPath)) {
      return;
    }
    if (
      targetPath === directoryPath ||
      targetPath.startsWith(directoryPath + dirSeparator)
    ) {
      showNotification(
        t('core:createFolderReferenceCircularError'),
        'error',
        true,
      );
      return;
    }
    createFolderSymlink(targetPath, name, directoryPath)
      .then((success) => {
        if (success) {
          resetState();
          onClose();
        }
        return undefined;
      })
      .catch((error) => {
        console.log('Error creating folder reference:', error);
      });
  }, [
    createFolderSymlink,
    directoryPath,
    dirSeparator,
    name,
    onClose,
    resetState,
    showNotification,
    targetPath,
    t,
    validate,
  ]);

  const handleCancel = useCallback(() => {
    resetState();
    onClose();
  }, [onClose, resetState]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        handleConfirm();
      } else if (event.key === 'Escape') {
        onClose();
      }
    },
    [handleConfirm, onClose],
  );

  const theme = useTheme();
  const smallScreen = useMediaQuery(theme.breakpoints.down('md'));
  const okButton = (
    <TsButton
      disabled={disableConfirmButton}
      onClick={handleConfirm}
      data-tid="confirmCreateFolderReferenceTID"
      id="confirmCreateFolderReference"
      variant="contained"
      sx={
        {
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties & { WebkitAppRegion?: string }
      }
    >
      {t('core:ok')}
    </TsButton>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={smallScreen}
      PaperComponent={smallScreen ? Paper : DraggablePaper}
      keepMounted
      scroll="paper"
      onKeyDown={handleKeyDown}
    >
      <TsDialogTitle
        dialogTitle={t('core:createFolderReferenceTitle')}
        closeButtonTestId="closeCreateFolderReferenceTID"
        onClose={onClose}
        actionSlot={okButton}
      />
      <DialogContent>
        <FormControl fullWidth error={inputError}>
          <TsTextField
            error={inputError}
            autoFocus
            fullWidth
            name="name"
            label={t('core:createFolderReferenceName')}
            onChange={handleNameChange}
            updateValue={(value) => {
              setName(value);
              validate(value, targetPath);
            }}
            retrieveValue={() => name}
            value={name}
            data-tid="folderReferenceNameTID"
            id="folderReferenceName"
          />
          {inputError && (
            <FormHelperText>{t('core:directoryNameHelp')}</FormHelperText>
          )}
        </FormControl>
        <TargetPathTextField
          fullWidth
          name="targetPath"
          label={t('core:createFolderReferenceTarget')}
          value={targetPath}
          data-tid="folderReferenceTargetTID"
          id="folderReferenceTarget"
          slotProps={{
            input: {
              readOnly: true,
            },
          }}
        />
        <TsButton
          fullWidth
          onClick={handleSelectTarget}
          data-tid="selectFolderReferenceTargetTID"
          sx={{ marginTop: 2 }}
        >
          {t('core:chooseFolder')}
        </TsButton>
      </DialogContent>
      {!smallScreen && (
        <TsDialogActions>
          <TsButton
            data-tid="closeCreateFolderReference"
            onClick={handleCancel}
          >
            {t('core:cancel')}
          </TsButton>
          {okButton}
        </TsDialogActions>
      )}
    </Dialog>
  );
}

export default CreateFolderReferenceDialog;
