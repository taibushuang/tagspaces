/**
 * AI capabilities center — open/close state for the inline "挤占式" panel.
 * The panel itself is rendered by the content area (RenderPerspective) via
 * props; this provider only holds the toggle so any entry point (toolbar,
 * settings, AI dialog) can switch it on.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';

type AiCapabilitiesContextData = {
  isAiCapabilitiesOpen: boolean;
  toggleAiCapabilities: () => void;
};

export const AiCapabilitiesContext = createContext<AiCapabilitiesContextData>({
  isAiCapabilitiesOpen: false,
  toggleAiCapabilities: () => {},
});

export type AiCapabilitiesContextProviderProps = {
  children: React.ReactNode;
};

export function AiCapabilitiesContextProvider({
  children,
}: AiCapabilitiesContextProviderProps) {
  const [isAiCapabilitiesOpen, setIsAiCapabilitiesOpen] =
    useState<boolean>(false);

  const toggleAiCapabilities = useCallback(() => {
    setIsAiCapabilitiesOpen((open) => !open);
  }, []);

  const context = useMemo(
    () => ({ isAiCapabilitiesOpen, toggleAiCapabilities }),
    [isAiCapabilitiesOpen, toggleAiCapabilities],
  );

  return (
    <AiCapabilitiesContext.Provider value={context}>
      {children}
    </AiCapabilitiesContext.Provider>
  );
}

export const useAiCapabilitiesContext = () => useContext(AiCapabilitiesContext);
