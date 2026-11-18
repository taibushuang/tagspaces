/**
 * TagSpaces - universal file and folder organizer
 * Copyright (C) 2023-present TagSpaces GmbH
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
 */

/**
 * Context object + types live in a leaf module (no imports from components)
 * so `useNotificationContext` does not import the provider. The provider
 * imports ConfirmDialog, which (through TsButton → SettingsDialog → SettingsAI)
 * reaches the hook again — keeping the context here breaks that import cycle.
 */
import { createContext } from 'react';

type NotificationStatus = {
  visible: boolean;
  text: string;
  tid: string;
  notificationType: 'default' | 'info' | 'warning' | 'error';
  autohide: boolean;
};

export type NotificationContextData = {
  openConfirmDialog: (
    title: string,
    description: string,
    callback?: (result: boolean | string, checked?: boolean) => void,
    cancelTID?: string,
    confirmTID?: string,
    confirmDialogContentTID?: string,
    list?: string[],
    prompt?: string,
    help?: string,
    customConfirmText?: string,
    customCancelText?: string,
    onDismiss?: () => void,
    /** Optional checkbox rendered above the action buttons. */
    checkLabel?: string,
    checkDefaultChecked?: boolean,
  ) => void;
  closeConfirmDialog: () => void;
  notificationStatus: NotificationStatus;
  showNotification: (
    text: string,
    notificationType?: 'default' | 'info' | 'warning' | 'error',
    autohide?: boolean,
    tid?: string,
  ) => void;
  hideNotifications: (excludeTypes?: string[]) => void;
  isGeneratingThumbs: boolean;
  setGeneratingThumbs: (isGen: boolean) => void;
  // NotificationTypes: 'default' | 'error';
};

export const NotificationContext = createContext<NotificationContextData>({
  openConfirmDialog: undefined,
  closeConfirmDialog: undefined,
  notificationStatus: undefined,
  showNotification: () => {},
  hideNotifications: () => {},
  isGeneratingThumbs: false,
  setGeneratingThumbs: () => {},
  // NotificationTypes: 'default'
});
