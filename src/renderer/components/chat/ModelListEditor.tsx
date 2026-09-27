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
 * Per-provider model list editor (Settings → AI). Rows show every model of
 * the provider; each row has an instant live check (one minimal chat ping),
 * a "make current" action and a remove action. Adding happens only via
 * Enter or the + button — no blur commit, no persisted check results: a
 * verification is valid when you run it, never a stored conclusion.
 */
import { ReloadIcon } from '-/components/CommonIcons';
import { verifyProviderModel } from '-/components/chat/AiClient';
import { AIProvider } from '-/components/chat/ChatTypes';
import TsButton from '-/components/TsButton';
import TsIconButton from '-/components/TsIconButton';
import { useChatContext } from '-/hooks/useChatContext';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type VerifyResult = { ok: boolean; message?: string };

interface Props {
  provider: AIProvider;
  /** Effective model names: customModels plus the current defaultTextModel. */
  models: string[];
  /** Currently active model (provider.defaultTextModel). */
  currentModel?: string;
  disabled?: boolean;
  onAdd: (name: string) => void;
  onDelete: (name: string) => void;
  onSetCurrent: (name: string) => void;
}

function ModelListEditor(props: Props) {
  const { t } = useTranslation();
  const theme = useTheme();
  const {
    provider,
    models,
    currentModel,
    disabled,
    onAdd,
    onDelete,
    onSetCurrent,
  } = props;
  const { getAiClient } = useChatContext();
  const [input, setInput] = useState('');
  const [verifying, setVerifying] = useState<string | undefined>(undefined);
  // Ephemeral, never persisted — a check is only meaningful right now.
  const [results, setResults] = useState<Record<string, VerifyResult>>({});
  const [suggestions, setSuggestions] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    getAiClient(provider)
      .then((client) => (client ? client.list() : undefined))
      .then((list) => {
        if (active && list && list.length > 0) {
          setSuggestions(list.map((m) => m.name).filter(Boolean));
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [provider.url, provider.authKey]);

  const addModel = () => {
    const name = input.trim();
    if (!name) {
      return;
    }
    if (models.includes(name)) {
      setResults((prev) => ({
        ...prev,
        [name]: { ok: false, message: t('core:aiModelAddDuplicate') },
      }));
      return;
    }
    onAdd(name);
    setInput('');
  };

  const verifyModel = (name: string) => {
    if (verifying) {
      return;
    }
    setVerifying(name);
    verifyProviderModel(provider, name)
      .then((result) => {
        setResults((prev) => ({ ...prev, [name]: result }));
      })
      .finally(() => setVerifying(undefined));
  };

  const dotColor = (name: string) => {
    const result = results[name];
    if (!result) {
      return theme.palette.text.disabled;
    }
    return result.ok ? theme.palette.success.main : theme.palette.error.main;
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      {models.length === 0 && (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('core:aiModelListEmpty')}
        </Typography>
      )}
      {models.map((name) => {
        const result = results[name];
        const isCurrent = name === currentModel;
        return (
          <Box
            key={name}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              paddingY: 0.25,
            }}
          >
            <Tooltip
              title={
                result
                  ? result.ok
                    ? t('core:aiModelVerifyOkShort')
                    : `${result.message || ''} · ${t('core:aiModelVerifiedJustNow')}`
                  : t('core:aiModelNotVerified')
              }
            >
              <Box component="span" sx={{ display: 'inline-flex' }}>
                <FiberManualRecordIcon
                  sx={{ fontSize: 10, color: dotColor(name) }}
                />
              </Box>
            </Tooltip>
            <Box
              sx={{
                flexGrow: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                ...(isCurrent && { fontWeight: 600 }),
              }}
            >
              {name}
            </Box>
            <TsIconButton
              tooltip={t('core:aiModelVerifyOne')}
              disabled={disabled || !!verifying}
              onClick={() => verifyModel(name)}
              data-tid={`verifyModel-${name}`}
            >
              <ReloadIcon />
            </TsIconButton>
            <TsIconButton
              tooltip={
                isCurrent
                  ? t('core:aiModelIsCurrent')
                  : t('core:aiModelSetCurrent')
              }
              disabled={disabled || isCurrent}
              onClick={() => onSetCurrent(name)}
              data-tid={`setCurrentModel-${name}`}
            >
              {isCurrent ? (
                <StarIcon sx={{ color: 'primary.main' }} />
              ) : (
                <StarBorderIcon />
              )}
            </TsIconButton>
            <TsIconButton
              tooltip={t('core:deleteModel')}
              disabled={disabled}
              onClick={() => onDelete(name)}
              data-tid={`removeModel-${name}`}
            >
              <Typography sx={{ fontSize: 18, lineHeight: 1 }}>×</Typography>
            </TsIconButton>
          </Box>
        );
      })}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Autocomplete
          freeSolo
          disabled={disabled}
          openOnFocus
          options={suggestions.filter((s) => !models.includes(s))}
          inputValue={input}
          onInputChange={(event, value) => setInput(value)}
          onChange={(event, value) => {
            if (typeof value === 'string' && value.trim()) {
              setInput(value.trim());
            }
          }}
          renderInput={(params) => (
            <TextField
              {...params}
              fullWidth
              size="small"
              disabled={disabled}
              label={t('core:aiModelAddLabel')}
              placeholder={t('core:aiModelAddPlaceholder')}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addModel();
                }
              }}
            />
          )}
          sx={{ flexGrow: 1 }}
        />
        <TsButton
          variant="outlined"
          disabled={disabled || !input.trim()}
          onClick={addModel}
          data-tid="addProviderModelTID"
        >
          {t('core:aiModelAdd')}
        </TsButton>
      </Box>
    </Box>
  );
}

export default ModelListEditor;
