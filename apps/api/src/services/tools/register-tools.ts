import { isShellAvailable } from './builtin/_shell-exec';
import { register as registerAskUserQuestionTool } from './builtin/ask-user-question';
import { register as registerBashTool } from './builtin/bash';
import { register as registerCreateFileTool } from './builtin/create-file';
import { register as registerDelegateToAgentTool } from './builtin/delegate-to-agent';
import { register as registerDeleteFileTool } from './builtin/delete-file';
import { register as registerEditFileTool } from './builtin/edit-file';
import { register as registerGenerateImageTool } from './builtin/generate-image';
import { register as registerGetCurrentDatetimeTool } from './builtin/get-current-datetime';
import { register as registerGlobTool } from './builtin/glob';
import { register as registerGrepTool } from './builtin/grep';
import { register as registerListDirectoryTool } from './builtin/list-directory';
import { register as registerMoveFileTool } from './builtin/move-file';
import { register as registerPowerShellTool } from './builtin/powershell';
import { register as registerReadFileTool } from './builtin/read-file';
import { register as registerReplaceRangeTool } from './builtin/replace-range';
import { register as registerSkillTool } from './builtin/skill';
import { register as registerTodoTools } from './builtin/todo';
import { register as registerWriteFileTool } from './builtin/write-file';
import { register as registerZshTool } from './builtin/zsh';

/** Registers all bundled tools available on this host. // Usage: registerTools() */
export function registerTools(): void {
  registerGetCurrentDatetimeTool();
  registerGenerateImageTool();
  registerReadFileTool();
  registerWriteFileTool();
  registerEditFileTool();
  registerReplaceRangeTool();
  registerCreateFileTool();
  registerDeleteFileTool();
  registerMoveFileTool();
  registerListDirectoryTool();
  registerGlobTool();
  registerGrepTool();
  registerDelegateToAgentTool();
  registerSkillTool();
  registerAskUserQuestionTool();
  registerTodoTools();
  registerAvailableShellTools();
}

function registerAvailableShellTools(): void {
  if (isShellAvailable('bash')) registerBashTool();
  if (isShellAvailable('zsh')) registerZshTool();
  if (isShellAvailable('powershell')) registerPowerShellTool();
}
