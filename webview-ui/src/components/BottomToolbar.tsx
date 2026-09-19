import { useEffect, useRef, useState } from 'react';

import type { PreviousSession } from '../../../core/src/messages.js';
import type { WorkspaceFolder } from '../hooks/useExtensionMessages.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';
import { Dropdown, DropdownItem } from './ui/Dropdown.js';

interface BottomToolbarProps {
  isEditMode: boolean;
  onOpenClaude: () => void;
  onToggleEditMode: () => void;
  isSettingsOpen: boolean;
  onToggleSettings: () => void;
  workspaceFolders: WorkspaceFolder[];
  previousSessions: PreviousSession[];
}

export function BottomToolbar({
  isEditMode,
  onOpenClaude,
  onToggleEditMode,
  isSettingsOpen,
  onToggleSettings,
  workspaceFolders,
  previousSessions,
}: BottomToolbarProps) {
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);
  const [isBypassMenuOpen, setIsBypassMenuOpen] = useState(false);
  const [previousSessionSearch, setPreviousSessionSearch] = useState('');
  const folderPickerRef = useRef<HTMLDivElement>(null);
  const pendingBypassRef = useRef(false);
  // Close folder picker / bypass menu on outside click
  useEffect(() => {
    if (!isFolderPickerOpen && !isBypassMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (folderPickerRef.current && !folderPickerRef.current.contains(e.target as Node)) {
        setIsFolderPickerOpen(false);
        setIsBypassMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isFolderPickerOpen, isBypassMenuOpen]);

  const hasMultipleFolders = workspaceFolders.length > 1;
  const hasPreviousSessions = previousSessions.length > 0;
  const searchTerm = previousSessionSearch.trim().toLowerCase();
  const filteredPreviousSessions = previousSessions.filter((session) =>
    [session.displayName, session.folderName, session.folderPath].some((value) =>
      value.toLowerCase().includes(searchTerm),
    ),
  );
  const previousSessionsByFolder = new Map<string, PreviousSession[]>();
  for (const session of filteredPreviousSessions) {
    const sessions = previousSessionsByFolder.get(session.folderPath) ?? [];
    sessions.push(session);
    previousSessionsByFolder.set(session.folderPath, sessions);
  }

  const handleAgentClick = () => {
    setIsBypassMenuOpen(false);
    pendingBypassRef.current = false;
    if (isBrowserRuntime || hasMultipleFolders || hasPreviousSessions) {
      setIsFolderPickerOpen((v) => !v);
    } else {
      onOpenClaude();
    }
  };

  const handleAgentHover = () => {
    if (!isFolderPickerOpen) {
      setIsBypassMenuOpen(true);
    }
  };

  const handleAgentLeave = () => {
    if (!isFolderPickerOpen) {
      setIsBypassMenuOpen(false);
    }
  };

  const handleFolderSelect = (folder: WorkspaceFolder) => {
    setIsFolderPickerOpen(false);
    const bypassPermissions = pendingBypassRef.current;
    pendingBypassRef.current = false;
    transport.send({ type: 'launchAgent', folderPath: folder.path, bypassPermissions });
  };

  const handlePreviousSessionSelect = (session: PreviousSession) => {
    setIsFolderPickerOpen(false);
    setPreviousSessionSearch('');
    pendingBypassRef.current = false;
    transport.send({
      type: 'launchAgent',
      sessionId: session.sessionId,
      folderPath: session.folderPath,
    });
  };

  const handleBypassSelect = (bypassPermissions: boolean) => {
    setIsBypassMenuOpen(false);
    if (hasMultipleFolders) {
      pendingBypassRef.current = bypassPermissions;
      setIsFolderPickerOpen(true);
    } else {
      transport.send({ type: 'launchAgent', bypassPermissions });
    }
  };

  return (
    <div className="absolute bottom-10 left-10 z-20 flex items-center gap-4 pixel-panel p-4">
      <div
        ref={folderPickerRef}
        className="relative"
        onMouseEnter={handleAgentHover}
        onMouseLeave={handleAgentLeave}
      >
        <Button
          variant="accent"
          onClick={handleAgentClick}
          className={
            isFolderPickerOpen || isBypassMenuOpen
              ? 'bg-accent-bright'
              : 'bg-accent hover:bg-accent-bright'
          }
        >
          + Agent
        </Button>
        <Dropdown isOpen={isBypassMenuOpen}>
          <DropdownItem onClick={() => handleBypassSelect(true)}>
            Skip permissions mode <span className="text-2xs text-warning">⚠</span>
          </DropdownItem>
        </Dropdown>
        <Dropdown
          isOpen={isFolderPickerOpen}
          className="min-w-[34rem] max-h-[70vh] overflow-y-auto"
        >
          <div className="px-12 pb-2 text-2xs font-bold tracking-wide opacity-70">NEW AGENT</div>
          {workspaceFolders.map((folder) => (
            <DropdownItem
              key={folder.path}
              onClick={() => handleFolderSelect(folder)}
              className="text-base"
            >
              {folder.name}
            </DropdownItem>
          ))}
          {hasPreviousSessions && (
            <>
              <div className="mt-4 border-t-2 border-border px-12 pt-3 pb-2 text-2xs font-bold tracking-wide opacity-70">
                RE-EMPLOY PREVIOUS AGENT
              </div>
              <input
                type="search"
                value={previousSessionSearch}
                onChange={(event) => setPreviousSessionSearch(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                placeholder="Search previous agents…"
                aria-label="Search previous agents"
                className="mx-12 mb-2 box-border w-[calc(100%-6rem)] border-2 border-border bg-bg px-3 py-2 text-sm outline-none"
              />
              {filteredPreviousSessions.length > 0 ? (
                [...previousSessionsByFolder.entries()].map(([folderPath, sessions]) => (
                  <div key={folderPath}>
                    <div className="px-12 pt-3 pb-1 text-sm font-bold break-all">{folderPath}</div>
                    {sessions.map((session) => (
                      <DropdownItem
                        key={session.sessionId}
                        onClick={() => handlePreviousSessionSelect(session)}
                        className="text-base whitespace-normal pl-20"
                      >
                        <span className="block">{session.displayName}</span>
                      </DropdownItem>
                    ))}
                  </div>
                ))
              ) : (
                <div className="px-12 py-3 text-sm opacity-70">No previous agents found.</div>
              )}
            </>
          )}
        </Dropdown>
      </div>
      <Button
        variant={isEditMode ? 'active' : 'default'}
        onClick={onToggleEditMode}
        title="Edit office layout"
      >
        Layout
      </Button>
      <Button
        variant={isSettingsOpen ? 'active' : 'default'}
        onClick={onToggleSettings}
        title="Settings"
      >
        Settings
      </Button>
    </div>
  );
}
