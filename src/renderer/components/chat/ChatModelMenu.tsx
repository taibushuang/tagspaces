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
 * Provider-grouped model picker menu, shared by AgentPanel and ChatView.
 * Every enabled provider renders as a subheader with its models beneath it
 * (the provider's defaultTextModel + customModels, plus its live endpoint
 * listing fetched when the menu opens). Picking a model from a provider other
 * than the current one switches the chat provider via
 * ChatProvider.selectChatModel — subsequent chats/runs use that provider.
 */
import { AIProvider } from '-/components/chat/ChatTypes';
import { useChatContext } from '-/hooks/useChatContext';
import { getAIProviders } from '-/reducers/settings';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListSubheader from '@mui/material/ListSubheader';
import { Fragment, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';

interface Props {
  anchorEl: null | HTMLElement;
  open: boolean;
  onClose: () => void;
  onSelect: (providerId: string, modelName: string) => void;
}

function ChatModelMenu(props: Props) {
  const { anchorEl, open, onClose, onSelect } = props;
  const { currentModel, currentProvider, getAiClient } = useChatContext();
  const aiProviders: AIProvider[] = useSelector(getAIProviders);
  const [endpointModels, setEndpointModels] = useState<
    Record<string, string[]>
  >({});

  // Live endpoint listing per enabled provider; configured models
  // (defaultTextModel/customModels) render immediately, fetched ones join in.
  useEffect(() => {
    if (!open || !getAiClient) {
      return undefined;
    }
    let active = true;
    (async () => {
      const enabled = aiProviders.filter((p) => p.enable && p.url);
      const pairs = await Promise.all(
        enabled.map(async (p) => {
          try {
            const client = await getAiClient(p);
            const list = client ? await client.list() : undefined;
            return [
              p.id,
              (list || []).map((m) => m.name).filter(Boolean),
            ] as const;
          } catch (e) {
            return [p.id, []] as const;
          }
        }),
      );
      if (active) {
        setEndpointModels(Object.fromEntries(pairs));
      }
    })();
    return () => {
      active = false;
    };
  }, [open, aiProviders, getAiClient]);

  return (
    <Menu
      data-tid="modelPickerMenuTID"
      anchorEl={anchorEl}
      open={open}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
    >
      {aiProviders
        .filter((p) => p.enable && p.url)
        .map((provider) => (
          <Fragment key={provider.id}>
            <ListSubheader sx={{ lineHeight: '28px' }}>
              {provider.name}
              {currentProvider?.id === provider.id ? ' ✓' : ''}
            </ListSubheader>
            {Array.from(
              new Set<string>(
                [
                  ...(provider.defaultTextModel
                    ? [provider.defaultTextModel]
                    : []),
                  ...(provider.customModels || []),
                  ...(endpointModels[provider.id] || []),
                  ...(currentProvider?.id === provider.id && currentModel?.name
                    ? [currentModel.name]
                    : []),
                ].filter(Boolean),
              ),
            ).map((name) => (
              <MenuItem
                key={name}
                selected={
                  currentProvider?.id === provider.id &&
                  name === currentModel?.name
                }
                onClick={() => {
                  onSelect(provider.id, name);
                  onClose();
                }}
              >
                {name}
              </MenuItem>
            ))}
          </Fragment>
        ))}
    </Menu>
  );
}

export default ChatModelMenu;
