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
 * Global AI Agent work area: slides out from the right edge as a
 * non-blocking side panel (persistent drawer — the main view stays
 * usable while the agent works, so file moves/tags can be watched live).
 * Panel width is drag-resizable and persisted. Hosts a Chat/Agent tab
 * switch: the Agent tab runs the standalone AgentPanel (own sessions,
 * tool-call cards), the Chat tab reuses the existing ChatView.
 */
import { CloseIcon } from '-/components/CommonIcons';
import AgentPanel from '-/components/chat/AgentPanel';
import { useTranslation } from 'react-i18next';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import React, { Suspense, useEffect, useRef, useState } from 'react';

// Lazy on purpose: a static import would create a dependency cycle
// ChatView → ChatProvider → … → MainToolbar → AiAgentDialog
// eslint-disable-next-line import/no-cycle -- loaded on demand, no runtime cycle
const ChatView = React.lazy(
  // eslint-disable-next-line import/no-cycle -- loaded on demand, no runtime cycle
  () => import(/* webpackChunkName: "ChatView" */ '-/components/chat/ChatView'),
);

const PANEL_WIDTH_KEY = 'tsAiAgentPanelWidth';
const MIN_WIDTH = 360;
const DEFAULT_WIDTH = 480;

function readStoredWidth(): number {
  const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
  return Number.isFinite(stored) && stored >= MIN_WIDTH ? stored : DEFAULT_WIDTH;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

function AiAgentDialog(props: Props) {
  const { t } = useTranslation();
  const { open, onClose } = props;
  const [view, setView] = useState<'chat' | 'agent'>('chat');
  const [width, setWidth] = useState<number>(readStoredWidth);
  const resizing = useRef(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizing.current) return;
      const max = Math.min(window.innerWidth * 0.7, window.innerWidth - 40);
      setWidth(Math.max(MIN_WIDTH, Math.min(window.innerWidth - e.clientX, max)));
    };
    const onUp = () => {
      if (!resizing.current) return;
      resizing.current = false;
      localStorage.setItem(PANEL_WIDTH_KEY, String(widthRef.current));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      variant="persistent"
      anchor="right"
      data-tid="aiAgentDialogTID"
      slotProps={{
        paper: {
          sx: {
            width: Math.min(width, window.innerWidth),
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
          },
        },
      }}
    >
      <Box
        data-tid="aiAgentPanelResizeTID"
        onMouseDown={(e) => {
          e.preventDefault();
          resizing.current = true;
        }}
        sx={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 6,
          cursor: 'col-resize',
          zIndex: 2,
          '&:hover': { backgroundColor: 'divider' },
        }}
      />
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingY: 1,
          paddingX: 2,
        }}
      >
        <Typography variant="h6">{t('core:aiAgentTitle')}</Typography>
        <IconButton aria-label={t('core:close')} onClick={onClose} size="small">
          <CloseIcon />
        </IconButton>
      </Box>
      <Tabs
        value={view}
        onChange={(event, nextView) => setView(nextView)}
        sx={{ marginBottom: 1, minHeight: 'auto', paddingX: 2 }}
      >
        <Tab value="chat" label={t('core:aiChatTab')} />
        <Tab value="agent" label={t('core:aiAgentMode')} data-tid="aiAgentTabTID" />
      </Tabs>
      <Box sx={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {view === 'agent' ? (
          <AgentPanel />
        ) : (
          <Suspense fallback={<CircularProgress size={24} sx={{ margin: 'auto' }} />}>
            <ChatView />
          </Suspense>
        )}
      </Box>
    </Drawer>
  );
}

export default AiAgentDialog;
