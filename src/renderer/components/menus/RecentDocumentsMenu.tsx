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

import AppConfig from '-/AppConfig';
import { DeleteIcon, HistoryIcon } from '-/components/CommonIcons';
import TsMenuList from '-/components/TsMenuList';
import TsTooltip from '-/components/TsTooltip';
import { historyKeys } from '-/hooks/HistoryContextProvider';
import { useBrowserHistoryContext } from '-/hooks/useBrowserHistoryContext';
import { useCurrentLocationContext } from '-/hooks/useCurrentLocationContext';
import { useHistoryContext } from '-/hooks/useHistoryContext';
import { useNotificationContext } from '-/hooks/useNotificationContext';
import { getRelativeEntryPath } from '-/services/utils-io';
import { TS } from '-/tagspaces.namespace';
import { dataTidFormat } from '-/services/test';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import {
  extractDirectoryName,
  extractFileName,
} from '@tagspaces/tagspaces-common/paths';
import { useTranslation } from 'react-i18next';

interface Props {
  anchorEl: Element;
  open: boolean;
  onClose: () => void;
}

function fileNameOf(item: TS.HistoryItem): string {
  return item.path.endsWith(AppConfig.dirSeparator)
    ? extractDirectoryName(item.path, AppConfig.dirSeparator)
    : extractFileName(item.path, AppConfig.dirSeparator);
}

interface ItemProps {
  item: TS.HistoryItem;
  locationName: string | undefined;
  relativePath: string;
  onOpen: (item: TS.HistoryItem) => void;
}

function RecentDocumentItem(props: ItemProps) {
  const { item, locationName, relativePath, onOpen } = props;
  const { t } = useTranslation();
  const name = fileNameOf(item);
  const handleClick = () => onOpen(item);

  return (
    <MenuItem
      data-tid={`recentDocumentsMenuTID${dataTidFormat(name)}`}
      onClick={handleClick}
      sx={{ maxWidth: 420 }}
    >
      <ListItemIcon>
        <HistoryIcon fontSize="small" />
      </ListItemIcon>
      <TsTooltip
        title={
          <span>
            <b>{t('core:filePath')}:</b> {item.path}
            {locationName && (
              <>
                <br />
                <br />
                <b>{t('core:location')}:</b> {locationName}
              </>
            )}
            <br />
            <br />
            <b>{t('creationDate')}:&nbsp;</b>
            {new Date(item.creationTimeStamp)
              .toISOString()
              .substring(0, 19)
              .replace('T', ' ')}
          </span>
        }
      >
        <ListItemText
          primary={name}
          secondary={relativePath !== name ? relativePath : locationName}
          slotProps={{
            primary: {
              noWrap: true,
              variant: 'body2',
              color: 'text.primary',
            },
            secondary: {
              noWrap: true,
              variant: 'caption',
              color: 'text.secondary',
            },
          }}
        />
      </TsTooltip>
    </MenuItem>
  );
}

/**
 * Dropdown listing the recently opened documents (persisted in the same
 * `tsLastOpenedFilesHistory` localStorage entry the welcome panel and the
 * quick-access panel use), so recent work is one click away from any folder.
 */
function RecentDocumentsMenu(props: Props) {
  const { anchorEl, open, onClose } = props;
  const { t } = useTranslation();
  const { fileOpenHistory, delAllHistory } = useHistoryContext();
  const { findLocation } = useCurrentLocationContext();
  const { openHistoryItem } = useBrowserHistoryContext();
  const { openConfirmDialog } = useNotificationContext();

  const items = fileOpenHistory || [];

  const handleOpenItem = (item: TS.HistoryItem) => {
    onClose();
    openHistoryItem(item);
  };

  const handleClearHistory = () => {
    onClose();
    openConfirmDialog(
      t('core:confirm'),
      t('core:clearRecentDocumentsConfirmation'),
      (result) => {
        if (result) {
          delAllHistory(historyKeys.fileOpenKey);
        }
      },
      'cancelClearRecentDocumentsDialog',
      'confirmClearRecentDocumentsDialog',
      'confirmClearRecentDocumentsDialogContent',
    );
  };

  function renderItem(item: TS.HistoryItem) {
    const location = item.lid ? findLocation(item.lid) : undefined;
    const relativePath = location?.path
      ? getRelativeEntryPath(location.path, item.path)
      : item.path;
    return (
      <RecentDocumentItem
        key={`${item.creationTimeStamp}${item.path}`}
        item={item}
        locationName={location?.name}
        relativePath={relativePath}
        onOpen={handleOpenItem}
      />
    );
  }

  return (
    <Menu
      anchorEl={anchorEl}
      open={open}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      slotProps={{
        paper: {
          sx: { minWidth: 260, maxWidth: 420 },
        },
      }}
      data-tid="recentDocumentsMenu"
    >
      <Box sx={{ px: 2, pt: 1, pb: 0.5 }}>
        <Typography variant="caption" color="text.secondary" noWrap>
          {t('core:recentDocuments')}
        </Typography>
      </Box>
      <TsMenuList sx={{ py: 0, maxHeight: 420, overflowY: 'auto' }}>
        {items.length > 0 ? (
          items.map(renderItem)
        ) : (
          <MenuItem disabled data-tid="recentDocumentsEmptyTID">
            <ListItemText primary={t('noItems')} />
          </MenuItem>
        )}
        <Divider />
        <MenuItem
          data-tid="clearRecentDocumentsTID"
          disabled={items.length === 0}
          onClick={handleClearHistory}
        >
          <ListItemIcon>
            <DeleteIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={t('core:clearHistory')} />
        </MenuItem>
      </TsMenuList>
    </Menu>
  );
}

export default RecentDocumentsMenu;
