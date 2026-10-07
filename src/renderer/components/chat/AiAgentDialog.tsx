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
 * Panel width is drag-resizable and persisted. There is a single
 * conversation surface (the AgentPanel — it runs the tool-calling loop,
 * keeps its own sessions, tool-call cards and model picker); the kb/tools/
 * skills/deepseek tabs open the supporting capabilities.
 */
import { CloseIcon } from '-/components/CommonIcons';
import AgentPanel from '-/components/chat/AgentPanel';
import KnowledgeBasePanel from '-/components/chat/KnowledgeBasePanel';
import AiCapabilitiesPanel from '-/components/chat/AiCapabilitiesPanel';
import DeepSeekWebPanel from '-/components/chat/DeepSeekWebPanel';
import { useTranslation } from 'react-i18next';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Box from '@mui/material/Box';
import React, { useEffect, useRef, useState } from 'react';

const MIN_WIDTH = 360;
const DEFAULT_WIDTH = 480;

interface Props {
  open: boolean;
  onClose: () => void;
  /** Controlled panel width (persisted by the parent context provider). */
  width: number;
  onWidthChange: (width: number) => void;
}

function AiAgentDialog(props: Props) {
  const { t } = useTranslation();
  const { open, onClose, width, onWidthChange } = props;
  const [view, setView] = useState<
    'agent' | 'kb' | 'tools' | 'skills' | 'deepseek'
  >('agent');
  const resizing = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizing.current) return;
      const max = Math.min(window.innerWidth * 0.7, window.innerWidth - 40);
      onWidthChange(
        Math.max(MIN_WIDTH, Math.min(window.innerWidth - e.clientX, max)),
      );
    };
    const onUp = () => {
      resizing.current = false;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [onWidthChange]);

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
          paddingY: 0.5,
          paddingX: 1,
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Tabs
          value={view}
          onChange={(event, nextView) => setView(nextView)}
          sx={{
            minHeight: 'auto',
            flexGrow: 1,
            '& .MuiTab-root': {
              minHeight: 'auto',
              paddingY: 1,
              paddingX: 1.5,
            },
          }}
        >
          <Tab
            value="agent"
            label={t('core:aiAgentMode')}
            data-tid="aiAgentTabTID"
          />
          <Tab value="kb" label={t('core:aiKbTab')} data-tid="aiKbTabTID" />
          <Tab
            value="tools"
            label={t('core:aiCapToolsTab')}
            data-tid="aiToolsTabTID"
          />
          <Tab
            value="skills"
            label={t('core:aiCapSkillsTab')}
            data-tid="aiSkillsTabTID"
          />
          <Tab
            value="deepseek"
            label={t('core:deepseekTab')}
            data-tid="aiDeepseekTabTID"
          />
        </Tabs>
        <IconButton aria-label={t('core:close')} onClick={onClose} size="small">
          <CloseIcon />
        </IconButton>
      </Box>
      <Box
        sx={{
          flexGrow: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {view === 'agent' ? (
          <AgentPanel />
        ) : view === 'kb' ? (
          <KnowledgeBasePanel />
        ) : view === 'tools' || view === 'skills' ? (
          <AiCapabilitiesPanel
            key={view}
            initialTab={view === 'skills' ? 'skills' : 'tools'}
            hideTabs
            onClose={() => setView('agent')}
          />
        ) : view === 'deepseek' ? (
          <DeepSeekWebPanel />
        ) : (
          <AgentPanel />
        )}
      </Box>
    </Drawer>
  );
}

export default AiAgentDialog;
