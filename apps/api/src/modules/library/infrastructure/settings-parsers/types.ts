import type { SettingsField, SettingsParseFailureReason } from '@mangostudio/shared/library';

export type SettingsParserResult =
  | {
      readonly parsed: true;
      readonly fields: SettingsField[];
    }
  | {
      readonly parsed: false;
      readonly failureReason: SettingsParseFailureReason;
      readonly fields: [];
    };
