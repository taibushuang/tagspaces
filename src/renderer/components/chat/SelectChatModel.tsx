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

import {
  AIIcon,
  DownloadIcon,
  OllamaIcon,
  RemoveIcon,
} from '-/components/CommonIcons';
import TsIconButton from '-/components/TsIconButton';
import TsSelect from '-/components/TsSelect';
import { AIProvider } from '-/components/chat/ChatTypes';
import { useChatContext } from '-/hooks/useChatContext';
import { useNotificationContext } from '-/hooks/useNotificationContext';
import { getDefaultAIProvider } from '-/reducers/settings';
import {
  ListItemIcon,
  ListItemText,
  ListSubheader,
  MenuItem,
} from '@mui/material';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import { format, parseISO } from 'date-fns';
import { ModelResponse } from 'ollama';
import { ChangeEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSelector } from 'react-redux';

interface Props {
  id?: string;
  label?: string;
  disabled?: boolean;
  aiProvider: AIProvider;
  chosenModel: string;
  handleChangeModel: (newModelName: string) => void;
  /**
   * Settings → AI allows typing a custom model name (endpoints without a
   * usable /models listing). The chat/agent dialog dropdown is select-only:
   * it just switches between models the endpoint (or settings) already knows.
   */
  allowManualModelInput?: boolean;
}

function SelectChatModel(props: Props) {
  const { t } = useTranslation();
  const {
    id,
    label,
    aiProvider,
    chosenModel,
    handleChangeModel,
    disabled,
    allowManualModelInput = true,
  } = props;
  const { removeModel, getAiClient, models } = useChatContext();
  const { openConfirmDialog } = useNotificationContext();

  const defaultAiProvider: AIProvider = useSelector(getDefaultAIProvider);
  const [installedModels, setModels] = useState(
    aiProvider?.id === defaultAiProvider?.id ? models : [],
  );

  // Ollama supports in-app model download/delete; OpenAI-compatible servers
  // (LM Studio, llama.cpp, …) manage models externally, so those controls hide.
  const isOllama = aiProvider?.engine === 'ollama';

  useEffect(() => {
    if (aiProvider) {
      getAiClient(aiProvider).then((client) => {
        if (!client) {
          return;
        }
        client.list().then((m) => {
          if (!m || JSON.stringify(m) !== JSON.stringify(installedModels)) {
            setModels(m ? m : []);
          }
        });
      });
    }
  }, [aiProvider, models]);

  const ollamaAvailableModels: ModelResponse[] = [
    {
      name: 'llama3.1',
      model: 'llama3.1',
      modified_at: new Date(),
      size: 1,
      digest: '',
      expires_at: new Date(),
      size_vram: 0,
      details: {
        family: 'ollama',
        format:
          '4,6 GB. The largest language model from Meta, featuring 405 billion parameters. It is one of the leading open-source AI models, capable of understanding and processing information deeply and diversely',
        parent_model: 'ollama',
        families: ['ollama'],
        parameter_size: '',
        quantization_level: '',
      },
    },
    {
      name: 'llama3.2',
      model: 'llama3.2',
      modified_at: new Date(),
      size: 1,
      digest: '',
      expires_at: new Date(),
      size_vram: 0,
      details: {
        family: 'ollama',
        format:
          'new 1B and 3B lightweight models are designed for seamless integration on mobile and edge devices. With these models, you can build private, personalized AI experiences with minimal latency and resource overhead.',
        parent_model: 'ollama',
        families: ['ollama'],
        parameter_size: '',
        quantization_level: '',
      },
    },
    {
      name: 'llama3.2-vision:11b',
      model: 'llama3.2-vision:11b',
      modified_at: new Date(),
      size: 1,
      digest: '',
      expires_at: new Date(),
      size_vram: 0,
      details: {
        family: 'ollama',
        format: 'requires least 8GB of RAM.',
        parent_model: 'ollama',
        families: ['ollama'],
        parameter_size: '',
        quantization_level: '',
      },
    },
    {
      name: 'gemma2',
      model: 'gemma2',
      modified_at: new Date(),
      size: 1,
      digest: '',
      expires_at: new Date(),
      size_vram: 0,
      details: {
        family: 'ollama',
        format:
          "5,4 GB. One of GEMMA2's standout features is its ability to handle and integrate multiple data modalities. Traditional AI models often specialise in a single type of data — text, images, or audio. GEMMA2, however, can process and synthesise information from all these sources simultaneously.",
        parent_model: 'ollama',
        families: ['ollama'],
        parameter_size: '',
        quantization_level: '',
      },
    },
    {
      name: 'llava',
      model: 'llava',
      modified_at: new Date(),
      size: 1,
      digest: '',
      expires_at: new Date(),
      size_vram: 0,
      details: {
        family: 'ollama',
        format:
          'large multimodal model that is designed to understand and generate content based on both visual inputs (images) and textual instructions.',
        parent_model: 'ollama',
        families: ['ollama'],
        parameter_size: '',
        quantization_level: '',
      },
    },
  ];

  const changeModel = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.value === 'customModel') {
      openConfirmDialog(
        t('core:downloadChatModel'),
        undefined,
        (result) => {
          if (result && typeof result === 'string') {
            handleChangeModel(result);
          }
        },
        'cancelInstallCustomModel',
        'confirmInstallCustomModel',
        'confirmCustomModelContent',
        undefined,
        t('core:model'),
        'E.g.: llama3.2:1b, further models available on ollama.com/search',
        t('core:startDownload'),
        t('core:cancel'),
      );
    } else {
      handleChangeModel(event.target.value);
    }
  };

  const handleRemoveModel = () => {
    removeModel(chosenModel);
  };

  // OpenAI-compatible engines: explicit-commit manual input (Enter or select
  // from the endpoint's model list — no blur commit, no shadow memory list;
  // per-provider multi-model lists live in provider.customModels).
  const [manualInput, setManualInput] = useState(chosenModel || '');
  useEffect(() => {
    setManualInput(chosenModel || '');
  }, [chosenModel]);

  if (!isOllama && allowManualModelInput) {
    const modelNames = Array.from(
      new Set<string>(
        (installedModels || []).map((m) => m.name).filter(Boolean),
      ),
    );
    const commitModel = (name: string) => {
      const trimmed = (name || '').trim();
      if (trimmed && trimmed !== chosenModel) {
        handleChangeModel(trimmed);
      }
    };
    return (
      <Autocomplete
        freeSolo
        disabled={disabled}
        disableClearable
        openOnFocus
        options={modelNames}
        inputValue={manualInput}
        onInputChange={(event, value) => setManualInput(value)}
        onChange={(event, value) => {
          if (typeof value === 'string' && value.trim()) {
            commitModel(value);
          }
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            label={label ? label : ''}
            placeholder={t('core:enterModelNameDescription')}
            variant="outlined"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && manualInput.trim()) {
                commitModel(manualInput);
                (event.target as HTMLInputElement).blur();
              }
            }}
          />
        )}
        id={id ? id : 'selectChatModelId'}
        sx={{ '& .MuiInputBase-root': { padding: '0px' } }}
      />
    );
  }

  function getTitle(model) {
    // OpenAI-compatible servers don't report a modified date.
    return model && model.modified_at
      ? format(parseISO(model.modified_at), 'yyyy-MM-dd')
      : '';
  }

  return (
    <TsSelect
      disabled={disabled}
      value={chosenModel ? chosenModel : 'init'}
      onChange={changeModel}
      sx={{ '& .MuiSelect-select': { padding: '4px' } }}
      label={label ? label : ''}
      id={id ? id : 'selectChatModelId'}
      slotProps={{
        input: {
          endAdornment: chosenModel && isOllama && (
            <InputAdornment
              position="end"
              sx={{ marginLeft: '-30px', marginRight: '10px' }}
            >
              <TsIconButton
                aria-label={t('core:deleteModel')}
                onClick={handleRemoveModel}
                data-tid="deleteModelTID"
              >
                <RemoveIcon fontSize="small" />
              </TsIconButton>
            </InputAdornment>
          ),
        },
      }}
    >
      <MenuItem value="init" disabled>
        {t('core:chooseModel')}
      </MenuItem>
      <ListSubheader>{t('core:installedAIModels')}</ListSubheader>
      {installedModels && installedModels.length > 0 ? (
        installedModels.map((model) => (
          <MenuItem key={model.name} value={model.name} title={getTitle(model)}>
            <ListItemIcon
              sx={{
                display: 'inline-block',
                minWidth: '30px',
                paddingLeft: '3px',
              }}
            >
              {isOllama ? (
                <OllamaIcon
                  sx={{
                    width: '24px',
                    height: '24px',
                    verticalAlign: 'middle',
                  }}
                />
              ) : (
                <AIIcon
                  sx={{
                    width: '24px',
                    height: '24px',
                    verticalAlign: 'middle',
                  }}
                />
              )}
            </ListItemIcon>
            <ListItemText
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              {model.name}
              {model.size > 0 &&
                ' ' + (model.size / (1024 * 1024 * 1024)).toFixed(2) + ' GB'}
            </ListItemText>
          </MenuItem>
        ))
      ) : !isOllama && (aiProvider?.customModels || []).length > 0 ? null : (
        <MenuItem value="" disabled>
          {t('core:noAIModelsInstaller')}
        </MenuItem>
      )}
      {!isOllama &&
        (aiProvider?.customModels || [])
          .filter(
            (name) =>
              name &&
              !(installedModels || []).some((m) => m.name === name) &&
              name !== chosenModel,
          )
          .map((name) => (
            <MenuItem key={name} value={name}>
              <ListItemIcon
                sx={{
                  display: 'inline-block',
                  minWidth: '30px',
                  paddingLeft: '3px',
                }}
              >
                <AIIcon
                  sx={{
                    width: '24px',
                    height: '24px',
                    verticalAlign: 'middle',
                  }}
                />
              </ListItemIcon>
              <ListItemText
                sx={{ display: 'inline-flex', alignItems: 'center' }}
              >
                {name}
              </ListItemText>
            </MenuItem>
          ))}
      {!isOllama &&
        chosenModel &&
        !(installedModels || []).some((m) => m.name === chosenModel) &&
        !(aiProvider?.customModels || []).includes(chosenModel) && (
          <MenuItem value={chosenModel}>
            <ListItemIcon
              sx={{
                display: 'inline-block',
                minWidth: '30px',
                paddingLeft: '3px',
              }}
            >
              <AIIcon
                sx={{ width: '24px', height: '24px', verticalAlign: 'middle' }}
              />
            </ListItemIcon>
            <ListItemText sx={{ display: 'inline-flex', alignItems: 'center' }}>
              {chosenModel}
            </ListItemText>
          </MenuItem>
        )}
      {isOllama && (
        <ListSubheader>{t('core:exampleInstallableModels')}</ListSubheader>
      )}
      {isOllama &&
        ollamaAvailableModels.map((model) => (
          <MenuItem
            key={model.name}
            value={model.name}
            title={model.details.format}
          >
            <ListItemIcon>
              <DownloadIcon />
            </ListItemIcon>
            {model.name}
          </MenuItem>
        ))}
      {isOllama && <ListSubheader>{t('core:moreActions')}</ListSubheader>}
      {isOllama && (
        <MenuItem value="customModel">
          <ListItemIcon>
            <DownloadIcon />
          </ListItemIcon>
          {t('core:installCustomModel')}
        </MenuItem>
      )}
    </TsSelect>
  );
}

export default SelectChatModel;
