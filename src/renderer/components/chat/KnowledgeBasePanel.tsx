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
 * AI knowledge base panel: built-in reference articles plus the per-folder
 * knowledge base stored in `<location>/.ts/ai/kb/*.md` (the same files the
 * agent reads and writes via its knowledge base tools). Markdown is rendered
 * with `marked`; user entries are edited as plain markdown text.
 */
import { marked } from 'marked';
import {
  deleteLocationKbFile,
  getKnowledgeEntries,
  isBuiltInEntry,
  listLocationKb,
  writeLocationKb,
  type KBEntry,
} from '-/services/knowledgeBase';
import { useCurrentLocationContext } from '-/hooks/useCurrentLocationContext';
import { useNotificationContext } from '-/hooks/useNotificationContext';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import DeleteIcon from '@mui/icons-material/DeleteOutlineOutlined';
import EditIcon from '@mui/icons-material/EditOutlined';
import AddIcon from '@mui/icons-material/AddOutlined';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type EditorState = {
  existingId?: string;
  title: string;
  content: string;
} | null;

function KnowledgeBasePanel() {
  const { t } = useTranslation();
  const { showNotification } = useNotificationContext();
  const { locations, findLocation, findLocationByPath } =
    useCurrentLocationContext();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [editor, setEditor] = useState<EditorState>(null);
  const [version, setVersion] = useState(0);

  const currentLocation = findLocation();
  const [locationUuid, setLocationUuid] = useState<string | undefined>(
    currentLocation?.uuid,
  );

  const kbLocation = useMemo(
    () =>
      locations.find((l) => l.uuid === locationUuid) ||
      currentLocation ||
      locations[0] ||
      undefined,
    [locations, locationUuid, currentLocation],
  );

  const [locationEntries, setLocationEntries] = useState<KBEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!kbLocation) {
      setLocationEntries([]);
      return () => {};
    }
    setLoading(true);
    listLocationKb(kbLocation)
      .then((entries) => {
        if (!cancelled) setLocationEntries(entries);
      })
      .catch(() => {
        if (!cancelled) setLocationEntries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kbLocation, version]);

  const builtinEntries = useMemo(
    () => (kbLocation ? getKnowledgeEntries() : getKnowledgeEntries()),
    [version],
  );
  const allEntries: KBEntry[] = [...builtinEntries, ...locationEntries];

  const query = search.trim().toLowerCase();
  const filtered = allEntries.filter(
    (e) =>
      !query ||
      e.title.toLowerCase().includes(query) ||
      e.content.toLowerCase().includes(query),
  );
  const selected = allEntries.find((e) => e.id === selectedId) || filtered[0];

  const html = selected
    ? (marked.parse(selected.content, { async: false }) as string)
    : '';

  function handleSave() {
    if (!editor || !kbLocation) return;
    const title = editor.title.trim();
    const content = editor.content.trim();
    if (!title || !content) {
      showNotification(t('core:aiCapFillRequired'), 'warning');
      return;
    }
    writeLocationKb(kbLocation, title, content, editor.existingId)
      .then((saved) => {
        setSelectedId(saved.id);
        setEditor(null);
        setVersion((v) => v + 1);
      })
      .catch((e) => showNotification(String(e), 'warning'));
  }

  function handleDelete(id: string) {
    if (!kbLocation) return;
    deleteLocationKbFile(kbLocation, id)
      .then(() => {
        if (selectedId === id) setSelectedId(undefined);
        setVersion((v) => v + 1);
      })
      .catch((e) => showNotification(String(e), 'warning'));
  }

  return (
    <Box sx={{ display: 'flex', height: '100%', minHeight: 0, gap: 1 }}>
      <Box
        sx={{
          width: 220,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          borderRight: '1px solid',
          borderColor: 'divider',
          paddingRight: 1,
        }}
      >
        <TextField
          select
          size="small"
          label={t('core:aiKbLocation')}
          value={kbLocation?.uuid || ''}
          onChange={(e) => setLocationUuid(e.target.value)}
          data-tid="aiKbLocationTID"
        >
          {locations.map((l) => (
            <MenuItem key={l.uuid} value={l.uuid}>
              {l.name}
            </MenuItem>
          ))}
        </TextField>
        <Button
          variant="outlined"
          size="small"
          startIcon={<AddIcon />}
          data-tid="aiKbAddTID"
          disabled={!kbLocation}
          onClick={() => setEditor({ title: '', content: '' })}
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
                secondary={
                  isBuiltInEntry(entry.id) ? t('core:aiKbBuiltIn') : undefined
                }
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
                        existingId: selected.id,
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
              {selected.updatedAt
                ? new Date(selected.updatedAt).toLocaleString()
                : ''}
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
            {loading ? '…' : t('core:aiKbEmpty')}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

export default KnowledgeBasePanel;
