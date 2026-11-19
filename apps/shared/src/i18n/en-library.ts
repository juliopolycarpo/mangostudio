import type { FeatureMessages } from './types';

/**
 * The English `library` keys the first paint does not read (the rest stay in `en.ts`).
 * The feature's lazy chunk imports this file, so the strings arrive with the code
 * that renders them (see `FeatureNamespace` in `types.ts`).
 */
export const messages: FeatureMessages<'library'> = {
  library: {
    title: 'Library',
    subtitle: 'What each agent sees, where it lives, and where the copies disagree.',
    tabs: {
      skills: 'Skills',
      subagents: 'Subagents',
      commands: 'Commands',
      instructions: 'Instructions',
      settings: 'Settings',
      locations: 'Locations',
    },
    // The raw contract state, used by the detail view's coverage list.
    coverage: {
      present: 'Present',
      absent: 'Absent',
      shadowed: 'Shadowed',
    },
    divergence: {
      single: 'One copy',
      uniform: 'Copies identical',
      divergent: 'Copies differ',
      'not-comparable': 'Not comparable',
      incomparable: 'Hash versions differ',
    },
    // One label per matrix glyph. Nothing here calls an absence "missing": a
    // resource Cursor does not have is usually absent on purpose.
    cellState: {
      'scan-incomplete': 'Coverage could not be verified',
      present: 'Present',
      absent: 'Absent',
      shadowed: 'Shadowed, identical',
      divergent: 'Differs from the other copies',
      'only-here': 'Only here',
      incomparable: 'Cannot compare',
    },
    cellHint: {
      'scan-incomplete': 'Some locations this agent reads could not be scanned.',
      present: 'This agent reads one copy of this resource.',
      absent: 'This agent reads no copy — which is often correct.',
      shadowed: 'Two copies in different locations, holding the same content.',
      divergent: 'The content here is not the same as the other copies.',
      'only-here': 'This is the only agent that reads the resource.',
      incomparable:
        'These copies were hashed by different runtime versions, so the hashes cannot be compared.',
    },
    invalidReason: {
      'path-escape': 'The path points outside the location.',
      'invalid-slug': 'The name is not usable as a file or directory.',
      'missing-entrypoint': 'The entrypoint file does not exist.',
      'unexpected-entry-type': 'The entry is not the expected type.',
      unreadable: 'The content could not be read.',
      'too-large': 'The content exceeds the read limit.',
      'invalid-metadata': 'The metadata could not be parsed.',
      'unsafe-name': 'One of its internal file names cannot be safely represented.',
    },
    // Entries that could not even be named as a resource (#705) — a name has to
    // pass this pattern before it can be anything more specific.
    scanDiagnostics: {
      heading: 'Some library locations could not be scanned',
      legacy:
        'This runtime does not report location scan failures. Update it to distinguish empty locations from failed scans.',
      reason: {
        'permission-denied': 'Permission denied. Check access to this location.',
        'not-directory': 'This path does not resolve to a directory.',
        unreadable: 'This location could not be read. Check the path and try again.',
      },
    },
    unreadable: {
      heading: 'Unrecognised entries',
      rule: 'Names may only use letters, numbers, "_", "-", and ".", with no spaces or other characters.',
      reason: {
        'invalid-name': 'This name does not match the allowed pattern.',
      },
    },
    format: {
      'markdown-plain': 'Markdown',
      'markdown-frontmatter': 'Markdown with frontmatter',
      mdc: 'MDC',
      'toml-agent': 'TOML agent',
      'agent-profile-db': 'Database profile',
      'json-settings': 'JSON settings',
      'toml-settings': 'TOML settings',
      'rules-dsl': 'Rules',
    },
    filters: {
      search: 'Filter by name',
      target: 'Agent',
      // The select's own label ("Agent:") already says what is being chosen.
      anyTarget: 'Any',
      location: 'Location',
      anyLocation: 'Any',
      show: 'Show',
      showAll: 'Everything',
      showDivergent: 'Only divergent',
      showSingleLocation: 'Only present in one place',
      showShadowed: 'Only shadowed',
      sort: 'Sort',
      sortName: 'Name',
      sortDivergence: 'Divergence',
      sortCoverage: 'Coverage',
      sortModified: 'Modified',
      groupByLocation: 'Group by location',
      // The phone's one button for every control but the search.
      toggle: 'Filters',
    },
    tooltip: {
      path: 'Path',
      hash: 'Content',
      modified: 'Modified',
      alsoIn: 'Also in',
      absent: 'No copy in any location this agent reads.',
    },
    detail: {
      back: 'Back to the matrix',
      contentHeading: 'Content',
      coverageHeading: 'Coverage',
      // `*One` / `*Other` pair: the component picks by count (`usePlural`).
      copiesOne: '{count} copy',
      copiesOther: '{count} copies',
      modified: 'modified {when}',
      compare: 'Compare {left} ↔ {right}',
      compareHide: 'Close comparison',
      compareSelect: 'Pick two versions to compare.',
      // Introduces a path set on its own line below it, so no placeholder.
      via: 'Read from',
      alsoIn: 'Also in',
      // The badge beside each shadowed copy: whether it holds the same bytes as
      // the copy the agent actually reads.
      shadowCopy: {
        identical: 'Identical',
        differs: 'Differs',
        unknown: 'Cannot compare',
      },
      propagate: 'Propagate',
      remove: 'Remove',
      notFound: 'This resource is no longer in the library.',
      loadError: 'Could not check this library resource.',
      invalidInstance: 'Unreadable copy in {location}',
      // 001 deliberately does not normalize line endings, so a CRLF/LF split is
      // a genuine divergence that looks like nothing in a diff.
      whitespaceOnlyTitle: 'The only difference is whitespace',
      whitespaceOnlyDescription:
        'The text matches once spaces, tabs, and line breaks are removed. One file saved with CRLF and another with LF genuinely diverge, even though they look identical.',
      entrypointOnly: 'The comparison covers SKILL.md; other files in the directory are not in it.',
      identicalEntrypoint:
        'The SKILL.md files are identical, so the difference is in another file in the directory.',
      notComparable:
        'This kind is read-only everywhere and each agent stores its own format, so comparing the copies says nothing actionable.',
      incomparable:
        'These copies were hashed by different runtime versions, so the hashes cannot be compared. The files may still match. Update every connected runtime to the same release, then scan again.',
    },
    diff: {
      error: 'The content of this copy could not be read.',
      identical: 'Both versions hold the same text.',
      truncated: 'The content was truncated on read, so the comparison may be incomplete.',
    },
    conflict: {
      description:
        'These resources have more than one readable version. There is no canonical copy, so the choice is yours.',
      resolved: 'Resolved',
      unresolved: '{count} resources still need a decision.',
      adopt: 'Use this version',
      keepPerLocation: {
        scanIncomplete: 'Preview again once all source copies can be read.',
        title: 'Keep them different',
        description:
          'Sometimes copies should differ. The divergence stops being flagged until one of the contents changes again.',
      },
      edit: {
        title: 'Edit before adopting',
        description:
          'Write the final text; it becomes the adopted version, a copy that exists nowhere yet.',
        placeholder: 'Final content',
        unavailable: 'A skill is a directory and cannot be adopted from edited text.',
        empty: 'Write the content before continuing.',
      },
    },
    destination: {
      description: 'Every checked location takes one write, backed up first.',
      // The most useful thing this step can say: one write can cover two agents,
      // and checking both locations creates a second copy for no reason.
      servesMultipleTargets: 'Also serves {targets}',
      readOnly: 'Read-only',
      unwritableAction: 'See in Environments',
      none: 'No location accepts writes for this kind of resource.',
      noneSelected: 'Check at least one destination.',
      currentContent: 'Holds {hash}',
      empty: 'Empty',
    },
    review: {
      summary: 'Will write {files} files and back up {backups}.',
      groupCreate: 'Create',
      groupOverwrite: 'Overwrite',
      groupAdapt: 'Convert',
      groupNoop: 'Already in sync',
      groupBlocked: 'Blocked',
      // Overwrite is the destructive operation; it never lands unseen.
      overwriteDiff: 'What is being replaced',
      apply: 'Apply',
      applying: 'Applying…',
      applyError: 'The apply failed.',
      nothingToDo: 'Nothing to write with these choices.',
    },
    adaptation: {
      heading: 'Format conversion',
      fromTo: '{from} → {to}',
      strategy: {
        verbatim: 'Verbatim copy',
        mechanical: 'Mechanical conversion',
        agent: 'Model-drafted conversion',
      },
      strategyHint: {
        verbatim: 'The bytes are copied unchanged.',
        mechanical: 'A deterministic framing transform, with no model involved.',
        agent: 'A model writes the draft. It always needs review before it is applied.',
      },
      recommended: 'Recommended',
      note: {
        'metadata-added': 'Metadata added',
        'field-dropped': 'Field dropped',
        'semantic-rewrite': 'Rewritten with a change in meaning',
      },
      // `requiresReview` is always true for the `agent` strategy.
      acknowledge: 'I have read the generated draft and accept writing it.',
      acknowledgeRequired: 'Confirm you reviewed the generated draft to continue.',
      provenance: 'Drafted by {model} (prompt {version})',
    },
    blockedReason: {
      'read-only-location': 'This location is read-only.',
      'unsupported-location': 'This location does not exist on this platform.',
      'location-unwritable': 'MangoStudio cannot write to this location.',
      'location-disabled':
        'This location is switched off in the library location settings, so it is not scanned.',
      'location-scan-failed': 'This location could not be scanned. Check access and preview again.',
      'slug-mismatch': 'This location stores a single resource, and this is not it.',
      'invalid-destination':
        'The copy already here could not be read, so overwriting it is not safe.',
      'no-source-content': 'No readable copy exists to copy from.',
      'no-adapter-strategy': "No converter knows how to reach the destination's format.",
      // The machine, rather than the location. Ordered before the location's own
      // problems because nothing can be said about a directory on a box nobody
      // could reach — and telling the user to fix the location would send them
      // after the wrong thing.
      'environment-offline': 'This machine is not connected right now.',
      'environment-unsupported': 'This machine does not offer library access.',
      'environment-readonly': "This machine's owner has not allowed writing to files here.",
      'hash-domain-mismatch':
        'This machine hashes directories with a different version than the source, so a write here cannot be verified.',
      // Removal shares this catalog; only the reason below is unique to it.
      'invalid-instance':
        'This copy could not be read end to end, so it cannot be backed up faithfully. Remove it yourself.',
    },
    skipReason: {
      'user-skipped': 'Not selected',
      'already-in-sync': 'Already in sync',
      'divergence-acknowledged': 'Divergence kept on purpose',
    },
    failureReason: {
      'guard-rejected': 'A safety check refused the write.',
      'adaptation-failed': 'The format conversion failed.',
      'write-failed': 'The write to disk failed.',
      'verification-failed': 'The bytes on disk after the write do not match what was intended.',
    },
    removalFailureReason: {
      'guard-rejected': 'A safety check refused the removal.',
      'backup-failed': 'The copy could not be backed up, so it was left alone.',
      'remove-failed': 'The removal failed.',
      'verification-failed': 'The copy was still there after being removed.',
    },
    removalKeptReason: {
      'user-kept': 'You chose to keep this copy.',
      absent: 'There was nothing at this location.',
      blocked: 'This location cannot be written to.',
      'not-attempted': 'An earlier failure stopped the removal before it reached this copy.',
      'rolled-back': 'It was put back after a later removal failed.',
    },
    removal: {
      title: 'Remove {count} resources',
      titleOne: 'Remove {kind} {resource}',
      remove: 'Remove',
      removing: 'Removing…',
      stepLocations: 'Choose copies',
      stepConfirm: 'Confirm',
      locationsDescription:
        'Pick the copies to remove. Nothing is selected for you: keeping a copy is always the safe answer.',
      absent: 'No copy here',
      version: 'version {hash}',
      noLocations: 'No location for this kind holds a copy that can be removed.',
      noLocationsHint:
        'Every location for this kind is either disabled in settings or unavailable on this platform.',
      previewError: 'The removal preview could not be built.',
      nothingSelected: 'Nothing is selected, so there is nothing to remove.',
      // Deleting the version you do not want is a legitimate way to resolve a
      // divergence — the user only needs to know that is what they are doing.
      eliminatesGroup: 'This is the only copy of version {hash}.',
      eliminatesGroupHeading: 'These removals take the last copy of a version with them',
      eliminatesGroupRow: '{resource} — {location} holds the only copy of version {hash}',
      confirmDescription: '{count} copies will be removed.',
      lastCopyWarning:
        'This would leave no copy of the resource anywhere. The backup below is the only way back, and only while it is retained.',
      lastCopyAcknowledge: 'I understand this removes the last copy of {resource}.',
      acknowledgeRequired: 'Acknowledge the last-copy removal to continue.',
      lastCopyRefused:
        'The library holds fewer copies than this preview showed, so removing these would leave none. Preview again to see what is really there.',
      backupNote: 'Every removed copy is backed up first and can be restored from the result.',
      // The apply is bound to a state hash; between preview and confirm the user
      // may have edited the very copy they are about to delete.
      stale: 'The library changed since this read. Preview again before removing.',
      staleStaged:
        'An interrupted removal left a temporary copy behind. Nothing was deleted; inspect these paths and remove them yourself.',
      applyError: 'The removal failed.',
      resultRemovedHeading: 'Removed',
      resultLastCopy: 'This was the last copy.',
      resultPartial:
        'A removal failed and could not be fully undone, so some copies are already gone. Use the backup below.',
      resultRolledBack: 'A removal failed, so every copy was put back.',
      resultNone: 'Nothing was removed.',
      resultKeptHeading: 'Still there',
      // One machine's copies at a time: a removal's backup is the only remaining
      // copy of what it deleted, so the verb has to name what is being restored
      // rather than promise a single undo across every machine touched.
      restore: 'Put these copies back',
    },
    result: {
      appliedHeading: 'Written',
      skippedHeading: 'Skipped',
      failedHeading: 'Failed',
      none: 'Nothing was written.',
      rolledBack: 'Nothing was written: the failure was rolled back completely.',
      // The alarming case: compensation also failed and writes are still on disk.
      partial:
        'A failure could not be fully rolled back. Some writes are still on disk — use Undo.',
      backupId: 'Backup {id}',
      undo: 'Undo',
      undoing: 'Undoing…',
      undoError: 'The undo failed.',
      undone: 'Undone: {restored} restored, {removed} removed.',
      undoSkipped: '{count} were left alone.',
      undoSkipReason: {
        'changed-since-apply': 'Changed after the apply; undo left it alone.',
        'backup-missing': 'The backup is no longer available.',
      },
      done: 'Done',
    },
    backups: {
      pinned: '{count} pinned, holding {size}.',
      pinnedHint:
        'Pinned sets hold the last remaining copy of a resource, so retention never deletes them.',
      restoring: 'Restoring…',
      restoreError: 'This backup could not be restored.',
      purge: 'Purge',
      // Two clicks on every row, pinned or not. Ordinary sets are purgeable for
      // the first time here, and a set holding a recoverable copy must not go
      // on one click just because nothing pinned it.
      purgeConfirm: 'Delete it permanently',
      purgeCancel: 'Keep it',
      purgeError: 'This backup could not be deleted.',
      usage: '{count} backups using {size}.',
      // Singular form: there is no plural machinery, so the one-set case is a key.
      usageOne: '1 backup using {size}.',
      retention: 'We keep the last {count} or {size}, whichever comes first.',
      manage: 'Manage backups',
      back: 'Back to the matrix',
      title: 'Backups',
      description:
        'Every copy the app is holding from a propagation or a removal, with the way back from each.',
      empty: 'No backups are being held right now.',
      // Undo means opposite things by origin, so the verb is never generic. A
      // removal set only ever puts content back; a propagation set can also
      // delete the paths that propagation created.
      undoRemoval: 'Put the copies back',
      undoPropagation: 'Undo this propagation',
      undoUnknown: 'Undo',
      undoUnknownHint:
        'This backup predates the record of what wrote it, so undoing it may put content back or remove what was written.',
      origin: {
        propagation: 'Propagation',
        removal: 'Removal',
        unknown: 'Unrecorded',
      },
      columnCreated: 'Created',
      columnContents: 'Contents',
      columnSize: 'Size',
      columnOrigin: 'Origin',
      contentsUnknown: '{count} entries',
      pinnedBadge: 'Pinned',
      // Retention evicts on the next propagation, so saying it after the fact is
      // saying it too late.
      evictsNext: 'Goes next',
      evictsNextHint:
        'The next propagation will delete this backup to stay inside the retention budget.',
      bulkHint: 'Backups are restored and deleted one set at a time, on purpose.',
      // Backups stay on the machine that owned the file, so the list is grouped
      // by machine rather than merged: two sets from two machines are two
      // different disks, and the retention budget applies to each on its own.
      retentionPerMachine: 'These bounds apply to each machine separately.',
      machineUnknown: 'Machine {id}',
      unreachable:
        'These machines could not be reached, so their backups are listed from what the hub last recorded: {machines}.',
      unavailableOffline: 'Restoring needs this machine connected.',
      unavailableManifest:
        'This set has lost the record of what it holds, so nothing can be restored from it. Deleting it still works.',
    },
    settings: {
      description:
        'Read-only. Settings from different agents have similar intent, not identical meaning.',
      comparability: 'Rough comparison',
      concept: {
        'default-permission-mode': 'Default permission mode',
        'allow-list': 'Allow list',
        'deny-list': 'Deny list',
        'selected-model': 'Selected model',
        'reasoning-effort': 'Reasoning effort',
      },
      conceptState: {
        detected: 'Detected',
        'not-detected': 'Not configured',
        'not-applicable': 'Not applicable',
      },
      // One line for the agents that have nothing to compare, instead of a card
      // each that only repeats the state.
      undetectedLine: {
        'not-detected': 'Not configured for {agents}',
        'not-applicable': 'Not applicable to {agents}',
      },
      presentation: {
        redacted: 'Value withheld for safety',
        // Says "present" on purpose. A setting nobody configured is not listed
        // at all, so the only thing this row adds over silence is that there
        // *is* something here and it is deliberately not shown.
        omitted: 'Present, but never shown',
      },
      sourceHeading: 'Files read',
      sourceAbsent: 'Does not exist',
      parseFailure: {
        'invalid-json': 'Invalid JSON',
        'invalid-toml': 'Invalid TOML',
        'invalid-rules': 'Rules could not be parsed',
        unreadable: 'Could not be read',
        'not-regular-file': 'Not a regular file',
        'too-large': 'Too large to read',
      },
      empty: 'No settings were found to compare.',
    },
  },
};
