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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ConfirmDialog from '-/components/dialogs/ConfirmDialog';
import { NotificationContext } from '-/hooks/notificationContext';
import { setGlobalErrorNotifier } from '-/services/globalErrorHandlers';

export type NotificationContextProviderProps = {
  children: React.ReactNode;
};

export function NotificationContextProvider({
  children,
}: NotificationContextProviderProps) {
  const [isConfirmDialogOpened, setConfirmDialogOpened] =
    useState<boolean>(false);
  const confirmTitle = useRef<string>('Confirm Dialog');
  const confirmDescription = useRef<string>('');
  const confirmCallback =
    useRef<(result: boolean | string, checked?: boolean) => void>(undefined);
  const cancelDialogTID = useRef<string>('cancelDialogTID');
  const confirmDialogTID = useRef<string>('confirmDialogTID');
  const confirmDialogContentTID = useRef<string>('confirmDialogContentTID');
  const listItems = useRef<string[]>(undefined);
  const prompt = useRef<string>(undefined);
  const help = useRef<string>(undefined);
  const customConfirmText = useRef<string>(undefined);
  const customCancelText = useRef<string>(undefined);
  const checkLabelRef = useRef<string>(undefined);
  const checkDefaultCheckedRef = useRef<boolean>(false);
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
    checkLabelTxt: string = undefined,
    checkDefault = false,
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
    checkLabelRef.current = checkLabelTxt;
    checkDefaultCheckedRef.current = checkDefault;
    dismissHandlerRef.current = onDismiss;
    setConfirmDialogOpened(true);
  }

  // Dismissal (Esc / ✕ / backdrop) fires no button callback — invoke the
  // caller's onDismiss so async callers (e.g. agent exec authorization) never
  // hang, then close. Consumed once per open.
  const handleConfirmDismiss = useCallback(() => {
    const handler = dismissHandlerRef.current;
    dismissHandlerRef.current = undefined;
    if (handler) {
      handler();
    }
    setConfirmDialogOpened(false);
  }, []);

  const closeConfirmDialog = useCallback(() => {
    setConfirmDialogOpened(false);
  }, []);

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

  const hideNotifications = useCallback(
    (excludeTypes: string[] = []) => {
      if (
        !excludeTypes.some(
          (type) => type === notificationStatus.notificationType,
        )
      ) {
        setNotificationStatus({
          visible: false,
          text: null,
          notificationType: 'default',
          autohide: true,
        });
      }
    },
    [notificationStatus],
  );

  const context = useMemo(() => {
    return {
      notificationStatus,
      /* NotificationTypes: {
        default: 'default',
        error: 'error'
      }, */
      isGeneratingThumbs,
      setGeneratingThumbs,
      showNotification,
      hideNotifications,
      openConfirmDialog,
      closeConfirmDialog,
    };
  }, [
    notificationStatus,
    isGeneratingThumbs,
    hideNotifications,
    closeConfirmDialog,
  ]);

  return (
    <NotificationContext.Provider value={context}>
      {children}
      <ConfirmDialog
        open={isConfirmDialogOpened}
        onClose={closeConfirmDialog}
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
        checkLabel={checkLabelRef.current}
        checkDefaultChecked={checkDefaultCheckedRef.current}
      />
    </NotificationContext.Provider>
  );
}
