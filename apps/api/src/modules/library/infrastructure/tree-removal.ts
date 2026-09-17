/**
 * Hub-side re-exports of staged tree removal. The rename-based removal engine
 * lives in `@mangostudio/shared/library/machine`; hub preview/apply and doctor
 * checks keep this import path.
 */

export {
  findStagedRemovalLeftovers,
  findStagedRemovalsForLocations,
  nodeTreeRemovalFs,
  stagedRemovalDirectory,
  stageResourceRemoval,
  type TreeRemovalFs,
} from '@mangostudio/shared/library/machine';
