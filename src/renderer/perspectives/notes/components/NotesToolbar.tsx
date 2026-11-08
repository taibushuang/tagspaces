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
import {
  Box,
  IconButton,
  InputAdornment,
  TextField,
  Tooltip,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import SearchIcon from '@mui/icons-material/Search';
import SortIcon from '@mui/icons-material/Sort';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  disabled: boolean;
  filter: string;
  onFilterChange: (value: string) => void;
  onCreateNote: () => void;
  onOpenSortMenu: (event: React.MouseEvent<HTMLElement>) => void;
}

function NotesToolbar(props: Props) {
  const { disabled, filter, onFilterChange, onCreateNote, onOpenSortMenu } =
    props;
  const { t } = useTranslation();
  return (
    <Box
      sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1 }}
      data-tid="notesToolbar"
    >
      <Tooltip title={t('core:newNote')}>
        <span>
          <IconButton
            data-tid="newNoteButton"
            color="primary"
            onClick={onCreateNote}
            disabled={disabled}
          >
            <AddIcon />
          </IconButton>
        </span>
      </Tooltip>
      <TextField
        size="small"
        data-tid="filterNotes"
        placeholder={t('core:filterNotes')}
        value={filter}
        onChange={(e) => onFilterChange(e.target.value)}
        sx={{ maxWidth: 320 }}
        slotProps={{
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          },
        }}
      />
      <Box sx={{ flex: 1 }} />
      <IconButton data-tid="notesSortButton" onClick={onOpenSortMenu}>
        <SortIcon />
      </IconButton>
    </Box>
  );
}

export default NotesToolbar;
