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
 *
 */

import React, {
  createContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ConfirmDialog from '-/components/dialogs/ConfirmDialog';
import { setGlobalErrorNotifier } from '-/services/globalErrorHandlers';

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
    callback?: (result: boolean | string) => void,
    cancelTID?: string,
    confirmTID?: string,
    confirmDialogContentTID?: string,
    list?: string[],
    prompt?: string,
    help?: string,
    customConfirmText?: string,
    customCancelText?: string,
    onDismiss?: () => void,
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
  //NotificationTypes: 'default' | 'error';
};

export const NotificationContext = createContext<NotificationContextData>({
  openConfirmDialog: undefined,
  closeConfirmDialog: undefined,
  notificationStatus: undefined,
  showNotification: () => {},
  hideNotifications: () => {},
  isGeneratingThumbs: false,
  setGeneratingThumbs: () => {},
  //NotificationTypes: 'default'
});

export type NotificationContextProviderProps = {
  children: React.ReactNode;
};

export const NotificationContextProvider = ({
  children,
}: NotificationContextProviderProps) => {
  const [isConfirmDialogOpened, setConfirmDialogOpened] =
    useState<boolean>(false);
  const confirmTitle = useRef<string>('Confirm Dialog');
  const confirmDescription = useRef<string>('');
  const confirmCallback = useRef<(result: boolean | string) => void>(undefined);
  const cancelDialogTID = useRef<string>('cancelDialogTID');
  const confirmDialogTID = useRef<string>('confirmDialogTID');
  const confirmDialogContentTID = useRef<string>('confirmDialogContentTID');
  const listItems = useRef<string[]>(undefined);
  const prompt = useRef<string>(undefined);
  const help = useRef<string>(undefined);
  const customConfirmText = useRef<string>(undefined);
  const customCancelText = useRef<string>(undefined);
  /** Caller-provided dismissal handler for the currently open dialog. */
  const dismissHandlerRef = useRef<(() => void) | undefined>(undefined);
  const [notificationStatus, setNotificationStatus] = useState<any>({
    visible: false,
    text: null,
    notificationType: 'default',
    autohide: true,
  });
  const [isGeneratingThumbs, setGeneratingThumbs] = useState<boolean>(false);

  function openConfirmDialog(
    title: string,
    description: string,
    callback = undefined,
    cancelTID = 'cancelDialogTID',
    confirmTID = 'confirmDialogTID',
    confirmContentTID = 'confirmDialogContentTID',
    list: string[] = undefined,
    promptTxt: string = undefined,
    helpTxt: string = undefined,
    confirmText: string = undefined,
    cancelText: string = undefined,
    onDismiss = undefined,
  ) {
    confirmTitle.current = title;
    confirmDescription.current = description;
    confirmCallback.current = callback;
    cancelDialogTID.current = cancelTID;
    confirmDialogTID.current = confirmTID;
    confirmDialogContentTID.current = confirmContentTID;
    listItems.current = list;
    prompt.current = promptTxt;
    customConfirmText.current = confirmText;
    customCancelText.current = cancelText;
    help.current = helpTxt;
    dismissHandlerRef.current = onDismiss;
    setConfirmDialogOpened(true);
  }

  // Dismissal (Esc / ✕ / backdrop) fires no button callback — invoke the
  // caller's onDismiss so async callers (e.g. agent exec authorization) never
  // hang, then close. Consumed once per open.
  function handleConfirmDismiss() {
    const handler = dismissHandlerRef.current;
    dismissHandlerRef.current = undefined;
    if (handler) {
      handler();
    }
    setConfirmDialogOpened(false);
  }

  function closeConfirmDialog() {
    setConfirmDialogOpened(false);
  }

  function showNotification(
    text: string,
    notificationType = 'default',
    autohide = true,
    tid = 'notificationTID',
  ) {
    setNotificationStatus({
      visible: true,
      text,
      tid,
      notificationType,
      autohide,
    });
  }

  useEffect(() => {
    setGlobalErrorNotifier((text, notificationType, autohide, tid) => {
      setNotificationStatus({
        visible: true,
        text,
        tid: tid ?? 'globalErrorTID',
        notificationType: notificationType ?? 'error',
        autohide: autohide ?? true,
      });
    });
    return () => setGlobalErrorNotifier(null);
  }, []);

  function hideNotifications(excludeTypes = []) {
    if (
      !excludeTypes.some((type) => type === notificationStatus.notificationType)
    ) {
      setNotificationStatus({
        visible: false,
        text: null,
        notificationType: 'default',
        autohide: true,
      });
    }
  }

  const context = useMemo(() => {
    return {
      notificationStatus,
      /*NotificationTypes: {
        default: 'default',
        error: 'error'
      },*/
      isGeneratingThumbs,
      setGeneratingThumbs,
      showNotification,
      hideNotifications,
      openConfirmDialog,
      closeConfirmDialog,
    };
  }, [notificationStatus, isGeneratingThumbs]);

  return (
    <NotificationContext.Provider value={context}>
      {children}
      <ConfirmDialog
        open={isConfirmDialogOpened}
        onClose={() => setConfirmDialogOpened(false)}
        onDismiss={handleConfirmDismiss}
        title={confirmTitle.current}
        content={confirmDescription.current}
        confirmCallback={confirmCallback.current}
        cancelDialogTID={cancelDialogTID.current}
        confirmDialogTID={confirmDialogTID.current}
        confirmDialogContentTID={confirmDialogContentTID.current}
        list={listItems.current}
        prompt={prompt.current}
        helpText={help.current}
        customConfirmText={customConfirmText.current}
        customCancelText={customCancelText.current}
      />
    </NotificationContext.Provider>
  );
};
