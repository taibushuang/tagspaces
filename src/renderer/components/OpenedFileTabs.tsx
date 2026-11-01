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

import { CloseIcon } from '-/components/CommonIcons';
import { OpenedFileTab, tabKey } from '-/utils/openedFileTabs';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import { useTheme } from '@mui/material/styles';
import Tooltip from '@mui/material/Tooltip';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  tabs: OpenedFileTab[];
  activeKey?: string;
  onSelect: (tab: OpenedFileTab) => void;
  onClose: (tab: OpenedFileTab) => void;
}

/**
 * Editor-style document tab strip rendered above the file viewer title bar.
 * Shows every file opened in this session (see OpenedEntryContextProvider),
 * letting the user jump between documents without going back to the folder
 * list — the md/multi-document reading gap vs. other editors.
 */
function OpenedFileTabs(props: Props) {
  const { tabs, activeKey, onSelect, onClose } = props;
  const theme = useTheme();
  const { t } = useTranslation();

  if (!tabs || tabs.length === 0) {
    return null;
  }

  return (
    <Box
      data-tid="openedFileTabsTID"
      sx={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'stretch',
        overflowX: 'auto',
        overflowY: 'hidden',
        minHeight: '34px',
        paddingLeft: '8px',
        borderStyle: 'solid',
        borderColor: theme.palette.divider,
        borderWidth: '0px',
        borderBottomWidth: '1px',
        scrollbarWidth: 'thin',
      }}
    >
      {tabs.map((tab, index) => {
        const isActive = tabKey(tab) === activeKey;
        return (
          <Box
            key={tabKey(tab)}
            data-tid={`openedFileTab_${index}`}
            onClick={() => {
              if (!isActive) {
                onSelect(tab);
              }
            }}
            sx={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              maxWidth: '220px',
              minWidth: '80px',
              paddingLeft: '10px',
              paddingRight: '2px',
              cursor: isActive ? 'default' : 'pointer',
              fontSize: '13px',
              whiteSpace: 'nowrap',
              color: isActive
                ? theme.palette.text.primary
                : theme.palette.text.secondary,
              backgroundColor: isActive
                ? theme.palette.action.selected
                : 'transparent',
              borderRadius: '6px 6px 0 0',
              borderStyle: 'solid',
              borderColor: 'transparent',
              borderBottomColor: isActive
                ? theme.palette.primary.main
                : 'transparent',
              '&:hover': {
                backgroundColor: isActive
                  ? theme.palette.action.selected
                  : theme.palette.action.hover,
                '& .openedFileTabClose': { opacity: 1 },
              },
            }}
          >
            <Tooltip title={tab.path}>
              <Box
                sx={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flexGrow: 1,
                  py: '6px',
                }}
              >
                {tab.name}
              </Box>
            </Tooltip>
            <Tooltip title={t('core:closeButton')}>
              <IconButton
                className="openedFileTabClose"
                data-tid={`closeOpenedFileTab_${index}`}
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab);
                }}
                sx={{
                  // Always visible on the active tab: touch devices have no
                  // hover, the button would be undiscoverable there.
                  opacity: isActive ? 1 : 0,
                  ml: 0.5,
                }}
              >
                <CloseIcon sx={{ fontSize: '14px' }} />
              </IconButton>
            </Tooltip>
          </Box>
        );
      })}
    </Box>
  );
}

export default OpenedFileTabs;
