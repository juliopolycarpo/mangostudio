/**
 * Tool registry barrel — exports registry helpers and registers all builtins.
 */

export * from './types';
export * from './registry';

// Register all builtins on import
import './builtin/get-current-datetime';
