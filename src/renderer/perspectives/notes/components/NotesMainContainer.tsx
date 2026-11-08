/**
 * TagSpaces - universal file and folder organizer
 * Copyright (C) 2024-present TagSpaces GmbH
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
import EditNoteIcon from '@mui/icons-material/EditNote';
import { useCurrentLocationContext } from '-/hooks/useCurrentLocationContext';
import { useDirectoryContentContext } from '-/hooks/useDirectoryContentContext';
import { useOpenedEntryContext } from '-/hooks/useOpenedEntryContext';
import { useReloadOnFocus } from '-/perspectives/common/useReloadOnFocus';
import SortingMenu from '-/perspectives/grid/components/SortingMenu';
import { useSortedDirContext } from '-/perspectives/grid/hooks/useSortedDirContext';
import NoteCard from '-/perspectives/notes/components/NoteCard';
import NotesToolbar from '-/perspectives/notes/components/NotesToolbar';
import AppConfig from '-/AppConfig';
import {
  isNoteFile,
  groupNotesByDate,
  newNoteBaseName,
} from '-/utils/notesGrouping';
import { Box, Button, Typography } from '@mui/material';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TS } from '-/tagspaces.namespace';

interface Props {}

function NotesMainContainer(props: Props) {
  const { t } = useTranslation();
  const { currentLocation } = useCurrentLocationContext();
  const { currentDirectoryPath, openDirectory } = useDirectoryContentContext();
  const { openEntry, createFileAdvanced } = useOpenedEntryContext();
  const { sortedDirContent, sortBy, orderBy, setSortBy, setOrderBy } =
    useSortedDirContext();

  const [filter, setFilter] = useState<string>('');
  const [sortingMenuAnchorEl, setSortingMenuAnchorEl] =
    useState<HTMLElement>(undefined);

  useReloadOnFocus(currentLocation?.reloadOnFocus, () =>
    openDirectory(currentDirectoryPath),
  );

  const notes = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return sortedDirContent
      .filter(
        (entry: TS.FileSystemEntry) => entry.isFile && isNoteFile(entry.name),
      )
      .filter((entry: TS.FileSystemEntry) =>
        needle ? entry.name.toLowerCase().includes(needle) : true,
      );
  }, [sortedDirContent, filter]);

  const groups = useMemo(() => groupNotesByDate(notes), [notes]);

  const handleSortBy = (handleSort: string) => {
    if (sortBy !== handleSort) {
      setSortBy(handleSort);
      // Date-based sort defaults to descending (newest first) on first selection
      if (handleSort === 'byDateModified') {
        setOrderBy(false);
      }
    } else {
      setOrderBy(!orderBy);
    }
    setSortingMenuAnchorEl(undefined);
  };

  const createNote = () => {
    if (!currentDirectoryPath) {
      return;
    }
    const baseName = newNoteBaseName();
    // Joplin-style one-click capture: create with a template head and open
    // the note in edit mode right away.
    createFileAdvanced(
      currentDirectoryPath,
      baseName,
      '# ' + t('core:untitledNote') + '\n\n',
      'md',
    );
    const sep = currentLocation?.getDirSeparator() || AppConfig.dirSeparator;
    openEntry(
      currentDirectoryPath + sep + baseName + '.md',
      undefined,
      undefined,
      true,
    );
  };

  const groupTitle = (key: string) => {
    switch (key) {
      case 'today':
        return t('core:notesToday');
      case 'yesterday':
        return t('core:notesYesterday');
      case 'thisWeek':
        return t('core:notesThisWeek');
      case 'thisMonth':
        return t('core:notesThisMonth');
      default:
        return t('core:notesEarlier');
    }
  };

  return (
    <Box
      sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}
      data-tid="notesPerspectiveContainer"
    >
      <NotesToolbar
        disabled={!currentDirectoryPath}
        filter={filter}
        onFilterChange={setFilter}
        onCreateNote={createNote}
        onOpenSortMenu={(event) =>
          setSortingMenuAnchorEl(event.currentTarget as HTMLElement)
        }
      />
      <Box sx={{ flex: 1, overflow: 'auto', px: 2, pb: 2 }}>
        {notes.length === 0 ? (
          <Box
            sx={{
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 2,
              color: 'text.secondary',
            }}
            data-tid="notesEmptyState"
          >
            <EditNoteIcon sx={{ fontSize: 64 }} />
            <Typography variant="h6">{t('core:notesEmpty')}</Typography>
            <Button
              variant="contained"
              data-tid="newNoteButtonEmpty"
              onClick={createNote}
              disabled={!currentDirectoryPath}
            >
              {t('core:newNote')}
            </Button>
          </Box>
        ) : (
          groups.map((group) => (
            <Box key={group.key} data-tid={`notesGroup_${group.key}`}>
              <Typography
                variant="subtitle2"
                color="text.secondary"
                sx={{
                  mt: 2,
                  mb: 1,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                }}
              >
                {groupTitle(group.key)}
              </Typography>
              {group.entries.map((entry: TS.FileSystemEntry) => (
                <NoteCard
                  fsEntry={entry}
                  key={entry.path}
                  onOpen={(path) => openEntry(path, undefined, undefined, true)}
                />
              ))}
            </Box>
          ))
        )}
      </Box>
      {Boolean(sortingMenuAnchorEl) && (
        <SortingMenu
          open={Boolean(sortingMenuAnchorEl)}
          onClose={() => setSortingMenuAnchorEl(undefined)}
          anchorEl={sortingMenuAnchorEl}
          handleSortBy={handleSortBy}
        />
      )}
    </Box>
  );
}

export default NotesMainContainer;
