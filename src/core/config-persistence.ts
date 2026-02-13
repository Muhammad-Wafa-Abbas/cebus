/**
 * Persists the last onboarding configuration so users can quickly
 * restore it on the next startup instead of going through onboarding again.
 *
 * Stored as `.cebus/last-config.json` in the current working directory.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ChatMode, OrchestratorConfig } from './types';

export interface SavedConfig {
  selectedModels: string[];
  folderAccess: boolean;
  chatMode: ChatMode;
  /** role spec → role id */
  roleAssignments: Record<string, string>;
  orchestratorConfig?: OrchestratorConfig | undefined;
  /** ISO timestamp of when this config was saved */
  savedAt: string;
}

function getConfigPath(): string {
  return path.join(process.cwd(), '.cebus', 'last-config.json');
}

export function saveLastConfig(
  selectedModels: string[],
  folderAccess: boolean,
  chatMode: ChatMode,
  roleAssignments: Map<string, string>,
  orchestratorConfig?: OrchestratorConfig | undefined,
): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const config: SavedConfig = {
    selectedModels,
    folderAccess,
    chatMode,
    roleAssignments: Object.fromEntries(roleAssignments),
    orchestratorConfig,
    savedAt: new Date().toISOString(),
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

export function loadLastConfig(): SavedConfig | null {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as SavedConfig;
  } catch {
    return null;
  }
}
