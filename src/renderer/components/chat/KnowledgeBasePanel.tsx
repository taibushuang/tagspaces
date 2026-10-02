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
 * AI knowledge base panel: browse/search articles about the agent's tools
 * and skills (built-in, live content), read and author user entries.
 * Markdown is rendered with `marked`; editing uses a plain textarea.
 */
import { marked } from 'marked';
import {
  deleteKnowledgeEntry,
  getKnowledgeEntries,
  isBuiltInEntry,
  saveKnowledgeEntry,
  type KBEntry,
} from '-/services/knowledgeBase';
import { useNotificationContext } from '-/hooks/useNotificationContext';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import DeleteIcon from '@mui/icons-material/DeleteOutlineOutlined';
import EditIcon from '@mui/icons-material/EditOutlined';
import AddIcon from '@mui/icons-material/AddOutlined';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type EditorState = { id?: string; title: string; content: string } | null;

function KnowledgeBasePanel() {
  const { t } = useTranslation();
  const { showNotification } = useNotificationContext();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | undefined>(
    'builtin-tools-vs-skills',
  );
  const [editor, setEditor] = useState<EditorState>(null);
  const [version, setVersion] = useState(0);

  const entries = useMemo(() => getKnowledgeEntries(), [version]);
  const query = search.trim().toLowerCase();
  const filtered = entries.filter(
    (e) =>
      !query ||
      e.title.toLowerCase().includes(query) ||
      e.content.toLowerCase().includes(query),
  );
  const selected = entries.find((e) => e.id === selectedId) || filtered[0];

  function handleSave() {
    if (!editor) return;
    const title = editor.title.trim();
    const content = editor.content.trim();
    if (!title || !content) {
      showNotification(t('core:aiCapFillRequired'), 'warning');
      return;
    }
    const saved = saveKnowledgeEntry({ id: editor.id, title, content });
    setSelectedId(saved.id);
    setEditor(null);
    setVersion((v) => v + 1);
  }

  function handleDelete(id: string) {
    deleteKnowledgeEntry(id);
    if (selectedId === id) setSelectedId(undefined);
    setVersion((v) => v + 1);
  }

  const html = selected
    ? (marked.parse(selected.content, { async: false }) as string)
    : '';

  return (
    <Box sx={{ display: 'flex', height: '100%', minHeight: 0, gap: 1 }}>
      <Box
        sx={{
          width: 200,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          borderRight: '1px solid',
          borderColor: 'divider',
          paddingRight: 1,
        }}
      >
        <Button
          variant="outlined"
          size="small"
          startIcon={<AddIcon />}
          data-tid="aiKbAddTID"
          onClick={() => {
            setEditor({ title: '', content: '' });
          }}
        >
          {t('core:aiKbNew')}
        </Button>
        <TextField
          size="small"
          placeholder={t('core:aiKbSearch')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-tid="aiKbSearchTID"
        />
        <List dense sx={{ overflowY: 'auto', flexGrow: 1, padding: 0 }}>
          {filtered.map((entry) => (
            <ListItemButton
              key={entry.id}
              selected={selected?.id === entry.id}
              onClick={() => {
                setSelectedId(entry.id);
                setEditor(null);
              }}
              sx={{ borderRadius: 1 }}
            >
              <ListItemText
                primary={entry.title}
                secondary={entry.builtIn ? t('core:aiKbBuiltIn') : undefined}
                slotProps={{
                  primary: { variant: 'body2', noWrap: true } as any,
                }}
              />
            </ListItemButton>
          ))}
        </List>
      </Box>
      <Box
        sx={{
          flexGrow: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {editor ? (
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
              height: '100%',
            }}
          >
            <TextField
              size="small"
              label={t('core:aiKbTitle')}
              value={editor.title}
              onChange={(e) => setEditor({ ...editor, title: e.target.value })}
            />
            <TextField
              multiline
              minRows={12}
              fullWidth
              label={t('core:aiKbContent')}
              value={editor.content}
              onChange={(e) =>
                setEditor({ ...editor, content: e.target.value })
              }
              sx={{
                flexGrow: 1,
                '& .MuiInputBase-root': {
                  height: '100%',
                  alignItems: 'flex-start',
                },
              }}
            />
            <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
              <Button size="small" onClick={() => setEditor(null)}>
                {t('core:aiCapCancel')}
              </Button>
              <Button
                size="small"
                variant="contained"
                onClick={handleSave}
                data-tid="aiKbSaveTID"
              >
                {t('core:aiCapSave')}
              </Button>
            </Box>
          </Box>
        ) : selected ? (
          <Box
            sx={{ overflowY: 'auto', height: '100%' }}
            data-tid="aiKbViewerTID"
          >
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <Typography variant="h6">{selected.title}</Typography>
              {!isBuiltInEntry(selected.id) && (
                <Box>
                  <IconButton
                    size="small"
                    aria-label={t('core:aiCapEdit')}
                    onClick={() =>
                      setEditor({
                        id: selected.id,
                        title: selected.title,
                        content: selected.content,
                      })
                    }
                  >
                    <EditIcon fontSize="small" />
                  </IconButton>
                  <IconButton
                    size="small"
                    aria-label={t('core:aiCapDelete')}
                    onClick={() => handleDelete(selected.id)}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Box>
              )}
            </Box>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {new Date(selected.updatedAt).toLocaleString()}
            </Typography>
            <div
              className="ai-kb-markdown"
              // Local, user-authored content only (same trust level as the
              // editor); marked is used read-only for rendering.
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </Box>
        ) : (
          <Typography sx={{ margin: 'auto', color: 'text.secondary' }}>
            {t('core:aiKbEmpty')}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

export default KnowledgeBasePanel;
