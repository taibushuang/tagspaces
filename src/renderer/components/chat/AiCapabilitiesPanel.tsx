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
 * AI capabilities center ("挤占式" inline panel): browse/search every tool
 * and skill the agent can use, toggle built-in tools on/off, and add custom
 * HTTP tools and custom prompt skills by hand. Replaces the file-content area
 * while open (rendered by RenderPerspective), same pattern as TodoListPanel.
 */
import { createAgentTools } from '-/components/chat/AgentTools';
import {
  CustomSkillDef,
  CustomToolDef,
  deleteCustomSkill,
  deleteCustomTool,
  executeCustomTool,
  getCustomSkills,
  getCustomTools,
  getDisabledTools,
  sanitizeToolFunctionName,
  saveCustomSkill,
  saveCustomTool,
  setToolEnabled,
} from '-/components/chat/agentCapabilities';
import { useNotificationContext } from '-/hooks/useNotificationContext';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Switch from '@mui/material/Switch';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/CloseOutlined';
import DeleteIcon from '@mui/icons-material/DeleteOutlineOutlined';
import EditIcon from '@mui/icons-material/EditOutlined';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

/** One-shot tool metadata for the catalog (execute is never invoked). */
function getBuiltinToolMetas(): Array<{
  name: string;
  description: string;
  parameters: Record<string, any>;
}> {
  return createAgentTools({} as any).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

const BUILTIN_SKILLS: Array<{ id: string; nameKey: string; descKey: string }> =
  [
    {
      id: 'organize',
      nameKey: 'aiCapSkillOrganizeName',
      descKey: 'aiCapSkillOrganizeDesc',
    },
    {
      id: 'summarize',
      nameKey: 'aiCapSkillSummarizeName',
      descKey: 'aiCapSkillSummarizeDesc',
    },
    {
      id: 'deliverable',
      nameKey: 'aiCapSkillDeliverableName',
      descKey: 'aiCapSkillDeliverableDesc',
    },
    {
      id: 'searchopts',
      nameKey: 'aiCapSkillSearchOpsName',
      descKey: 'aiCapSkillSearchOpsDesc',
    },
    {
      id: 'conventions',
      nameKey: 'aiCapSkillConventionsName',
      descKey: 'aiCapSkillConventionsDesc',
    },
    {
      id: 'global',
      nameKey: 'aiCapSkillGlobalName',
      descKey: 'aiCapSkillGlobalDesc',
    },
  ];

interface Props {
  onClose: () => void;
}

function AiCapabilitiesPanel(props: Props) {
  const { t } = useTranslation();
  const { onClose } = props;
  const { showNotification } = useNotificationContext();
  const [tab, setTab] = useState<'tools' | 'skills'>('tools');
  const [search, setSearch] = useState('');
  // re-render trigger after storage mutations
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  // tool editor state
  const [toolEditor, setToolEditor] = useState<Partial<CustomToolDef> | null>(
    null,
  );
  const [paramsText, setParamsText] = useState('{}');
  const [headersText, setHeadersText] = useState('');
  // skill editor state
  const [skillEditor, setSkillEditor] = useState<CustomSkillDef | null>(null);

  // Cheap catalog data — recomputed on every render (version bump forces it).
  const builtinTools = getBuiltinToolMetas();
  const customTools = getCustomTools();
  const customSkills = getCustomSkills();
  const disabledTools = new Set(getDisabledTools());

  const query = search.trim().toLowerCase();
  const matches = (text: string) =>
    !query || text.toLowerCase().includes(query);

  const builtinFiltered = builtinTools.filter(
    (tool) => matches(tool.name) || matches(tool.description),
  );
  const customToolsFiltered = customTools.filter(
    (tool) =>
      matches(tool.displayName) ||
      matches(tool.description) ||
      matches(tool.name),
  );
  const customSkillsFiltered = customSkills.filter(
    (s) => matches(s.name) || matches(s.instruction),
  );
  const builtinSkillsFiltered = BUILTIN_SKILLS.filter(
    (s) => matches(t(s.nameKey)) || matches(t(s.descKey)) || matches(s.id),
  );

  function saveTool() {
    if (!toolEditor) return;
    const displayName = (toolEditor.displayName || '').trim();
    const description = (toolEditor.description || '').trim();
    const url = (toolEditor.endpoint?.url || '').trim();
    if (!displayName || !description || !url) {
      showNotification(t('core:aiCapFillRequired'), 'warning');
      return;
    }
    let parameters: Record<string, any>;
    try {
      parameters = JSON.parse(paramsText || '{}');
    } catch (e) {
      showNotification(t('core:aiCapInvalidJson'), 'warning');
      return;
    }
    let headers: Record<string, string> | undefined;
    if (headersText.trim()) {
      try {
        headers = JSON.parse(headersText);
      } catch (e) {
        showNotification(t('core:aiCapInvalidJson'), 'warning');
        return;
      }
    }
    const id = toolEditor.id || `tool-${Date.now()}`;
    const name = toolEditor.name || sanitizeToolFunctionName(displayName);
    saveCustomTool({
      id,
      name,
      displayName,
      description,
      parameters,
      endpoint: { url, method: 'POST', headers },
      enabled: toolEditor.enabled !== false,
    });
    setToolEditor(null);
    bump();
  }

  function saveSkill() {
    if (!skillEditor) return;
    const name = (skillEditor.name || '').trim();
    const instruction = (skillEditor.instruction || '').trim();
    if (!name || !instruction) {
      showNotification(t('core:aiCapFillRequired'), 'warning');
      return;
    }
    saveCustomSkill({
      id: skillEditor.id || `skill-${Date.now()}`,
      name,
      instruction,
      enabled: skillEditor.enabled !== false,
    });
    setSkillEditor(null);
    bump();
  }

  async function testTool() {
    if (!toolEditor?.endpoint?.url) {
      showNotification(t('core:aiCapFillRequired'), 'warning');
      return;
    }
    const def: CustomToolDef = {
      id: 'test',
      name: 'test',
      displayName: toolEditor.displayName || 'test',
      description: toolEditor.description || '',
      parameters: {},
      endpoint: {
        url: toolEditor.endpoint.url,
        method: 'POST',
        ...(headersText.trim()
          ? {
              headers: (() => {
                try {
                  return JSON.parse(headersText);
                } catch (e) {
                  return undefined;
                }
              })(),
            }
          : {}),
      },
      enabled: true,
    };
    const result = await executeCustomTool(def, '{}');
    if (result.includes('"error"')) {
      showNotification(
        t('core:aiCapTestFailed', { message: result.slice(0, 160) }),
        'warning',
      );
    } else {
      showNotification(
        t('core:aiCapTestOk', { snippet: result.slice(0, 120) }),
        'info',
      );
    }
  }

  function renderToolRow(
    key: string,
    name: string,
    displayName: string,
    description: string,
    paramNames: string[],
    enabled: boolean,
    onToggle: (enabled: boolean) => void,
    onEdit?: () => void,
    onDelete?: () => void,
  ) {
    return (
      <Box
        key={key}
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 1,
          paddingY: 1,
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
            {name}
          </Typography>
          <Typography
            variant="caption"
            sx={{ display: 'block', color: 'text.secondary' }}
          >
            {description}
          </Typography>
          {paramNames.length > 0 && (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {t('core:aiCapParamsSummary')}: {paramNames.join(', ')}
            </Typography>
          )}
        </Box>
        {onEdit && (
          <IconButton
            size="small"
            onClick={onEdit}
            aria-label={t('core:aiCapEdit')}
          >
            <EditIcon fontSize="small" />
          </IconButton>
        )}
        {onDelete && (
          <IconButton
            size="small"
            onClick={onDelete}
            aria-label={t('core:aiCapDelete')}
          >
            <DeleteIcon fontSize="small" />
          </IconButton>
        )}
        <Switch
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          size="small"
        />
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
        px: 2,
        pt: 1,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Typography variant="h6">{t('core:aiCapabilitiesTitle')}</Typography>
        <Box sx={{ flexGrow: 1 }} />
        <IconButton
          aria-label={t('core:close')}
          onClick={onClose}
          size="small"
          data-tid="aiCapabilitiesCloseTID"
        >
          <CloseIcon />
        </IconButton>
      </Box>
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          flexGrow: 1,
          overflowY: 'auto',
          minHeight: 0,
        }}
      >
        <TextField
          size="small"
          placeholder={t('core:aiCapSearchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-tid="aiCapabilitiesSearchTID"
        />
        <Tabs
          value={tab}
          onChange={(e, v) => setTab(v)}
          sx={{ minHeight: 'auto' }}
        >
          <Tab value="tools" label={t('core:aiCapToolsTab')} />
          <Tab value="skills" label={t('core:aiCapSkillsTab')} />
        </Tabs>

        {tab === 'tools' && (
          <Box>
            <Button
              data-tid="aiCapabilitiesAddToolTID"
              variant="outlined"
              size="small"
              onClick={() => {
                setToolEditor({ enabled: true });
                setParamsText(
                  '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}',
                );
                setHeadersText('');
              }}
            >
              {t('core:aiCapAddTool')}
            </Button>
            <Typography variant="subtitle2" sx={{ marginTop: 1 }}>
              {t('core:aiCapCustomTools')}
            </Typography>
            {customToolsFiltered.length === 0 && (
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {t('core:aiCapEmpty')}
              </Typography>
            )}
            {customToolsFiltered.map((def) =>
              renderToolRow(
                def.id,
                `${def.name} (${def.displayName})`,
                def.displayName,
                def.description,
                Object.keys(def.parameters?.properties || {}),
                def.enabled,
                (enabled) => {
                  saveCustomTool({ ...def, enabled });
                  bump();
                },
                () => {
                  setToolEditor(def);
                  setParamsText(JSON.stringify(def.parameters, null, 2));
                  setHeadersText(
                    JSON.stringify(def.endpoint.headers || {}, null, 0),
                  );
                },
                () => {
                  deleteCustomTool(def.id);
                  bump();
                },
              ),
            )}
            <Typography variant="subtitle2" sx={{ marginTop: 2 }}>
              {t('core:aiCapBuiltinTools')}
            </Typography>
            {builtinFiltered.map((t2) =>
              renderToolRow(
                t2.name,
                t2.name,
                t2.name,
                t2.description,
                Object.keys(t2.parameters?.properties || {}),
                !disabledTools.has(t2.name),
                (enabled) => {
                  setToolEnabled(t2.name, enabled);
                  bump();
                },
              ),
            )}
          </Box>
        )}

        {tab === 'skills' && (
          <Box>
            <Button
              data-tid="aiCapabilitiesAddSkillTID"
              variant="outlined"
              size="small"
              onClick={() =>
                setSkillEditor({ enabled: true } as CustomSkillDef)
              }
            >
              {t('core:aiCapAddSkill')}
            </Button>
            <Typography variant="subtitle2" sx={{ marginTop: 1 }}>
              {t('core:aiCapCustomSkills')}
            </Typography>
            {customSkillsFiltered.length === 0 && (
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {t('core:aiCapEmpty')}
              </Typography>
            )}
            {customSkillsFiltered.map((def) =>
              renderToolRow(
                def.id,
                def.name,
                def.name,
                def.instruction,
                [],
                def.enabled,
                (enabled) => {
                  saveCustomSkill({ ...def, enabled });
                  bump();
                },
                () => setSkillEditor(def),
                () => {
                  deleteCustomSkill(def.id);
                  bump();
                },
              ),
            )}
            <Typography variant="subtitle2" sx={{ marginTop: 2 }}>
              {t('core:aiCapBuiltinSkills')}
            </Typography>
            {builtinSkillsFiltered.map((s) => (
              <Box
                key={s.id}
                sx={{
                  paddingY: 1,
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <Typography variant="body2">{t(s.nameKey)}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {t(s.descKey)}
                </Typography>
              </Box>
            ))}
          </Box>
        )}

        {tab === 'tools' && toolEditor && (
          <Box
            data-tid="aiCapabilitiesToolEditorTID"
            sx={{
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
              marginTop: 1,
              padding: 1,
              border: '1px solid',
              borderColor: 'divider',
            }}
          >
            <TextField
              size="small"
              label={t('core:aiCapToolDisplayName')}
              value={toolEditor.displayName || ''}
              onChange={(e) =>
                setToolEditor({
                  ...toolEditor,
                  displayName: e.target.value,
                  name: toolEditor.id
                    ? toolEditor.name
                    : sanitizeToolFunctionName(e.target.value),
                })
              }
            />
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {t('core:aiCapFunctionName')}: {toolEditor.name || '—'}
            </Typography>
            <TextField
              size="small"
              label={t('core:aiCapToolDesc')}
              value={toolEditor.description || ''}
              onChange={(e) =>
                setToolEditor({ ...toolEditor, description: e.target.value })
              }
            />
            <TextField
              size="small"
              label={t('core:aiCapToolUrl')}
              value={toolEditor.endpoint?.url || ''}
              onChange={(e) =>
                setToolEditor({
                  ...toolEditor,
                  endpoint: {
                    ...(toolEditor.endpoint || {}),
                    url: e.target.value,
                  },
                })
              }
            />
            <TextField
              size="small"
              multiline
              minRows={3}
              label={t('core:aiCapToolParams')}
              value={paramsText}
              onChange={(e) => setParamsText(e.target.value)}
            />
            <TextField
              size="small"
              multiline
              minRows={1}
              label={t('core:aiCapToolHeaders')}
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
            />
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
              <Button size="small" onClick={testTool}>
                {t('core:aiCapTest')}
              </Button>
              <Button size="small" onClick={() => setToolEditor(null)}>
                {t('core:aiCapCancel')}
              </Button>
              <Button
                size="small"
                variant="contained"
                onClick={saveTool}
                data-tid="aiCapabilitiesSaveToolTID"
              >
                {t('core:aiCapSave')}
              </Button>
            </Box>
          </Box>
        )}

        {tab === 'skills' && skillEditor && (
          <Box
            data-tid="aiCapabilitiesSkillEditorTID"
            sx={{
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
              marginTop: 1,
              padding: 1,
              border: '1px solid',
              borderColor: 'divider',
            }}
          >
            <TextField
              size="small"
              label={t('core:aiCapSkillName')}
              value={skillEditor.name || ''}
              onChange={(e) =>
                setSkillEditor({ ...skillEditor, name: e.target.value })
              }
            />
            <TextField
              size="small"
              multiline
              minRows={4}
              label={t('core:aiCapSkillInstruction')}
              value={skillEditor.instruction || ''}
              onChange={(e) =>
                setSkillEditor({ ...skillEditor, instruction: e.target.value })
              }
            />
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
              <Button size="small" onClick={() => setSkillEditor(null)}>
                {t('core:aiCapCancel')}
              </Button>
              <Button
                size="small"
                variant="contained"
                onClick={saveSkill}
                data-tid="aiCapabilitiesSaveSkillTID"
              >
                {t('core:aiCapSave')}
              </Button>
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
}

export default AiCapabilitiesPanel;
