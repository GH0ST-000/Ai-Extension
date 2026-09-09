export type {
  EditableKind,
  EditableSelectionSnapshot,
  EditableTarget,
  ReplaceableEditableTarget,
  ReplacementResult,
} from './editing.types';
export {
  detectEditableTarget,
  detectEditableTargetFromSelection,
  isReplaceableTarget,
} from './editable-target.detector';
export { captureEditableSelectionSnapshot, snapshotSupportsReplace } from './selection-snapshot';
export { replaceEditableSelection } from './selection-replacer';
