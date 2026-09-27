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

/**
 * Global AI Agent entry point: a toolbar-launched dialog with a Chat/Agent
 * tab switch — the Agent tab hosts the standalone AgentPanel (own sessions,
 * tool-call cards), the Chat tab reuses the existing ChatView (which carries
 * the Agent toggle). Independent of the EntryContainer AI tab so the agent is
 * reachable from anywhere in the app.
 */
import { CloseIcon } from '-/components/CommonIcons';
import AgentPanel from '-/components/chat/AgentPanel';
import { useTranslation } from 'react-i18next';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import MuiDialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import React, { Suspense, useState } from 'react';

// Lazy on purpose: a static import would create a dependency cycle
// ChatView → ChatProvider → … → MainToolbar → AiAgentDialog
// eslint-disable-next-line import/no-cycle -- loaded on demand, no runtime cycle
const ChatView = React.lazy(
  // eslint-disable-next-line import/no-cycle -- loaded on demand, no runtime cycle
  () => import(/* webpackChunkName: "ChatView" */ '-/components/chat/ChatView'),
);

interface Props {
  open: boolean;
  onClose: () => void;
}

function AiAgentDialog(props: Props) {
  const { t } = useTranslation();
  const { open, onClose } = props;
  const [view, setView] = useState<'chat' | 'agent'>('chat');
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="md"
      data-tid="aiAgentDialogTID"
    >
      <MuiDialogTitle
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingY: 1,
        }}
      >
        <Typography variant="h6">{t('core:aiAgentTitle')}</Typography>
        <IconButton aria-label={t('core:close')} onClick={onClose} size="small">
          <CloseIcon />
        </IconButton>
      </MuiDialogTitle>
      <DialogContent
        dividers
        sx={{ height: '70vh', display: 'flex', flexDirection: 'column' }}
      >
        <Tabs
          value={view}
          onChange={(event, nextView) => setView(nextView)}
          sx={{ marginBottom: 1, minHeight: 'auto' }}
        >
          <Tab value="chat" label={t('core:aiChatTab')} />
          <Tab
            value="agent"
            label={t('core:aiAgentMode')}
            data-tid="aiAgentTabTID"
          />
        </Tabs>
        {view === 'agent' ? (
          <Box
            sx={{
              flexGrow: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <AgentPanel />
          </Box>
        ) : (
          <Box
            sx={{
              flexGrow: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <Suspense
              fallback={<CircularProgress size={24} sx={{ margin: 'auto' }} />}
            >
              <ChatView />
            </Suspense>
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default AiAgentDialog;
