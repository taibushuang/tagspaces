/**
 * TagSpaces - universal file and folder organizer
 * Copyright (C) 2017-present TagSpaces GmbH
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License (version 3) as
 * published by the Free Software Foundation.  See the
 * GNU Affero General Public License for more details.
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
import { useCurrentLocationContext } from '-/hooks/useCurrentLocationContext';
import { useIOActionsContext } from '-/hooks/useIOActionsContext';
import { useNotificationContext } from '-/hooks/useNotificationContext';
import { TS } from '-/tagspaces.namespace';
import {
  FileVersionGroup,
  groupFileVersions,
} from '-/utils/fileVersionGrouper';
import { extractContainingDirectoryPath } from '@tagspaces/tagspaces-common/paths';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import FormControlLabel from '@mui/material/FormControlLabel';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  open: boolean;
  onClose: () => void;
  entries: TS.FileSystemEntry[];
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDate(timestamp: number): string {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleDateString();
}

function FileVersionCleanupDialog(props: Props) {
  const { open, onClose, entries } = props;
  const { t } = useTranslation();
  const { deleteEntries, moveFiles } = useIOActionsContext();
  const { showNotification } = useNotificationContext();
  const { findLocation } = useCurrentLocationContext();

  const [groups, setGroups] = useState<FileVersionGroup[]>([]);
  const [moveKeptFiles, setMoveKeptFiles] = useState<boolean>(false);
  // Index of the group currently being cleaned up; -1 = idle. Guards against
  // double-clicks while the async delete/move is in flight.
  const [executingGroup, setExecutingGroup] = useState<number>(-1);

  useEffect(() => {
    if (open && entries && entries.length > 0) {
      setGroups(groupFileVersions(entries));
      setMoveKeptFiles(false);
      setExecutingGroup(-1);
    }
  }, [open, entries]);

  function toggleFileAction(groupIndex: number, fileIndex: number) {
    setGroups((prev) => {
      const updated = [...prev];
      const group = { ...updated[groupIndex] };
      const file = group.files[fileIndex];

      const isInKeep = group.toKeep.some((f) => f.path === file.path);
      if (isInKeep) {
        // Move from keep to delete
        group.toKeep = group.toKeep.filter((f) => f.path !== file.path);
        group.toDelete = [...group.toDelete, file];
      } else {
        // Move from delete to keep
        group.toDelete = group.toDelete.filter((f) => f.path !== file.path);
        group.toKeep = [...group.toKeep, file];
      }
      updated[groupIndex] = group;
      return updated;
    });
  }

  const totalGroups = groups.length;
  const totalDelete = groups.reduce((sum, g) => sum + g.toDelete.length, 0);

  /**
   * Every file in the group must resolve to a configured location — otherwise
   * delete/move would silently no-op or run against the wrong location.
   */
  function isGroupActionable(group: FileVersionGroup): boolean {
    return group.files.every((f) => !!findLocation(f.locationID));
  }

  /**
   * Execute cleanup for ONE group only. Deletion requires this explicit
   * per-group confirmation — there is intentionally no global "execute all".
   */
  async function handleCleanupGroup(groupIndex: number) {
    const group = groups[groupIndex];
    if (!group || group.toKeep.length === 0 || executingGroup >= 0) return;

    setExecutingGroup(groupIndex);
    try {
      const deleteCount = group.toDelete.length;
      let success = true;
      if (deleteCount > 0) {
        success = await deleteEntries(...group.toDelete);
      }
      if (!success) {
        // deleteEntries already showed a failure notification
        return;
      }

      // Optionally relocate kept files next to the newest version
      let movedCount = 0;
      if (moveKeptFiles) {
        const targetDir = extractContainingDirectoryPath(group.toKeep[0].path);
        const filesToMove = group.toKeep.filter(
          (f) => extractContainingDirectoryPath(f.path) !== targetDir,
        );
        // moveFiles works against a single location — group paths by it
        const pathsByLocation = new Map<string, string[]>();
        for (const f of filesToMove) {
          const loc = findLocation(f.locationID);
          if (!loc) continue;
          const arr = pathsByLocation.get(loc.uuid) ?? [];
          arr.push(f.path);
          pathsByLocation.set(loc.uuid, arr);
        }
        for (const [locationID, paths] of pathsByLocation) {
          await moveFiles(paths, targetDir, locationID);
          movedCount += paths.length;
        }
      }

      showNotification(
        t('core:versionCleanupSuccess', {
          deleted: deleteCount,
          moved: movedCount,
        }),
        'default',
        true,
      );
      // Remove the executed group from the list
      setGroups((prev) => prev.filter((_, i) => i !== groupIndex));
    } finally {
      setExecutingGroup(-1);
    }
  }

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
        dialogTitle={t('core:fileVersionCleanup')}
        closeButtonTestId="closeVersionCleanupTID"
        onClose={onClose}
      />
      <DialogContent sx={{ overflowX: 'hidden', overflowY: 'auto' }}>
        {groups.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            {t('core:noVersionGroupsFound')}
          </Typography>
        )}
        {groups.length > 0 && (
          <FormControlLabel
            control={
              <Checkbox
                checked={moveKeptFiles}
                onChange={(e) => setMoveKeptFiles(e.target.checked)}
                size="small"
              />
            }
            label={t('core:versionCleanupMoveKept')}
          />
        )}
        {groups.map((group, groupIndex) => {
          const actionable = isGroupActionable(group);
          const canExecute =
            actionable && group.toKeep.length > 0 && executingGroup < 0;
          const targetDir =
            moveKeptFiles && group.toKeep.length > 0
              ? extractContainingDirectoryPath(group.toKeep[0].path)
              : undefined;
          return (
            <Accordion
              key={group.baseName + '.' + group.extension}
              defaultExpanded
            >
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                  {group.baseName}.{group.extension}
                </Typography>
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ marginLeft: 1, alignSelf: 'center' }}
                >
                  ({group.files.length} {t('core:files')})
                </Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ padding: 0 }}>
                <List dense>
                  {group.files.map((file, fileIndex) => {
                    const isKept = group.toKeep.some(
                      (f) => f.path === file.path,
                    );
                    return (
                      <ListItem key={file.path}>
                        <Chip
                          label={
                            isKept
                              ? t('core:versionGroupKeep')
                              : t('core:versionGroupDelete')
                          }
                          color={isKept ? 'success' : 'error'}
                          size="small"
                          onClick={() =>
                            toggleFileAction(groupIndex, fileIndex)
                          }
                          sx={{ marginRight: 1, minWidth: 64 }}
                        />
                        <ListItemText
                          primary={file.name}
                          secondary={
                            formatDate(file.lmdt) +
                            ' · ' +
                            formatFileSize(file.size)
                          }
                        />
                      </ListItem>
                    );
                  })}
                </List>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    gap: 1,
                    padding: 1,
                  }}
                >
                  {targetDir && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ marginRight: 'auto', wordBreak: 'break-all' }}
                    >
                      {t('core:versionCleanupTargetDir')}: {targetDir}
                    </Typography>
                  )}
                  {!actionable && (
                    <Typography variant="caption" color="error">
                      {t('core:versionCleanupNoLocation')}
                    </Typography>
                  )}
                  {actionable && group.toKeep.length === 0 && (
                    <Typography variant="caption" color="error">
                      {t('core:versionCleanupNeedKeep')}
                    </Typography>
                  )}
                  <TsButton
                    data-tid={`confirmCleanupGroup${groupIndex}`}
                    variant="contained"
                    disabled={!canExecute}
                    onClick={() => handleCleanupGroup(groupIndex)}
                  >
                    {t('core:confirmCleanupGroup')}
                  </TsButton>
                </Box>
              </AccordionDetails>
            </Accordion>
          );
        })}
      </DialogContent>
      <TsDialogActions
        sx={{
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          rowGap: 1,
        }}
      >
        <Typography variant="body2" color="text.secondary">
          {t('core:versionCleanupSummary', {
            groups: totalGroups,
            deleteCount: totalDelete,
          })}
        </Typography>
        <TsButton data-tid="cancelVersionCleanup" onClick={onClose}>
          {t('core:cancel')}
        </TsButton>
      </TsDialogActions>
    </Dialog>
  );
}

export default FileVersionCleanupDialog;
