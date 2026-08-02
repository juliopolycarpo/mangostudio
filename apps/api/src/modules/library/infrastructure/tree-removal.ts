/**
 * Hub-side re-exports of staged tree removal. The rename-based removal engine
 * lives in `@mangostudio/runtime`; hub preview/apply and doctor checks keep
 * this import path.
 */

export {
  findStagedRemovalLeftovers,
  findStagedRemovalsForLocations,
  nodeTreeRemovalFs,
  stagedRemovalDirectory,
  stageResourceRemoval,
  type TreeRemovalFs,
} from '@mangostudio/runtime';
