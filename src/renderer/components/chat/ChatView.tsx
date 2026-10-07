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
import {
  AIIcon,
  ArrowDropUpIcon,
  CancelIcon,
  CloseIcon,
  EditIcon,
  MoreMenuIcon,
  SendIcon,
} from '-/components/CommonIcons';
import DragItemTypes from '-/components/DragItemTypes';
import TsIconButton from '-/components/TsIconButton';
import TsTextField from '-/components/TsTextField';
import ChatDndTargetFile from '-/components/chat/ChatDndTargetFile';
import ChatMenu from '-/components/chat/ChatMenu';
import { AIProvider, ChatMode } from '-/components/chat/ChatTypes';
import SelectChatModel from '-/components/chat/SelectChatModel';
import ConfirmDialog from '-/components/dialogs/ConfirmDialog';
import ChatMdEditor from '-/components/md/ChatMdEditor';
import { CrepeRef } from '-/components/md/useCrepeHandler';
import { useChatContext } from '-/hooks/useChatContext';
import { useNotificationContext } from '-/hooks/useNotificationContext';
import { useOpenedEntryContext } from '-/hooks/useOpenedEntryContext';
import { getDefaultAIProvider } from '-/reducers/settings';
import {
  convertMarkDownToHtml,
  getMimeType,
  saveAsTextFile,
} from '-/services/utils-io';
import { MilkdownProvider } from '@milkdown/react';
import { Box, Divider, FormControlLabel, Grid, Stack } from '@mui/material';
import CircularProgress from '@mui/material/CircularProgress';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import FormHelperText from '@mui/material/FormHelperText';
import InputAdornment from '@mui/material/InputAdornment';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import { useTheme } from '@mui/material/styles';
import { formatDateTime4Tag } from '@tagspaces/tagspaces-common/misc';
import { extractFileExtension } from '@tagspaces/tagspaces-common/paths';
import { getUuid } from '@tagspaces/tagspaces-common/utils-io';
import React, {
  ChangeEvent,
  useCallback,
  useEffect,
  useReducer,
  useRef,
} from 'react';
import { NativeTypes } from 'react-dnd-html5-backend';
import { useTranslation } from 'react-i18next';
import { useSelector } from 'react-redux';
import TsMenuList from '../TsMenuList';

function ChatView() {
  const { t } = useTranslation();
  const theme = useTheme();
  const {
    images,
    removeImage,
    newChatMessage,
    newAgentMessage,
    changeCurrentModel,
    setModel,
    currentModel,
    models,
    isTyping,
    cancelMessage,
  } = useChatContext();
  const { showNotification } = useNotificationContext();
  const aiDefaultProvider: AIProvider = useSelector(getDefaultAIProvider);
  const { openedEntry } = useOpenedEntryContext();
  const isLoading = useRef<boolean>(false);
  const currentMode = useRef<ChatMode>(undefined);
  const editorRef = useRef<CrepeRef>(null);
  const milkdownDivRef = useRef<HTMLDivElement>(null);
  const chatMsg = useRef<string>('');
  const textInputRef = useRef<HTMLInputElement>(null);
  const [ignored, forceUpdate] = useReducer((x) => x + 1, 0, undefined);
  const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
  const [modelMenuAnchor, setModelMenuAnchor] =
    React.useState<null | HTMLElement>(null);
  const [promptHistory, setPromptHistory] = React.useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = React.useState<number>(-1);

  // Input change handler
  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      chatMsg.current = event.target.value;
      forceUpdate();
    },
    [],
  );

  // Model change handler
  const handleChangeModel = useCallback(
    (newModelName: string) => {
      changeCurrentModel(newModelName)
        .then((success) => {
          if (success) {
            setModel(newModelName);
          }
        })
        .catch((err) => {
          showNotification(
            t('core:installCustomModel') + err.message + ': ' + newModelName,
            'error',
            false,
          );
          console.log(err);
        });
    },
    [changeCurrentModel, setModel, showNotification, t],
  );

  // Chat message send handler
  const handleChatMessage = useCallback(() => {
    isLoading.current = true;
    forceUpdate();
    // Save prompt to history (keep last 1)
    if (chatMsg.current.trim()) {
      const updated = [chatMsg.current, ...promptHistory].slice(0, 1);
      setPromptHistory(updated);
    }
    const request = newAgentMessage(chatMsg.current);
    request
      .then((response) => {
        console.log('chat response:' + response);
        chatMsg.current = '';
        isLoading.current = false;
        forceUpdate();
      })
      .catch((error) => {
        if (error.name === 'AbortError') {
          console.log('ChatMessage request has been aborted');
        } else {
          console.error('An error occurred:', error);
        }
        isLoading.current = false;
        forceUpdate();
      });
  }, [newAgentMessage, promptHistory]);

  // Menu handlers
  const handleMoreClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      setAnchorEl(event.currentTarget);
    },
    [],
  );
  const handleClose = useCallback(() => setAnchorEl(null), []);
  const handleSelectAll = useCallback(() => {
    setAnchorEl(null);
    const range = document.createRange();
    const selection = window.getSelection();
    if (milkdownDivRef.current) {
      range.selectNodeContents(milkdownDivRef.current);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }, []);
  const handleCopy = useCallback(() => {
    setAnchorEl(null);
    if (milkdownDivRef.current) {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        console.warn('No text selected');
        return;
      }

      // Extract plain text
      const text = selection.toString();

      // Extract HTML
      const range = selection.getRangeAt(0);
      const container = document.createElement('div');
      container.appendChild(range.cloneContents());
      const html = container.innerHTML;

      // Create ClipboardItem with both types
      const clipboardItem = new ClipboardItem({
        [getMimeType('txt')]: new Blob([text], { type: getMimeType('txt') }),
        [getMimeType('html')]: new Blob([html], { type: getMimeType('html') }),
      });

      navigator.clipboard
        .write([clipboardItem])
        .then(() => showNotification(t('core:copyToClipboard')))
        .catch((err) => {
          console.log('Error copy to clipboard: ' + err);
          showNotification(t('core:generatedHTMLFailed'));
        });
    }
  }, [showNotification, t]);
  const saveAsHtml = useCallback(() => {
    setAnchorEl(null);
    if (editorRef.current) {
      const md = editorRef.current.getMarkdown();
      const html = convertMarkDownToHtml(md);
      const blob = new Blob([html], {
        type: getMimeType('html'),
      });
      const dateTimeTag = formatDateTime4Tag(new Date(), true);
      const filename = `tagspaces-chat [export ${dateTimeTag}].html`;
      saveAsTextFile(blob, filename);
    }
  }, []);
  const saveAsMarkdown = useCallback(() => {
    setAnchorEl(null);
    if (editorRef.current) {
      const md = editorRef.current.getMarkdown();
      const blob = new Blob([md], { type: getMimeType('md') });
      const dateTimeTag = formatDateTime4Tag(new Date(), true);
      const filename = `tagspaces-chat [export ${dateTimeTag}].md`;
      saveAsTextFile(blob, filename);
    }
  }, []);

  // (Prompt template feature removed — reusable prompts now live as
  //  custom skills and knowledge base entries.)
  const { FILE } = NativeTypes;

  return (
    <Box sx={{ flexGrow: 1, margin: 0, height: '100%' }}>
      <Grid
        container
        spacing={1}
        wrap="nowrap"
        sx={{
          flexDirection: 'column',
          height: '100%',
          overflow: 'hidden',
        }}
      >
        {/* Chat actions */}
        <Grid
          container
          spacing={0}
          direction="row"
          sx={{ flexFlow: 'nowrap', justifyContent: 'flex-end' }}
        >
          <Grid>
            <TsIconButton
              tooltip={t('core:moreActions')}
              onClick={handleMoreClick}
              data-tid="moreActionsTID"
              aria-label={t('core:moreActions')}
              aria-controls={Boolean(anchorEl) ? 'account-menu' : undefined}
              aria-haspopup="true"
              aria-expanded={Boolean(anchorEl) ? 'true' : undefined}
            >
              <MoreMenuIcon />
            </TsIconButton>
            <ChatMenu
              anchorEl={anchorEl}
              handleClose={handleClose}
              handleSelectAll={handleSelectAll}
              handleCopy={handleCopy}
              saveAsHtml={saveAsHtml}
              saveAsMarkdown={saveAsMarkdown}
            />
          </Grid>
        </Grid>
        {/* Chat markdown editor */}
        <Grid
          id="chatMD"
          sx={{
            padding: 0,
            overflowY: 'auto',
            flexGrow: 1,
            borderRadius: AppConfig.defaultCSSRadius,
            // border: '1px solid lightgray',
          }}
          ref={milkdownDivRef}
        >
          <style>{`
            #chatMD .milkdown .ProseMirror a { color: ${theme.palette.primary.main}; }
          `}</style>
          <MilkdownProvider>
            <ChatMdEditor showCurrent={isLoading.current} ref={editorRef} />
          </MilkdownProvider>
        </Grid>
        {/* Images and chat input */}
        <Grid container spacing={1} sx={{ flexDirection: 'column' }}>
          {images.length > 0 && (
            <Grid>
              {images.map((image, index) => (
                <Box
                  key={image.uuid}
                  sx={{
                    position: 'relative',
                    float: 'right',
                  }}
                >
                  <img
                    src={
                      'data:image/' +
                      extractFileExtension(image.path) +
                      ';base64,' +
                      image.base64
                    }
                    alt={t('core:chatImageAlt', { number: index + 1 })}
                    style={{ maxHeight: 150, width: 'auto' }}
                  />
                  <TsIconButton
                    size="small"
                    tooltip={t('core:remove')}
                    onClick={() => removeImage(image.uuid)}
                    sx={{
                      position: 'absolute',
                      top: 8,
                      right: 8,
                      backgroundColor: 'rgba(255, 255, 255, 0.7)',
                      '&:hover': { backgroundColor: 'rgba(255, 255, 255, 1)' },
                    }}
                  >
                    <CloseIcon fontSize="small" />
                  </TsIconButton>
                </Box>
              ))}
            </Grid>
          )}
          <Grid>
            <ChatDndTargetFile accepts={[FILE, DragItemTypes.FILE]}>
              <FormControl fullWidth>
                <TsTextField
                  autoFocus
                  disabled={isTyping || isLoading.current}
                  name="entryName"
                  placeholder={t('core:yourMessageForAI')}
                  onChange={handleInputChange}
                  multiline
                  minRows={1}
                  maxRows={6}
                  value={chatMsg.current}
                  retrieveValue={() => chatMsg.current}
                  updateValue={(value) => {
                    chatMsg.current = value;
                    forceUpdate();
                  }}
                  inputRef={textInputRef}
                  sx={{
                    '& .MuiInputBase-root': { padding: '4px' },
                  }}
                  onKeyDown={(event) => {
                    if (
                      (event.key === 'Enter' || event.code === 'Enter') &&
                      !event.shiftKey &&
                      // IME: Enter confirms the candidate (composition), it
                      // must not send the message mid-typing (CJK input)
                      !event.nativeEvent.isComposing &&
                      event.keyCode !== 229
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      handleChatMessage();
                    } else if (event.key === 'ArrowUp') {
                      if (chatMsg.current.trim() === '') {
                        event.preventDefault();
                        const newIndex = Math.min(
                          historyIndex + 1,
                          promptHistory.length - 1,
                        );
                        if (newIndex >= 0 && newIndex < promptHistory.length) {
                          setHistoryIndex(newIndex);
                          chatMsg.current = promptHistory[newIndex];
                          forceUpdate();
                        }
                      }
                    } else if (event.key === 'ArrowDown') {
                      if (chatMsg.current.trim() === '') {
                        event.preventDefault();
                        if (historyIndex > 0) {
                          const newIndex = historyIndex - 1;
                          setHistoryIndex(newIndex);
                          chatMsg.current = promptHistory[newIndex];
                          forceUpdate();
                        } else if (historyIndex === 0) {
                          setHistoryIndex(-1);
                          chatMsg.current = '';
                          forceUpdate();
                        }
                      }
                    }
                  }}
                  slotProps={{
                    input: {
                      startAdornment: (
                        <InputAdornment position="start">
                          <Button
                            size="small"
                            data-tid="modelPickerTID"
                            onClick={(e) => setModelMenuAnchor(e.currentTarget)}
                            endIcon={<ArrowDropUpIcon />}
                            sx={{
                              minWidth: 0,
                              textTransform: 'none',
                              maxWidth: 130,
                              overflow: 'hidden',
                              paddingX: 0.5,
                            }}
                          >
                            {currentModel?.name || t('core:chooseModel')}
                          </Button>
                          <Menu
                            data-tid="modelPickerMenuTID"
                            anchorEl={modelMenuAnchor}
                            open={Boolean(modelMenuAnchor)}
                            onClose={() => setModelMenuAnchor(null)}
                            anchorOrigin={{
                              vertical: 'bottom',
                              horizontal: 'left',
                            }}
                            transformOrigin={{
                              vertical: 'bottom',
                              horizontal: 'left',
                            }}
                          >
                            {Array.from(
                              new Set<string>([
                                ...(currentModel?.name
                                  ? [currentModel.name]
                                  : []),
                                ...(aiDefaultProvider.customModels || []),
                                ...(models || [])
                                  .map((m) => m.name)
                                  .filter(Boolean),
                              ]),
                            ).map((name) => (
                              <MenuItem
                                key={name}
                                selected={name === currentModel?.name}
                                onClick={() => {
                                  handleChangeModel(name);
                                  setModelMenuAnchor(null);
                                }}
                              >
                                {name}
                              </MenuItem>
                            ))}
                          </Menu>
                        </InputAdornment>
                      ),
                      endAdornment: (
                        <InputAdornment position="end" sx={{ height: 32 }}>
                          {isLoading.current && (
                            <CircularProgress size={24} color="inherit" />
                          )}
                          {isLoading.current && (
                            <TsIconButton
                              tooltip={t('core:cancelAnswerGeneration')}
                              onClick={() => {
                                isLoading.current = false;
                                cancelMessage();
                              }}
                            >
                              <CancelIcon />
                            </TsIconButton>
                          )}
                          <TsIconButton
                            tooltip={`${t('core:send')} -> ${aiDefaultProvider?.name} - ${aiDefaultProvider?.url}`}
                            onClick={handleChatMessage}
                          >
                            <SendIcon />
                          </TsIconButton>
                        </InputAdornment>
                      ),
                    },
                  }}
                />
                <FormHelperText sx={{ margin: '0 auto' }}>
                  {t('core:aiHelp', {
                    chatModel: currentModel && `(${currentModel.name})`,
                  })}
                </FormHelperText>
              </FormControl>
            </ChatDndTargetFile>
          </Grid>
        </Grid>
      </Grid>
    </Box>
  );
}

export default ChatView;
