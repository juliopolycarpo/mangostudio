# Native ports

A native MangoStudio (WinUI 3 on Windows, GTK 4 + libadwaita on Linux) uses the
platform's **own controls** and applies this system's tokens on top: the accent,
the surfaces, the type scale and the spacing. What the platform draws itself — the
title bar, scrollbars, system context menus — stays the platform's. The goal is "MangoStudio on
Windows" and "MangoStudio on GNOME", not a web page in a window.

## Rules

- Set the platform accent to mango: `accent` for fills, `on-accent` for text on them,
  `accent-fg` for links and marked items.
- Map surfaces by **role** (table below), never by the nearest hex.
- Use the system font. The scale (`text-sm` 14/20, `text-title` 20/28, …) is unchanged.
- Icons: Segoe Fluent Icons on Windows and Adwaita symbolic icons on GNOME, 16px, in the
  role of the Lucide icon they replace.
- Materials: Mica may be the window's `canvas` on Windows 11. No Acrylic on cards or
  menus; no transparency on GTK.
- The terminal-dialect pieces — `key: value` chips, the composer, the timeline and
  tool blocks — are drawn by the app on both, from these tokens. They are what makes it
  recognisably MangoStudio.

## Colour roles

| Token                                         | WinUI 3 resource                                                               | libadwaita                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `canvas`                                      | `SolidBackgroundFillColorBase` (or Mica)                                       | `@window_bg_color`                                               |
| `sidebar`                                     | `NavigationViewDefaultPaneBackground`                                          | `@sidebar_bg_color`                                              |
| `surface`                                     | `CardBackgroundFillColorDefault`                                               | `@card_bg_color`, `@view_bg_color`                               |
| `surface-raised`                              | `SolidBackgroundFillColorTertiary` (flyouts, no Acrylic)                       | `@popover_bg_color`, `@dialog_bg_color`                          |
| `control`, `control-hover`, `control-pressed` | `ControlFillColorDefault` / `Secondary` / `Tertiary`                           | `entry` and `button` backgrounds                                 |
| `fill-hover`, `fill-pressed`, `fill-selected` | `SubtleFillColorSecondary` / `Tertiary`, `ListViewItemBackgroundSelected`      | `alpha(currentColor, .07)` / `.04` / `.10`                       |
| `stroke`                                      | `CardStrokeColorDefault`, `DividerStrokeColorDefault`                          | `@borders`, `@card_shade_color`                                  |
| `stroke-strong`                               | `ControlStrongStrokeColorDefault`                                              | `checkbutton` / `switch` outline                                 |
| `fg`, `fg-muted`, `fg-subtle`                 | `TextFillColorPrimary` / `Secondary` / `Tertiary`                              | `@window_fg_color`, `.dim-label`, `alpha(@window_fg_color, .55)` |
| `accent`, `on-accent`                         | `SystemAccentColor` / `AccentFillColorDefault`, `TextOnAccentFillColorPrimary` | `@accent_bg_color`, `@accent_fg_color`                           |
| `accent-fg`                                   | `AccentTextFillColorPrimary`                                                   | `@accent_color`                                                  |
| `focus`                                       | `FocusStrokeColorOuter`                                                        | `@accent_color` (focus ring)                                     |
| `success`, `warning`, `danger`                | `SystemFillColorSuccess` / `Caution` / `Critical`                              | `@success_color`, `@warning_color`, `@error_color`               |
| `danger-solid`, `on-danger`                   | critical-styled button                                                         | `@destructive_bg_color`, `@destructive_fg_color`                 |

## Geometry

| Token          | Web              | WinUI 3                                        | libadwaita              |
| -------------- | ---------------- | ---------------------------------------------- | ----------------------- |
| Control height | 32px             | 32px (default)                                 | 34px (default — accept) |
| Header         | 48px             | `TitleBar` 48px                                | `AdwHeaderBar` 46–47px  |
| `rounded-sm`   | 6px              | `ControlCornerRadius` = 6 (default 4)          | 6px (default)           |
| `rounded-md`   | 8px              | `OverlayCornerRadius` = 8 (default)            | 12px on cards (accept)  |
| `rounded-lg`   | 12px             | `ContentDialog` 8px (accept)                   | 12–18px (accept)        |
| `text-sm`      | Inter 14/20      | Segoe UI Variable 14/20 (`BodyTextBlockStyle`) | Adwaita Sans 11pt       |
| `text-title`   | Inter 20/28, 600 | `SubtitleTextBlockStyle` 20/28                 | `.title-2`              |

Where the platform column says "accept", the native value wins: the difference is small
and fighting it costs more than it saves.

## Components

| Component                             | WinUI 3                                                        | libadwaita                                       |
| ------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| `Button` primary / secondary / subtle | `Button` + `AccentButtonStyle` / default / `SubtleButtonStyle` | `.suggested-action` / default / `.flat`          |
| `Button` danger                       | critical-styled `Button`                                       | `.destructive-action`                            |
| `SplitButton`                         | `SplitButton`                                                  | `AdwSplitButton`                                 |
| `Input`                               | `TextBox`                                                      | `AdwEntryRow` / `GtkEntry`                       |
| `Select`                              | `ComboBox`                                                     | `AdwComboRow` / `GtkDropDown`                    |
| `Checkbox`                            | `CheckBox`                                                     | `GtkCheckButton`                                 |
| `Toggle`                              | `ToggleSwitch`                                                 | `AdwSwitchRow`                                   |
| `TabNav`                              | `SelectorBar`                                                  | `AdwViewSwitcher`                                |
| Sidebar / `NavItem`                   | `NavigationView` (Left)                                        | `AdwNavigationSplitView` + `.navigation-sidebar` |
| `Menu`                                | `MenuFlyout`                                                   | `GtkPopoverMenu`                                 |
| `ConfirmDialog`                       | `ContentDialog`                                                | `AdwAlertDialog`                                 |
| `Toast`                               | `InfoBar` / `TeachingTip`                                      | `AdwToast`                                       |
| `Callout`                             | `InfoBar` (inline)                                             | `AdwBanner` / `.card` with a status icon         |
| `Card` / `SectionCard`                | `Border` + card brushes / `SettingsCard`                       | `AdwPreferencesGroup`                            |
| Settings row                          | `SettingsCard`                                                 | `AdwActionRow`                                   |
| `Badge`                               | `InfoBadge` or a rounded `Border`                              | `GtkLabel` with a status class                   |
| `Spinner`                             | `ProgressRing`                                                 | `AdwSpinner`                                     |
| Composer, `Chip`, timeline            | drawn by the app                                               | drawn by the app                                 |
