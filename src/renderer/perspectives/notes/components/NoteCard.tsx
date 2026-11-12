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
import TagContainer from '-/components/TagContainer';
import { formatDateTime } from '-/utils/dates';
import { Box, ListItemButton, Typography } from '@mui/material';
import { formatFileSize } from '@tagspaces/tagspaces-common/misc';
import React from 'react';
import { TS } from '-/tagspaces.namespace';

interface Props {
  fsEntry: TS.FileSystemEntry;
  onOpen: (path: string) => void;
}

/** Strip the note extension for the card title. */
function noteTitle(name: string): string {
  return name.replace(/\.(md|markdown|txt)$/i, '');
}

function NoteCard(props: Props) {
  const { fsEntry, onOpen } = props;
  return (
    <ListItemButton
      data-tid="noteCard"
      onClick={() => onOpen(fsEntry.path)}
      sx={{ borderRadius: 1, mb: 0.5 }}
    >
      <Box sx={{ width: '100%', minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
          <Typography variant="subtitle1" noWrap sx={{ flex: 1 }}>
            {noteTitle(fsEntry.name)}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ whiteSpace: 'nowrap' }}
          >
            {formatDateTime(new Date(fsEntry.lmdt))}
          </Typography>
        </Box>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            mt: 0.5,
            flexWrap: 'wrap',
          }}
        >
          {(fsEntry.tags || []).map((tag: TS.Tag, index: number) => (
            <TagContainer
              tag={tag}
              entry={fsEntry}
              key={fsEntry.path + '_' + index}
            />
          ))}
          <Typography variant="caption" color="text.secondary">
            {formatFileSize(fsEntry.size)}
          </Typography>
        </Box>
      </Box>
    </ListItemButton>
  );
}

export default React.memo(NoteCard);
