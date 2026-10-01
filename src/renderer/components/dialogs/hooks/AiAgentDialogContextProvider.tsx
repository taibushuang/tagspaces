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

import React, { createContext, useContext, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Fab from '@mui/material/Fab';
import Tooltip from '@mui/material/Tooltip';
import { AIIcon } from '-/components/CommonIcons';
import AiAgentDialog from '-/components/chat/AiAgentDialog';

type AiAgentDialogContextData = {
  openAiAgentDialog: () => void;
  closeAiAgentDialog: () => void;
};

export const AiAgentDialogContext = createContext<AiAgentDialogContextData>({
  openAiAgentDialog: () => undefined,
  closeAiAgentDialog: () => undefined,
});

export const useAiAgentDialogContext = () => useContext(AiAgentDialogContext);

export const AiAgentDialogContextProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const context = useMemo(
    () => ({
      openAiAgentDialog: () => setOpen(true),
      closeAiAgentDialog: () => setOpen(false),
    }),
    [],
  );
  return (
    <AiAgentDialogContext.Provider value={context}>
      {children}
      <AiAgentDialog open={open} onClose={() => setOpen(false)} />
      {!open && (
        <Tooltip title={t('core:aiAgentTitle')} placement="left">
          <Fab
            size="small"
            data-tid="aiAgentFabTID"
            onClick={() => setOpen(true)}
            sx={{ position: 'fixed', right: 12, top: '50%', zIndex: 1100 }}
          >
            <AIIcon />
          </Fab>
        </Tooltip>
      )}
    </AiAgentDialogContext.Provider>
  );
};
