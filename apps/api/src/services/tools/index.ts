/**
 * Tool registry barrel — exports registry helpers and registers all builtins.
 */

export * from './registry';
export * from './types';

// Register all builtins on import
import './builtin/get-current-datetime';
import './builtin/generate-image';
import './builtin/read-file';
import './builtin/list-directory';
import './builtin/glob';
import './builtin/grep';
import './builtin/delegate-to-agent';
import './builtin/bash';
import './builtin/zsh';
import './builtin/powershell';
