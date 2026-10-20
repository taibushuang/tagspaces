/**
 * Import skills from other agent clients (Qwenpaw / Claude Code / …) found
 * on this machine: scans the default + user-registered skill directories,
 * lets the user pick skills and register additional directories, then saves
 * the selection as TagSpaces custom skills.
 */

import React, { useEffect, useState } from 'react';
import TsButton from '-/components/TsButton';
import TsDialogActions from '-/components/dialogs/components/TsDialogActions';
import TsDialogTitle from '-/components/dialogs/components/TsDialogTitle';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useTranslation } from 'react-i18next';
import {
  importedSkillId,
  saveCustomSkill,
} from '-/components/chat/agentCapabilities';

type ScannedSkill = {
  dir: string;
  name: string;
  description: string;
  instruction: string;
  truncated: boolean;
  sizeBytes: number;
};

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}

function ImportSkillsDialog({ open, onClose, onImported }: Props) {
  const { t } = useTranslation();
  const [skills, setSkills] = useState<ScannedSkill[]>([]);
  const [extraDirs, setExtraDirs] = useState<string[]>([]);
  const [defaultDirs, setDefaultDirs] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [newDir, setNewDir] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toolServers, setToolServers] = useState<
    Array<{
      name: string;
      transport: string;
      sourceFile: string;
      detail: string;
    }>
  >([]);

  async function scan(options: { addDir?: string; removeDir?: string } = {}) {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronIO.ipcRenderer.invoke(
        'skillsScan',
        options,
      );
      setSkills(result.skills || []);
      setExtraDirs(result.extraDirs || []);
      setDefaultDirs(result.defaultDirs || []);
      setToolServers(result.toolServers || []);
      // keep selection only for skills still present
      setSelected((prev) => {
        const present = new Set((result.skills || []).map((s) => s.dir));
        const next = new Set([...prev].filter((d) => present.has(d)));
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) {
      scan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function toggle(dir: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  }

  async function handleImport() {
    const dirs = [...selected];
    for (const dir of dirs) {
      try {
        // Main process copies the WHOLE skill folder and returns the
        // transformed draft (with the supporting-files note attached).
        const skill = await window.electronIO.ipcRenderer.invoke(
          'skillsImportDir',
          dir,
        );
        saveCustomSkill({
          id: importedSkillId(skill.name, dir),
          name: skill.name,
          instruction: skill.instruction,
          enabled: true,
          sourceDir: dir,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    setSelected(new Set());
    onImported();
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      keepMounted
      scroll="paper"
      fullWidth
      maxWidth="sm"
    >
      <TsDialogTitle
        dialogTitle={t('core:skillImportTitle')}
        closeButtonTestId="closeSkillImportTID"
        onClose={onClose}
      />
      <DialogContent>
        <Typography variant="caption" color="text.secondary">
          {t('core:skillImportHint')}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, mt: 1, alignItems: 'center' }}>
          <TextField
            size="small"
            fullWidth
            placeholder={t('core:skillImportAddDirPlaceholder')}
            value={newDir}
            onChange={(e) => setNewDir(e.target.value)}
            data-tid="skillImportAddDir"
          />
          <TsButton
            size="small"
            disabled={!newDir.trim()}
            onClick={() => {
              scan({ addDir: newDir.trim() });
              setNewDir('');
            }}
            data-tid="skillImportAddDirButton"
          >
            {t('core:skillImportAddDir')}
          </TsButton>
          <IconButton
            size="small"
            onClick={() => scan()}
            data-tid="skillImportRescan"
          >
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Box>
        {extraDirs.length > 0 && (
          <Typography variant="caption" color="text.secondary">
            {t('core:skillImportExtraDirs')}
            {extraDirs.map((d) => (
              <Box key={d} component="span" sx={{ display: 'block' }}>
                {d}
                <IconButton
                  size="small"
                  sx={{ ml: 0.5 }}
                  onClick={() => scan({ removeDir: d })}
                  data-tid="skillImportRemoveDir"
                >
                  <DeleteOutlineOutlinedIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Box>
            ))}
          </Typography>
        )}
        {error && (
          <Typography variant="body2" color="error">
            {error}
          </Typography>
        )}
        {toolServers.length > 0 && (
          <Box sx={{ mt: 1 }}>
            <Typography variant="subtitle2">
              {t('core:skillImportToolsTitle')}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {t('core:skillImportToolsHint')}
            </Typography>
            {toolServers.map((t2) => (
              <Typography
                key={`${t2.sourceFile}::${t2.name}`}
                variant="caption"
                component="div"
                color="text.secondary"
              >
                • {t2.name} [{t2.transport}] — {t2.detail}
              </Typography>
            ))}
          </Box>
        )}
        <List dense sx={{ maxHeight: 320, overflowY: 'auto' }}>
          {loading && (
            <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
              {t('core:skillImportScanning')}
            </Typography>
          )}
          {!loading && skills.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
              {t('core:skillImportEmpty')}
            </Typography>
          )}
          {skills.map((skill) => (
            <ListItem
              key={skill.dir}
              dense
              onClick={() => toggle(skill.dir)}
              data-tid={`skillImportItem-${skill.name}`}
            >
              <ListItemIcon sx={{ minWidth: 36 }}>
                <Checkbox
                  size="small"
                  checked={selected.has(skill.dir)}
                  sx={{ p: 0.5 }}
                />
              </ListItemIcon>
              <ListItemText
                primary={skill.name}
                secondary={
                  <>
                    <Typography variant="caption" component="div" noWrap>
                      {skill.description}
                    </Typography>
                    <Typography variant="caption" color="text.disabled">
                      {skill.dir}
                      {skill.truncated ? ' · truncated' : ''}
                    </Typography>
                  </>
                }
              />
            </ListItem>
          ))}
        </List>
        {defaultDirs.length > 0 && (
          <Typography variant="caption" color="text.disabled">
            {t('core:skillImportDefaultDirs')}
            {defaultDirs.join(' ; ')}
          </Typography>
        )}
      </DialogContent>
      <TsDialogActions>
        <TsButton onClick={onClose}>{t('core:cancel')}</TsButton>
        <TsButton
          variant="contained"
          disabled={selected.size === 0}
          onClick={handleImport}
          data-tid="skillImportConfirmTID"
        >
          {t('core:skillImportConfirm', { count: selected.size })}
        </TsButton>
      </TsDialogActions>
    </Dialog>
  );
}

export default ImportSkillsDialog;
