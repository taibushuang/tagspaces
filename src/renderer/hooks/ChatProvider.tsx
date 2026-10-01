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

import AppConfig from '-/AppConfig';
import { AgentEvent, runAgent } from '-/components/chat/AgentService';
import { createAgentTools } from '-/components/chat/AgentTools';
import { loadLocationConventions } from '-/components/chat/locationConventions';
import {
  AIProvider,
  ChatImage,
  ChatItem,
  ChatMode,
  ChatRole,
  HistoryModel,
  PullModelResponse,
} from '-/components/chat/ChatTypes';
import {
  AiClient,
  checkProviderAlive as checkAiProviderAlive,
  getAiClient,
} from '-/components/chat/AiClient';
import { generateOptionType } from '-/components/dialogs/hooks/AiGenerationDialogContextProvider';
import { useFileUploadDialogContext } from '-/components/dialogs/hooks/useFileUploadDialogContext';
import { TabNames } from '-/hooks/EntryPropsTabsContextProvider';
import { useCurrentLocationContext } from '-/hooks/useCurrentLocationContext';
import { useDirectoryContentContext } from '-/hooks/useDirectoryContentContext';
import { useEditedTagLibraryContext } from '-/hooks/useEditedTagLibraryContext';
import { useLocationIndexContext } from '-/hooks/useLocationIndexContext';
import { useIOActionsContext } from '-/hooks/useIOActionsContext';
import { useNotificationContext } from '-/hooks/useNotificationContext';
import { useOpenedEntryContext } from '-/hooks/useOpenedEntryContext';
import { usePlatformFacadeContext } from '-/hooks/usePlatformFacadeContext';
import { useSelectedEntriesContext } from '-/hooks/useSelectedEntriesContext';
import { useTaggingActionsContext } from '-/hooks/useTaggingActionsContext';
import { Pro } from '-/pro';
import { actions as AppActions, AppDispatch } from '-/reducers/app';
import {
  actions as SettingsActions,
  getAIProviders,
  getDefaultAIProvider,
  getCurrentLanguage,
  getEntryContainerTab,
  getTagColor,
  getTagTextColor,
} from '-/reducers/settings';
import { getTagColors } from '-/services/taglibrary-utils';
import { extractPDFcontent } from '-/services/thumbsgenerator';
import { toBase64Image } from '-/services/utils-io';
import {
  StructuredDataProps,
  getZodDescription,
  getZodTags,
} from '-/services/zodObjects';
import { TS } from '-/tagspaces.namespace';
import useFirstRender from '-/utils/useFirstRender';
import { formatDateTime } from '@tagspaces/tagspaces-common/misc';
import {
  extractFileExtension,
  getMetaDirectoryPath,
} from '@tagspaces/tagspaces-common/paths';
import {
  extractTextContent,
  getUuid,
  loadJSONString,
} from '@tagspaces/tagspaces-common/utils-io';
import { format } from 'date-fns';
import { ChatRequest, ModelResponse } from 'ollama';
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { zodToJsonSchema } from 'zod-to-json-schema';

/*export type TimelineItem = {
  request: string;
  response?: string;
};*/

type ChatData = {
  models: ModelResponse[];
  images: ChatImage[];
  currentModel: ModelResponse;
  chatHistoryItems: ChatItem[];
  isTyping: boolean;
  checkOllamaModels: () => Promise<boolean>;
  refreshOllamaModels: (modelName?: string) => Promise<boolean>;
  setModel: (model: ModelResponse | string) => Promise<boolean>;
  setImages: (imagesPaths: string[]) => void;
  removeImage: (uuid: string) => void;
  unloadCurrentModel: () => void;
  removeModel: (modelName: string) => void;
  findModel: (modelName: string) => ModelResponse;
  getHistoryFilePath: (name?: string) => string;
  changeCurrentModel: (
    newModelName: string,
    confirmCallback?: () => void,
  ) => Promise<boolean>;
  getModel: (modelName: string) => Promise<ModelResponse>;
  addChatHistory: (txt: string, replace?: boolean) => ChatItem[];
  newChatMessage: (
    msg?: string,
    unload?: boolean,
    role?: ChatRole,
    mode?: ChatMode,
    model?: string,
    stream?: boolean,
    images?: string[],
    includeHistory?: boolean,
  ) => Promise<any>;
  cancelMessage: () => void;
  generate: (
    fileContent: 'text' | 'image',
    mode: ChatMode,
    modelName: string,
    entry: TS.FileSystemEntry,
  ) => Promise<string>;
  initHistory: () => void;
  deleteHistory: () => Promise<boolean>;
  checkProviderAlive: (provider: AIProvider) => Promise<boolean>;
  getAiClient: (provider: AIProvider) => Promise<AiClient>;
  getEntryModel: (entryName: string, aiProvider: AIProvider) => ModelResponse;
  tagsGenerate: (
    entry: TS.FileSystemEntry,
    fromDescription?: boolean,
  ) => Promise<boolean>;
  descriptionGenerate: (
    entry: TS.FileSystemEntry,
  ) => Promise<TS.FileSystemEntry>;
  generationSettings: GenerationSettings;
  setGenerationSettings: (genSettings: any) => void;
  resetGenerationSettings: (option: generateOptionType) => void;
  /** Agent mode: chat requests run the tool-calling loop. */
  agentMode: boolean;
  setAgentMode: (enabled: boolean) => void;
  newAgentMessage: (msg: string) => Promise<any>;
};

export const ChatContext = createContext<ChatData>({
  //timelineItems: [],
  models: [],
  images: [],
  currentModel: undefined,
  //openedEntryModel: undefined,
  chatHistoryItems: [],
  isTyping: false,
  checkOllamaModels: undefined,
  refreshOllamaModels: undefined,
  setModel: undefined,
  setImages: undefined,
  removeImage: undefined,
  unloadCurrentModel: undefined,
  removeModel: undefined,
  findModel: undefined,
  getHistoryFilePath: undefined,
  changeCurrentModel: undefined,
  getModel: undefined,
  addChatHistory: undefined,
  newChatMessage: undefined,
  cancelMessage: undefined,
  generate: undefined,
  initHistory: undefined,
  deleteHistory: undefined,
  checkProviderAlive: undefined,
  getAiClient: undefined,
  getEntryModel: undefined,
  tagsGenerate: undefined,
  descriptionGenerate: undefined,
  generationSettings: undefined,
  setGenerationSettings: undefined,
  resetGenerationSettings: undefined,
  agentMode: false,
  setAgentMode: undefined,
  newAgentMessage: undefined,
});

export type ChatContextProviderProps = {
  children: React.ReactNode;
};

export type GenerationSettings = {
  option: generateOptionType;
  maxTags: number;
  maxChars: number;
  tagsFromLibrary: boolean;
  tagGroupsIds: string[];
  fromDescription: boolean;
  structuredDataProps: StructuredDataProps;
  appendToDescription: boolean;
  appendAnalysisToDescription: boolean;
  language: string;
};

export const ChatContextProvider = ({ children }: ChatContextProviderProps) => {
  const { t } = useTranslation();
  const { showNotification } = useNotificationContext();
  const {
    deleteDirectory,
    setDescriptionChange,
    moveFiles,
    saveTextFilePromise,
  } = useIOActionsContext();
  const { addTagsToFsEntry, removeTagsFromEntry } = useTaggingActionsContext();
  const { agentSearch, getIndex, findEntry, listChildren } =
    useLocationIndexContext();
  const { currentDirectoryPath } = useDirectoryContentContext();
  const { tagGroups } = useEditedTagLibraryContext();
  const { openFileUploadDialog } = useFileUploadDialogContext();
  const { selectedEntries } = useSelectedEntriesContext();
  const { findLocation, findLocationByPath, locations } =
    useCurrentLocationContext();
  const { saveFilePromise, deleteEntriesPromise } = usePlatformFacadeContext();
  const { openedEntry } = useOpenedEntryContext();
  const models = useRef<ModelResponse[]>([]);
  const defaultAiProvider: AIProvider = useSelector(getDefaultAIProvider);
  const aiProviders: AIProvider[] = useSelector(getAIProviders);
  const interfaceLanguage = useSelector(getCurrentLanguage);
  const selectedTabName = useSelector(getEntryContainerTab);
  const defaultBackgroundColor = useSelector(getTagColor);
  const defaultTextColor = useSelector(getTagTextColor);
  const currentModel = useRef<ModelResponse>(undefined);
  const generationSettings = useRef<GenerationSettings>(
    getGenerationSettings(),
  );
  const images = useRef<ChatImage[]>([]);
  const chatHistoryItems = useRef<ChatItem[]>([]);
  const aiTemplatesContext = Pro?.contextProviders?.AiTemplatesContext
    ? useContext<TS.AiTemplatesContextData>(
        Pro.contextProviders.AiTemplatesContext,
      )
    : undefined;
  const isTyping = useRef<boolean>(false);
  const aiClient = useRef<AiClient>(undefined);
  const agentAbortController = useRef<AbortController>(undefined);
  const lastProviderId = useRef<string>(defaultAiProvider?.id);
  const [agentMode, setAgentModeState] = useReducer(
    (state: boolean, enabled: boolean) => {
      localStorage.setItem('tsAiAgentMode', enabled ? 'true' : 'false');
      return enabled;
    },
    localStorage.getItem('tsAiAgentMode') === 'true',
  );
  const dispatch: AppDispatch = useDispatch();
  const [ignored, forceUpdate] = useReducer((x) => x + 1, 0, undefined);
  const currentLocation = findLocation();
  const firstRender = useFirstRender();

  useEffect(() => {
    images.current = [];
    // When the active provider changes (e.g. Ollama → LM Studio), drop the
    // cached client + model list so they are rebuilt for the new engine/url.
    if (lastProviderId.current !== defaultAiProvider?.id) {
      lastProviderId.current = defaultAiProvider?.id;
      aiClient.current = undefined;
      models.current = [];
      currentModel.current = undefined;
    }
    if (
      !firstRender &&
      defaultAiProvider &&
      openedEntry &&
      // !openedEntry.isFile &&
      selectedTabName === TabNames.aiTab
    ) {
      checkOllamaModels().then(() => initHistory());
    }
    // Preselect the provider's default text model so the chat/agent model
    // dropdown is never empty on a fresh start (currentModel lives in a ref
    // and used to stay unset until the user picked one by hand). OpenAI-
    // compatible only: the Ollama path warms the model up via a chat request
    // and is handled by checkOllamaModels/initHistory instead.
    if (
      !currentModel.current &&
      defaultAiProvider &&
      defaultAiProvider.engine !== 'ollama' &&
      defaultAiProvider.defaultTextModel
    ) {
      setModel(defaultAiProvider.defaultTextModel);
    }
  }, [defaultAiProvider, openedEntry]);

  function getGenerationSettings(
    option: generateOptionType = 'tags',
  ): GenerationSettings {
    const item = Pro
      ? localStorage.getItem(Pro.keys.generationSettingsKey)
      : undefined;
    const storedObj = item ? JSON.parse(item) : {};
    return {
      option: option,
      structuredDataProps: { name: true, summary: true },
      maxTags: 4,
      maxChars: undefined,
      tagsFromLibrary: false,
      fromDescription: false,
      tagGroupsIds: [],
      appendToDescription: true,
      appendAnalysisToDescription: true,
      ...storedObj,
    };
  }

  function initHistory() {
    if (openedEntry) {
      if (
        !openedEntry.isFile &&
        !openedEntry.path.endsWith(AppConfig.metaFolder)
      ) {
        images.current = [];
        loadHistory().then((historyItems) => {
          chatHistoryItems.current = historyItems;
          forceUpdate();
        });
      } else {
        chatHistoryItems.current = [];
        forceUpdate();
      }
    }
  }

  function getEntryModel(
    fileName: string,
    aiProvider: AIProvider,
  ): ModelResponse {
    if (fileName && aiProvider) {
      const ext = extractFileExtension(fileName).toLowerCase();
      let model = aiProvider.defaultTextModel; // folders don't have Extension
      if (AppConfig.aiSupportedFiletypes.text.includes(ext)) {
        model = aiProvider.defaultTextModel;
      } else if (AppConfig.aiSupportedFiletypes.image.includes(ext)) {
        model = aiProvider.defaultImageModel;
      }
      if (model) {
        return findModel(model);
      }
    }
    return undefined;
  }

  function deleteHistory(): Promise<boolean> {
    if (!openedEntry) {
      return Promise.resolve(false);
    }
    const historyFilePath = getHistoryMetaDir();
    return deleteDirectory(historyFilePath).then((success) => {
      if (success) {
        chatHistoryItems.current = [];
        forceUpdate();
        return true;
      }
      return success;
    });
  }

  function loadHistory(): Promise<ChatItem[]> {
    const historyFilePath = getHistoryFilePath();
    if (currentLocation) {
      return currentLocation
        .loadTextFilePromise(historyFilePath)
        .then((jsonContent) => {
          if (jsonContent) {
            const historyModel = loadJSONString(jsonContent) as HistoryModel;
            if (historyModel) {
              refreshOllamaModels(historyModel.lastModelName);
              return historyModel.history ? historyModel.history : [];
            }
          }
          return [];
        })
        .catch((e) => {
          console.log('cannot load json:' + historyFilePath, e);
          if (currentModel.current === undefined && defaultAiProvider) {
            //set defaultTextModel if not currentModel
            setModel(defaultAiProvider.defaultTextModel);
          }
          return [];
        });
    }
    return Promise.resolve([]);
  }

  function checkProviderAlive(provider: AIProvider): Promise<boolean> {
    return checkAiProviderAlive(provider);
  }

  /**
   * return true if model is loaded successful false otherwise
   */
  function checkOllamaModels(): Promise<boolean> {
    if (!defaultAiProvider) {
      // No AI provider configured/enabled — generation cannot start.
      return Promise.resolve(false);
    }
    if (!models.current || models.current.length === 0) {
      return getAiClient(defaultAiProvider).then((client) => {
        aiClient.current = client;
        return refreshOllamaModels();
      });
    }
    return Promise.resolve(true);
  }

  async function refreshOllamaModels(modelName = undefined): Promise<boolean> {
    if (defaultAiProvider) {
      if (!aiClient.current) {
        aiClient.current = await getAiClient(defaultAiProvider);
      }
      if (!aiClient.current) {
        return false;
      }
      return aiClient.current
        .list()
        .then((m) => {
          if (m) {
            models.current = m;
            const model = findModel(modelName);
            if (model) {
              return setModel(model);
            } else {
              //set defaultTextModel if not found
              const model = findModel(defaultAiProvider.defaultTextModel);
              if (model) {
                return setModel(defaultAiProvider.defaultTextModel);
              }
            }
            return true;
          }
          return false;
        })
        .then((success) => {
          if (success) {
            forceUpdate();
          }
          return success;
        });
    }
    return Promise.resolve(false);
  }

  function setModel(m: ModelResponse | string): Promise<boolean> {
    let model = typeof m === 'string' ? findModel(m) : m;
    if (
      !model &&
      typeof m === 'string' &&
      defaultAiProvider &&
      defaultAiProvider.engine !== 'ollama'
    ) {
      // Manually entered model name (endpoints without a /models listing,
      // e.g. single-model gateways) — accept it as a synthetic entry.
      model = {
        name: m,
        model: m,
        modified_at: undefined,
        size: 0,
        digest: '',
        details: {
          family: 'openai-compatible',
          format: '',
          families: [],
          parameter_size: '',
          quantization_level: '',
        },
      } as unknown as ModelResponse;
      models.current = [...(models.current || []), model];
    }
    if (
      model &&
      (!currentModel.current || currentModel.current.name !== model.name)
    ) {
      currentModel.current = model;
      // Persist the chosen model into the provider settings, otherwise it
      // lived only in this in-memory ref and was lost on every relaunch.
      if (
        defaultAiProvider &&
        !AppConfig.ExtAI &&
        defaultAiProvider.defaultTextModel !== model.name
      ) {
        dispatch(
          SettingsActions.setAiProviders(
            aiProviders.map((p) =>
              p.id === defaultAiProvider.id
                ? { ...p, defaultTextModel: model.name }
                : p,
            ),
          ),
        );
      }
      forceUpdate();
      // Preloading a model with an empty-messages request is an Ollama warm-up
      // trick; OpenAI-compatible servers would reject it, so skip it there.
      if (defaultAiProvider?.engine !== 'ollama') {
        return Promise.resolve(true);
      }
      //load model
      return newChatMessage().then(() => {
        showNotification(
          format(new Date().getTime(), 'dd.MM.yyyy HH:mm:ss') +
            ' Model ' +
            model.name +
            ' loaded',
        );
        //forceUpdate();
        return true;
      });
    }
    return Promise.resolve(false);
  }

  function removeImage(uuid: string) {
    const img = images.current.find((i) => i.uuid === uuid);
    if (img) {
      images.current = images.current.filter((i) => i.uuid !== uuid);
      deleteEntriesPromise(currentLocation.toFsEntry(img.path, true));
      forceUpdate();
    }
  }

  function setImages(imagesPaths: string[]) {
    if (imagesPaths.length > 0) {
      imagesPaths.forEach((path) => {
        currentLocation
          .getFileContentPromise(path, 'arraybuffer')
          .then((uint8Array) => {
            const base64Img = toBase64Image(uint8Array);
            if (images.current.some((i) => i.base64 === base64Img)) return;
            const imageUuid = getUuid();
            const imageHistoryPath =
              imageUuid + '.' + extractFileExtension(path);
            const image: ChatImage = {
              uuid: imageUuid,
              path: imageHistoryPath,
              base64: base64Img,
            };
            images.current = [...images.current, image];
            saveFilePromise(
              { path: getHistoryFilePath(imageHistoryPath) },
              uint8Array,
              true,
              false,
            );
            forceUpdate();
          });
      });
    }
  }

  function unloadCurrentModel() {
    if (currentModel.current) {
      // Unloading via keep_alive:0 is Ollama-only; for other engines just drop
      // the local reference without an HTTP round-trip.
      if (defaultAiProvider?.engine !== 'ollama') {
        currentModel.current = undefined;
        return;
      }
      //unload model
      newChatMessage(undefined, true).then(
        () => (currentModel.current = undefined),
      );
    }
  }

  function removeModel(modelName: string) {
    const model = findModel(modelName);
    // Model deletion is Ollama-only; OpenAI-compatible servers manage models
    // externally and expose no delete endpoint.
    if (model && defaultAiProvider && aiClient.current?.delete) {
      const result = confirm(
        t('core:confirmRemoveModel', { name: model.name }),
      );
      if (result) {
        //addTimeLineRequest('deleting ' + model.name, 'system');
        showNotification(t('core:modelDeletedSuccess', { name: model.name }));
        aiClient.current.delete(model.name).then((response) => {
          console.log('deleteOllamaModel response:' + response);
          if (response) {
            if (model.name === currentModel.current?.name) {
              currentModel.current = undefined;
            }
            refreshOllamaModels();
          }
        });
      }
    }
  }

  function findModel(modelName: string) {
    return models.current?.find(
      (m) => m.name === modelName || m.name === modelName + ':latest',
    );
  }

  /**
   * check if model is installed and return details
   * @param modelName
   */
  async function getModel(modelName: string): Promise<ModelResponse> {
    if (!modelName || !defaultAiProvider) {
      return undefined;
    }
    if (!aiClient.current) {
      aiClient.current = await getAiClient(defaultAiProvider);
    }
    if (!aiClient.current) {
      return undefined;
    }
    return aiClient.current.list().then((m) => {
      if (m && m.length > 0) {
        return m.find(
          (mm) => mm.name === modelName || mm.name === modelName + ':latest',
        );
      }
      return undefined;
    });
  }

  async function changeCurrentModel(
    newModelName: string,
    confirmCallback?,
  ): Promise<boolean> {
    let model;
    if (!aiClient.current) {
      const client = await getAiClient(defaultAiProvider);
      aiClient.current = client;
      const m = client ? await client.list() : undefined;
      if (m) {
        models.current = m;
        model = models.current.find(
          (m) => m.name === newModelName || m.name === newModelName + ':latest',
        );
      }
    } else {
      model = findModel(newModelName);
    }
    // Downloading a model on demand is Ollama-only; other engines manage
    // their models externally, so just bail out without a pull prompt.
    if (!model && defaultAiProvider && aiClient.current?.pull) {
      // return setModel(model);
      // } else {
      const result = confirm(
        'Do you want to download and install ' + newModelName + ' model?',
      );
      if (result) {
        if (confirmCallback) {
          confirmCallback();
        }
        // addTimeLineRequest('downloading ' + newModelName, 'system');
        openFileUploadDialog(newModelName, 'downloadChatModel');
        const onProgressHandler = (message: PullModelResponse) => {
          if (message.status) {
            dispatch(
              AppActions.onUploadProgress(
                {
                  key: message.model || message.status,
                  loaded: message.completed,
                  total: message.total,
                },
                undefined,
                message.model,
              ),
            );
          }
        };
        return aiClient.current
          .pull(newModelName, onProgressHandler)
          .then((response) => {
            console.log('pullOllamaModel response:' + response);
            return refreshOllamaModels(newModelName);
          });
        /*return window.electronIO.ipcRenderer
          .invoke('pullOllamaModel', defaultAiProvider.url, {
            name: newModelName,
            stream: true,
          })
          .then((response) => {
            console.log('pullOllamaModel response:' + response);
            refreshOllamaModels(newModelName);
            return true;
          });*/
      }
    }
    return true; //Promise.resolve(true);
  }

  function addHistoryItem(txt: string, role: ChatRole) {
    if (txt) {
      const newItem: ChatItem = {
        engine: defaultAiProvider?.engine || 'ollama',
        modelName: currentModel.current?.name,
        role: role,
        request: txt,
        timestamp: new Date().getTime(),
        imagePaths: images.current.map((i) => i.path),
      };
      if (role === 'user') {
        saveHistoryItems([newItem, ...chatHistoryItems.current]);
      } else {
        chatHistoryItems.current = [newItem, ...chatHistoryItems.current];
      }
      images.current = [];
      forceUpdate();
    }
  }

  function getHistoryFilePath(name?: string) {
    if (!openedEntry) {
      // Global AI Agent dialog with no folder opened — history stays in memory
      return '';
    }
    const dirSeparator = currentLocation
      ? currentLocation.getDirSeparator()
      : AppConfig.dirSeparator;
    const metaFolder = getMetaDirectoryPath(openedEntry.path, dirSeparator);
    const fileName = name ? name : AppConfig.aiChatFileName;
    return (
      metaFolder + dirSeparator + AppConfig.aiFolder + dirSeparator + fileName
    );
  }

  function getHistoryMetaDir() {
    if (!openedEntry) {
      return '';
    }
    const dirSeparator = currentLocation
      ? currentLocation.getDirSeparator()
      : AppConfig.dirSeparator;
    const metaFolder = getMetaDirectoryPath(openedEntry.path, dirSeparator);
    return metaFolder + dirSeparator + AppConfig.aiFolder;
  }

  function saveHistoryItems(items?: ChatItem[]) {
    if (items) {
      chatHistoryItems.current = items;
    }
    if (chatHistoryItems.current.length > 0) {
      const model: HistoryModel = {
        history: chatHistoryItems.current,
        lastModelName: currentModel.current?.name,
        engine: defaultAiProvider?.engine,
      };
      if (!openedEntry || openedEntry.isFile) return;
      saveFilePromise(
        { path: getHistoryFilePath() },
        JSON.stringify(model, null, 2),
        true,
      )
        .then((fsEntry: TS.FileSystemEntry) => {
          console.log(t('core:fileCreateSuccessfully') + ' ' + fsEntry.path);
        })
        .catch((err) => {
          console.log('File creation failed', err);
        });
    }
  }

  function addTimeLineResponse(txt) {
    if (!chatHistoryItems.current.length) return;
    const [first, ...rest] = chatHistoryItems.current;
    chatHistoryItems.current = [
      { ...first, response: (first.response || '') + txt },
      ...rest,
    ];
    forceUpdate();
  }

  function addChatHistory(txt, replace = false): ChatItem[] {
    if (txt && chatHistoryItems.current.length > 0) {
      chatHistoryItems.current[0].response =
        (!replace && chatHistoryItems.current[0].response
          ? chatHistoryItems.current[0].response
          : '') + txt;
      // forceUpdate(); don't refresh chatHistoryItems this will reload milkdown editor just update(content)
    }
    return chatHistoryItems.current;
  }

  function getOllamaMessages(items: ChatItem[], modelName: string) {
    const messages = [];
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.role === 'user' && item.modelName === modelName) {
        if (item.request) {
          messages.push({
            role: 'user',
            content: item.request,
          });
        }
        if (item.response) {
          messages.push({
            role: 'assistant',
            content: item.response,
          });
        }
      }
    }
    return messages;
  }

  function getMessage(msg: string, mode: ChatMode) {
    if (mode === 'helpful') {
      if (aiTemplatesContext) {
        return aiTemplatesContext
          .getTemplate('DEFAULT_SYSTEM_PROMPT')
          .replace('{question}', msg);
      }
    } else if (mode === 'summary') {
      if (aiTemplatesContext) {
        let prompt = aiTemplatesContext
          .getTemplate('SUMMARIZE_PROMPT')
          .replace('{summarize_text}', msg);
        if (selectedEntries && selectedEntries.length > 0) {
          prompt = prompt.replace(
            '{file_path}',
            ' of ' + selectedEntries[0].name,
          );
        } else {
          prompt = prompt.replace('{file_path}', '');
        }
        if (generationSettings.current.maxChars) {
          prompt = prompt.replace(
            '{max_chars}',
            'maximal ' +
              generationSettings.current.maxChars +
              ' characters long ',
          );
        } else {
          prompt = prompt.replace('{max_chars}', '');
        }
        if (generationSettings.current.language) {
          prompt = prompt.replace(
            '{language}',
            generationSettings.current.language,
          );
        } else {
          prompt = prompt.replace('{language}', 'native');
        }
        return prompt;
      }
    } else if (mode === 'description') {
      if (msg) {
        if (aiTemplatesContext) {
          return aiTemplatesContext
            .getTemplate('TEXT_DESCRIPTION_PROMPT')
            ?.replace('{input_text}', msg)
            .replace(
              '{max_chars}',
              generationSettings.current.maxChars
                ? 'max ' + generationSettings.current.maxChars + ' characters'
                : '',
            )
            .replace(
              '{language}',
              generationSettings.current.language
                ? generationSettings.current.language
                : 'native',
            );
        }
      } else {
        if (aiTemplatesContext) {
          if (generationSettings.current.option === 'analyseImages') {
            return aiTemplatesContext.getTemplate(
              'IMAGE_DESCRIPTION_STRUCTURED_PROMPT',
            );
          }
          return aiTemplatesContext
            .getTemplate('IMAGE_DESCRIPTION_PROMPT')
            ?.replace('{file_name}', openedEntry ? openedEntry.name : '')
            .replace(
              '{language}',
              generationSettings.current.language
                ? generationSettings.current.language
                : 'English',
            );
        }
      }
    } else if (mode === 'tags') {
      if (aiTemplatesContext) {
        if (msg) {
          if (openedEntry) {
            return aiTemplatesContext
              .getTemplate('TEXT_TAGS_PROMPT')
              ?.replace('{input_text}', msg);
          }
        } else {
          // image
          if (openedEntry) {
            return aiTemplatesContext.getTemplate('IMAGE_TAGS_PROMPT');
          }
        }
      }
    } else if (mode === 'rephrase') {
      if (aiTemplatesContext) {
        const historyMap = chatHistoryItems.current.map((item) =>
          item.role !== 'system'
            ? `${item.request ? 'Human: ' + item.request : ''}${item.response ? ' Assistant: ' + item.response : ''}`
            : '',
        );
        return aiTemplatesContext
          .getTemplate('DEFAULT_QUESTION_PROMPT')
          .replace('{question}', msg)
          .replace('{chat_history}', historyMap.join(' '));
      }
    }
    return msg;
  }

  const chatMessageHandler = useMemo(() => {
    return (msg): void => {
      //console.log(`Chat ${msg}`);
      isTyping.current = true;
      addTimeLineResponse(msg);
    };
  }, []);

  function getTagsFromLibrary(): string[] {
    const tagsFromLibrary: string[] = [];
    if (
      generationSettings.current.tagsFromLibrary &&
      generationSettings.current.tagGroupsIds.length > 0
    ) {
      generationSettings.current.tagGroupsIds.forEach((tagGroupId) => {
        const tagGroup = tagGroups.find((tg) => tg.uuid === tagGroupId);
        if (tagGroup) {
          tagsFromLibrary.push(...tagGroup.children.map((tag) => tag.title));
        }
      });
    }
    return tagsFromLibrary;
  }

  /**
   * @param msg If the messages array is empty, the model will be loaded into memory.
   * @param unload If the messages array is empty and the keep_alive parameter is set to 0, a model will be unloaded from memory.
   * @param role
   * @param mode
   * @param model
   * @param stream
   * @param imgArray
   * @param includeHistory
   */
  function newChatMessage(
    msg: string = undefined,
    unload = false,
    role: ChatRole = 'user',
    mode: ChatMode = undefined,
    model: string = currentModel.current?.name,
    stream: boolean = false,
    imgArray: string[] = [],
    includeHistory = true,
  ): Promise<any> {
    if (!model) {
      showNotification(t('core:chooseModel'));
      return Promise.resolve(false);
    } else if (!defaultAiProvider) {
      return Promise.resolve(false);
    }
    const msgContent = getMessage(msg, mode);
    const imagesArray =
      imgArray.length > 0 ? imgArray : images.current.map((i) => i.base64);
    const messages =
      msgContent && !unload
        ? [
            ...getOllamaMessages(
              includeHistory ? chatHistoryItems.current : [],
              model,
            ),
            {
              role: role,
              content: msgContent,
              ...(imagesArray.length > 0 && { images: imagesArray }),
            },
          ]
        : [];
    if (includeHistory) {
      addHistoryItem(msg, role);
    }
    let format = undefined;
    if (mode === 'tags') {
      const tagsFromLibrary = getTagsFromLibrary();
      if (tagsFromLibrary.length > 0) {
        format = {
          format: zodToJsonSchema(
            getZodTags(generationSettings.current.maxTags, tagsFromLibrary),
          ),
        };
      }
      if (imgArray.length > 0) {
        format = {
          format: zodToJsonSchema(
            getZodDescription(generationSettings.current.structuredDataProps),
          ),
        };
      } else {
        format = {
          format: zodToJsonSchema(
            getZodTags(generationSettings.current.maxTags, tagsFromLibrary),
          ),
        };
      }
    } else if (mode === 'description' || mode === 'summary') {
      if (
        imgArray.length > 0 &&
        generationSettings.current.option === 'analyseImages'
      ) {
        format = {
          format: zodToJsonSchema(
            getZodDescription(generationSettings.current.structuredDataProps),
          ),
        };
      }
    }
    const request: ChatRequest = {
      model,
      messages,
      stream: stream,
      ...(unload && { keep_alive: 0 }),
      ...(format && format),
    };
    // console.log('AI question: ' + JSON.stringify(messages));
    if (!aiClient.current) {
      showNotification(t('core:ollamaServiceNotAlive'));
      isTyping.current = false;
      forceUpdate();
      return Promise.resolve(undefined);
    }
    return aiClient.current
      .chat(request, chatMessageHandler)
      .then((apiResponse) => {
        // console.log('apiResponse:' + apiResponse);
        isTyping.current = false;
        forceUpdate();
        if (apiResponse === undefined && stream === false) {
          showNotification(t('core:ollamaServiceNotAlive'));
          return undefined;
        }
        if (msg && includeHistory) {
          saveHistoryItems();
        }
        if (mode === 'tags') {
          if (imgArray.length > 0) {
            const response = JSON.parse(apiResponse); // ImageDescription.parse(JSON.parse(apiResponse));
            const tags = response.objects
              ? response.objects.map((obj) => obj.name)
              : [];
            if (response.time_of_day && response.time_of_day !== 'Unknown') {
              tags.push(response.time_of_day);
            }
            if (response.setting && response.setting !== 'Unknown') {
              tags.push(response.setting);
            }
            if (response.topics) {
              tags.push(response.topics);
            }
            return [...tags, ...response.colors];
          } else {
            let tags: string[] = [];
            try {
              const response = JSON.parse(apiResponse);
              tags = response.topics;
            } catch (e) {
              console.log('JSON.parse error for:' + apiResponse, e);
              if (apiResponse) {
                tags = apiResponse.split(' ');
              }
            }

            return tags.slice(0, generationSettings.current.maxTags);
          }
        } else if (mode === 'description' || mode === 'summary') {
          if (format) {
            const response = JSON.parse(apiResponse);
            const arrReturn = [];
            if (
              generationSettings.current.structuredDataProps.name &&
              response.name
            ) {
              arrReturn.push('**Name:** ' + response.name);
            }
            if (
              generationSettings.current.structuredDataProps.objects &&
              response.objects
            ) {
              arrReturn.push(
                response.objects.map(
                  (obj) =>
                    (obj.name ? '\n\n> > **Object Name:** ' + obj.name : '') +
                    (obj.attributes
                      ? '\n\n> > **Attributes:** ' +
                        JSON.stringify(obj.attributes, null, 4).replace(
                          /[{}\[\]]/g,
                          '',
                        )
                      : ''),
                ),
              );
            }

            if (
              generationSettings.current.structuredDataProps.scene &&
              response.scene
            ) {
              arrReturn.push('**Scene:** ' + response.scene);
            }
            if (
              generationSettings.current.structuredDataProps.colors &&
              response.colors
            ) {
              arrReturn.push('**Colors:** ' + response.colors);
            }
            if (
              generationSettings.current.structuredDataProps.summary &&
              response.summary
            ) {
              arrReturn.push('**Summary:** ' + response.summary);
            }
            if (
              generationSettings.current.structuredDataProps.time_of_day &&
              response.time_of_day
            ) {
              arrReturn.push('**Day Time:** ' + response.time_of_day);
            }
            if (
              generationSettings.current.structuredDataProps.settings &&
              response.setting
            ) {
              arrReturn.push('**Setting:** ' + response.setting);
            }
            if (
              response.text_content &&
              generationSettings.current.structuredDataProps.text_content
            ) {
              arrReturn.push('**Content:** ' + response.text_content);
            }
            return arrReturn.join('\n\n') + '\n\n';
          }
        }
        return stream ? true : apiResponse;
      });
  }

  function cancelMessage() {
    if (agentAbortController.current) {
      agentAbortController.current.abort();
      agentAbortController.current = undefined;
    }
    if (aiClient.current) {
      aiClient.current.abort();
      isTyping.current = false;
      saveHistoryItems();
      forceUpdate();
    }
  }

  function buildAgentSystemPrompt(conventions: string): string {
    const language = interfaceLanguage || 'en';
    const selected = (selectedEntries || [])
      .slice(0, 10)
      .map(
        (e) =>
          `- ${e.path}${e.tags?.length ? ' [tags: ' + e.tags.map((t) => t.title).join(', ') + ']' : ''}`,
      )
      .join('\n');
    return [
      'You are the TagSpaces AI Agent, a file management assistant embedded in the TagSpaces application.',
      'You can search files, inspect tags and text content, and add/remove tags through the provided tools.',
      "Prefer calling tools over guessing about the user's files. Use concise, lowercase tag titles.",
      'Never invent file paths — only use paths returned by tools or given by the user.',
      'After tool calls, briefly summarize in text what you did or found.',
      'For "summarize this document/folder" requests, write the result with the set_description tool for the relevant file or folder (concise), in addition to replying.',
      'When asked to file or sort documents (e.g. an inbox), move each item into its destination folder with move_file first, then tag it with set_description/read_file_text as needed. Never overwrite existing files.',
      'When asked to scan, review or summarize a folder, follow this default procedure:',
      '- list_folder with recursive=true, then read each document with read_file_text,',
      '- write a concise summary of every document into its description via set_description,',
      '  but first check get_description — skip documents that already have an AI summary block,',
      '- finally update the folder description with a hierarchical summary (per sub-folder sections),',
      '  basing it on the child descriptions you just wrote, not on re-reading every document.',
      '',
      `Connected location: ${currentLocation ? currentLocation.name : 'none'}`,
      `Current folder: ${currentDirectoryPath || 'unknown'}`,
      'For goal-driven requests (produce a report, plan or answer document):',
      '- identify the relevant folders: list_folder (recursive) and search_files with tag/type operators, guided by folder and file descriptions;',
      '- read the relevant documents with read_file_text, plus related knowledge notes;',
      '- synthesize the requested content and write it as a markdown file with write_deliverable (choose a sensible location and filename; respect the location conventions about output folders);',
      '- deliverable modes — follow what the goal asks for:',
      '  * "Reply plan (text)" / 计划或答复类目标: reply the plan directly in chat as text — do NOT write a file;',
      '  * "document/report" / 文档类目标: write the full content with write_deliverable and reply with the output path;',
      '  * if the goal does not specify a mode, default to a text reply for plans and answers, and to a file for documents meant to be kept.',
      `Always reply in the language the user writes in — a message written in Chinese MUST get a Chinese reply. UI language (${language}) is only a fallback when the user's language is unclear.`,
      ...(conventions
        ? [
            `Location conventions written by the user (CLAUDE.md) — follow them closely:`,
            conventions,
          ]
        : []),
      selected ? `\nCurrently selected entries:\n${selected}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  function buildAgentTools() {
    const locationForPath = (path: string) =>
      findLocationByPath(path) || findLocation() || undefined;
    return createAgentTools({
      agentSearch,
      getIndex,
      findEntry,
      listChildren,
      listLocations: () =>
        locations.map((l) => ({ name: l.name, path: l.path })),
      currentLocationName: currentLocation ? currentLocation.name : '',
      currentLocationPath: currentLocation ? currentLocation.path : '',
      currentDirectoryPath: currentDirectoryPath || '',
      selectedEntries,
      addTagsToFsEntry: (entry, tags) => addTagsToFsEntry(entry, tags),
      removeTagsFromEntry,
      moveFile: (sourcePath: string, targetFolderPath: string) => {
        const srcLoc = locationForPath(sourcePath);
        const tgtLoc = locationForPath(targetFolderPath);
        if (!srcLoc) {
          return Promise.reject(
            new Error('source path is not inside any connected location'),
          );
        }
        if (!tgtLoc || srcLoc.uuid !== tgtLoc.uuid) {
          return Promise.reject(
            new Error(
              'cross-location move is not supported — organize within each folder',
            ),
          );
        }
        return moveFiles([sourcePath], targetFolderPath, srcLoc.uuid);
      },
      loadTextFile: (path: string) => {
        const loc = locationForPath(path);
        if (!loc) {
          return Promise.reject(
            new Error('path is not inside any connected location'),
          );
        }
        return loc.loadTextFilePromise(path);
      },
      readFileBytes: (path: string) => {
        const loc = locationForPath(path);
        if (!loc) {
          return Promise.reject(
            new Error('path is not inside any connected location'),
          );
        }
        return loc
          .getFileContentPromise(path, 'arraybuffer')
          .then((buffer: ArrayBuffer) => buffer);
      },
      getDescription: (path: string) => {
        const loc = locationForPath(path);
        if (!loc) {
          return Promise.resolve('');
        }
        return loc
          .loadFileMetaDataPromise(path)
          .then((meta: TS.FileSystemEntryMeta) => meta?.description || '')
          .catch(() => '');
      },
      setDescription: (entry: TS.FileSystemEntry, description: string) =>
        setDescriptionChange(entry, description),
      writeTextFile: (path: string, content: string, overwrite: boolean) =>
        Promise.resolve(
          currentLocation.saveTextFilePromise({ path }, content, overwrite),
        ).then(() => undefined),
    });
  }

  function formatAgentToolEvent(event: AgentEvent): string | undefined {
    if (event.type === 'tool_call') {
      let short = event.args || '{}';
      try {
        short = JSON.stringify(JSON.parse(event.args));
      } catch (e) {
        // keep raw args when they are not valid JSON
      }
      if (short.length > 120) {
        short = short.slice(0, 120) + '…';
      }
      return `\n\n> 🔧 **${event.name}** \`${short}\``;
    }
    if (event.type === 'tool_result') {
      let summary = 'ok';
      try {
        const parsed = JSON.parse(event.result);
        if (parsed?.error) {
          summary = '⚠️ ' + parsed.error;
        } else if (parsed && typeof parsed.count === 'number') {
          summary = `${parsed.count} entries`;
        }
      } catch (e) {
        // non-JSON results stay 'ok'
      }
      return ` → ${summary}`;
    }
    if (event.type === 'error') {
      return `\n\n> ⚠️ ${event.message}`;
    }
    return undefined;
  }

  async function newAgentMessage(msg: string): Promise<any> {
    if (!msg || !msg.trim()) {
      return undefined;
    }
    if (!defaultAiProvider || !defaultAiProvider.url) {
      showNotification(t('core:aiNoProviderConfigured'));
      return undefined;
    }
    const model =
      currentModel.current?.name || defaultAiProvider.defaultTextModel;
    if (!model) {
      showNotification(t('core:chooseModel'));
      return undefined;
    }
    const history = getOllamaMessages(chatHistoryItems.current, model);
    addHistoryItem(msg, 'user');
    const conventions = await loadLocationConventions(currentLocation);
    const messages = [
      { role: 'system', content: buildAgentSystemPrompt(conventions) },
      ...history,
      { role: 'user', content: msg },
    ];
    isTyping.current = true;
    forceUpdate();
    const abortController = new AbortController();
    agentAbortController.current = abortController;
    try {
      const result = await runAgent({
        url: defaultAiProvider.url,
        authKey: defaultAiProvider.authKey,
        model,
        messages,
        tools: buildAgentTools(),
        signal: abortController.signal,
        onEvent: (event: AgentEvent) => {
          if (event.type === 'text') {
            addTimeLineResponse(event.delta);
          } else {
            const line = formatAgentToolEvent(event);
            if (line) {
              addTimeLineResponse(line);
            }
          }
        },
      });
      return result.content;
    } catch (e) {
      console.error('agent run failed', e);
      showNotification(t('core:aiAgentRunFailed'), 'error', false);
      return undefined;
    } finally {
      agentAbortController.current = undefined;
      isTyping.current = false;
      saveHistoryItems();
      forceUpdate();
    }
  }

  function getFileContent(
    entry: TS.FileSystemEntry,
    content: any,
  ): Promise<string> {
    if (entry.path.endsWith('.pdf')) {
      return extractPDFcontent(content);
    } else if (entry.path.endsWith('.html')) {
      return extractTextContent(entry.name, content);
    }
    return Promise.resolve(content);
  }

  function getImageArray(fileContent, content) {
    if (fileContent === 'image') {
      const base64 = toBase64Image(content);
      if (base64) {
        return [base64];
      }
    }
    return [];
  }

  function generate(
    fileContent: 'text' | 'image',
    mode: ChatMode,
    modelName: string,
    entry: TS.FileSystemEntry,
  ): Promise<string> {
    if (modelName) {
      if (entry.isFile) {
        return currentLocation
          .getFileContentPromise(
            entry.path,
            fileContent === 'text' && !entry.path.endsWith('.pdf')
              ? 'text'
              : 'arraybuffer',
          )
          .then((content) => getFileContent(entry, content))
          .then((content) =>
            newChatMessage(
              fileContent === 'image' ? undefined : content,
              false,
              'user',
              mode,
              modelName, //openedEntryModel.current.name,
              false,
              getImageArray(fileContent, content),
              false,
            ),
          )
          .catch((e) => {
            console.log('newOllamaMessage error:', e);
            return undefined;
          });
      } else {
        // folder
        return newChatMessage(
          entry.name,
          false,
          'user',
          mode,
          modelName, //openedEntryModel.current.name,
          false,
          [],
          false,
        );
      }
    } else {
      showNotification(t('core:modelNotFoundTryPull'));
    }
    return Promise.resolve(undefined);
  }

  function descriptionGenerate(
    entry: TS.FileSystemEntry,
  ): Promise<TS.FileSystemEntry> {
    return checkOllamaModels().then((success) => {
      if (success) {
        const entryModel: ModelResponse = getEntryModel(
          entry.name,
          defaultAiProvider,
        );
        if (entryModel) {
          const ext = extractFileExtension(entry.name).toLowerCase();
          if (AppConfig.aiSupportedFiletypes.image.includes(ext)) {
            return generate(
              'image',
              'description',
              entryModel.name,
              entry,
            ).then((results) =>
              handleGenDescResults(
                entry,
                results,
                entryModel.name,
                generationSettings.current.appendAnalysisToDescription,
              ),
            );
          } else if (
            AppConfig.aiSupportedFiletypes.text.includes(ext) ||
            ext === '' /*folders*/
          ) {
            return generate('text', 'description', entryModel.name, entry).then(
              (results) =>
                handleGenDescResults(
                  entry,
                  results,
                  entryModel.name,
                  generationSettings.current.appendToDescription,
                ),
            );
          }
        } else {
          showNotification(t('core:ollamaConnectionError'));
          return Promise.resolve(undefined);
        }
        // Extension is neither image, text/pdf nor a folder — skip it instead
        // of resolving the unchanged entry (which would mark it processed and
        // could overwrite an existing description with undefined).
        showNotification(
          t('core:generationNotSupportedFor', { name: entry.name }),
        );
        return Promise.resolve(undefined);
      } else {
        showNotification(t('core:noModelsLoaded'));
        return Promise.resolve(undefined);
      }
    });
  }

  function handleGenDescResults(
    entry: TS.FileSystemEntry,
    response: string,
    modelName: string,
    append: boolean,
  ): TS.FileSystemEntry {
    if (response) {
      const generatedDesc =
        response +
        '\\\n *Generated with AI model ' +
        modelName +
        ' on ' +
        formatDateTime(new Date(), true) +
        '* \n';
      //dispatch(SettingsActions.setEntryContainerTab(TabNames.descriptionTab));
      entry.meta.description =
        entry.meta?.description && append
          ? entry.meta.description + '\n---\n' + generatedDesc
          : generatedDesc;

      return entry;
    }
    return undefined;
  }

  function tagsGenerate(
    entry: TS.FileSystemEntry,
    fromDescription: boolean = false,
  ): Promise<boolean> {
    const entryModel: ModelResponse = getEntryModel(
      entry.name,
      defaultAiProvider,
    );
    if (entryModel) {
      const ext = extractFileExtension(entry.name).toLowerCase();
      if (
        (fromDescription || generationSettings.current.fromDescription) &&
        entry.meta?.description
      ) {
        return newChatMessage(
          entry.meta.description,
          false,
          'user',
          'tags',
          defaultAiProvider.defaultTextModel,
          false,
          [],
          false,
        ).then((results) => handleGenTagsResults(entry, results));
      } else if (AppConfig.aiSupportedFiletypes.image.includes(ext)) {
        return generate('image', 'tags', entryModel.name, entry).then(
          (results) => handleGenTagsResults(entry, results),
        );
      } else if (AppConfig.aiSupportedFiletypes.text.includes(ext)) {
        return generate('text', 'tags', entryModel.name, entry).then(
          (results) => handleGenTagsResults(entry, results),
        );
      }
    } else {
      showNotification(
        t('core:tagsGenerationNotSupportedFor', { name: entry.name }),
      );
    }

    return Promise.resolve(false);
  }

  function handleGenTagsResults(entry, response): Promise<boolean> {
    //console.log('newOllamaMessage response:' + response);
    if (response && response.length > 0) {
      try {
        const tags: TS.Tag[] = response.map((tag) => {
          if (tag) {
            const tagTitle = tag
              .replace(/[-/=[\]{}!@#$%^&*(),.?":{}|<>]/g, ' ')
              .toLowerCase()
              .split(' ')
              .filter((str) => str.trim() !== '')
              .slice(0, 3)
              .join('-');
            if (tagTitle) {
              return {
                title: tagTitle,
                ...getTagColors(
                  tagTitle,
                  tagGroups,
                  defaultTextColor,
                  defaultBackgroundColor,
                ),
              };
            }
          }
          return undefined;
        });
        const uniqueTags = tags.filter(
          (tag, index, self) =>
            tag && // Exclude undefined or null tags
            index === self.findIndex((t) => t?.title === tag.title),
        );
        return addTagsToFsEntry(entry, uniqueTags).then(() => {
          dispatch(
            SettingsActions.setEntryContainerTab(TabNames.propertiesTab),
          );
          return true;
        });
        // showNotification('Tags for ' + entry.name + ' generated by an AI.');
      } catch (e) {
        console.error('newOllamaMessage response ' + response, e);
      }
    } else {
      console.error('no response ' + response);
    }
    return Promise.resolve(false);
  }

  function setGenerationSettings(genSettings: any) {
    generationSettings.current = {
      ...generationSettings.current,
      ...genSettings,
    };
    forceUpdate();
  }

  function resetGenerationSettings(option: generateOptionType) {
    generationSettings.current = getGenerationSettings(option);
    forceUpdate();
  }

  const context = useMemo(() => {
    return {
      isTyping: isTyping.current,
      models: models.current,
      images: images.current,
      currentModel: currentModel.current,
      chatHistoryItems: chatHistoryItems.current,
      generationSettings: generationSettings.current,
      agentMode,
      setAgentMode: (enabled: boolean) => setAgentModeState(enabled),
      newAgentMessage,
      checkOllamaModels,
      refreshOllamaModels,
      getHistoryFilePath,
      setModel,
      setImages,
      removeImage,
      unloadCurrentModel,
      removeModel,
      changeCurrentModel,
      getModel,
      addTimeLineResponse,
      addChatHistory,
      newChatMessage,
      cancelMessage,
      findModel,
      generate,
      initHistory,
      deleteHistory,
      checkProviderAlive,
      getAiClient,
      getEntryModel,
      tagsGenerate,
      descriptionGenerate,
      setGenerationSettings,
      resetGenerationSettings,
    };
  }, [
    agentMode,
    defaultAiProvider,
    isTyping.current,
    models.current,
    images.current,
    currentModel.current,
    chatHistoryItems.current,
    generationSettings.current,
    currentDirectoryPath,
    interfaceLanguage,
    openedEntry,
    selectedEntries,
  ]);

  return (
    <ChatContext.Provider value={context}>{children}</ChatContext.Provider>
  );
};
