import type { SelectOption } from '@/components/ui/Select';

/** The two fields a model contributes to a picker row. */
interface NamedModel {
  readonly modelId: string;
  readonly displayName: string;
}

/**
 * A model picker's option list: the "use whatever the chat is on" row first,
 * then every model in the order the caller lists them.
 *
 * Three settings fields choose a model this way — the summary model, the chat
 * title model and the commit message model — and each carried its own copy of
 * the `modelId`/`displayName` mapping plus the spread that puts a
 * no-longer-catalogued model in front of the live ones. Three copies is three
 * places for a picker to start showing raw ids.
 *
 * // Usage: modelSelectOptions({ value: '', label: labels.modelCurrent }, missingModel, catalog.textModels)
 */
export function modelSelectOptions(
  fallback: SelectOption,
  ...modelLists: ReadonlyArray<readonly NamedModel[]>
): SelectOption[] {
  return [
    fallback,
    ...modelLists.flatMap((models) =>
      models.map((model) => ({ value: model.modelId, label: model.displayName }))
    ),
  ];
}
