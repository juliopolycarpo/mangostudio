import { register as registerApplyPatchTool } from './builtin/apply-patch';
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

/**
 * Registers every bundled tool. Runtime-specific eligibility is resolved from
 * the selected environment's capability manifest for each turn.
 * // Usage: registerTools()
 */
export function registerTools(): void {
  registerGetCurrentDatetimeTool();
  registerGenerateImageTool();
  registerReadFileTool();
  registerWriteFileTool();
  registerEditFileTool();
  registerReplaceRangeTool();
  registerApplyPatchTool();
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
  registerBashTool();
  registerZshTool();
  registerPowerShellTool();
}
