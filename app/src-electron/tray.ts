// Tray icon + menu. Reflects current settings as menu checkboxes; menu
// rebuilds whenever settings change so toggles stay accurate.

import { Tray, Menu, nativeImage, app, type MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyPatch, getSettings } from './settings-store';
import {
  createSettingsWindow,
  cycleMonitor,
  quitAll,
  showHide,
  toggleConversationPanelWindow,
  toggleCanvasWindow,
} from './window';

const currentDir = fileURLToPath(new URL('.', import.meta.url));

let tray: Tray | null = null;

export function createTray(): Tray {
  const iconPath = path.resolve(currentDir, 'icons/icon.png');
  const image = nativeImage.createFromPath(iconPath);
  // macOS tray icons should be small; resize and mark as template.
  const sized = image.resize({ width: 18, height: 18 });
  if (process.platform === 'darwin') sized.setTemplateImage(true);

  tray = new Tray(sized);
  tray.setToolTip('HermesAgent Faceplate');
  rebuildMenu();
  return tray;
}

export function rebuildMenu(): void {
  if (!tray) return;
  const s = getSettings();

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Show / Hide overlay',
      accelerator: s.hotkeys.show_hide,
      click: () => showHide('toggle'),
    },
    { type: 'separator' },
    {
      label: 'Push-to-talk',
      type: 'checkbox',
      checked: s.input.mode === 'push_to_talk',
      click: () => {
        const next = s.input.mode === 'push_to_talk' ? 'off' : 'push_to_talk';
        applyPatch({ input: { mode: next } });
        rebuildMenu();
      },
    },
    {
      label: 'Wake-word',
      type: 'checkbox',
      checked: s.input.mode === 'wake_word',
      click: () => {
        const next = s.input.mode === 'wake_word' ? 'off' : 'wake_word';
        applyPatch({ input: { mode: next } });
        rebuildMenu();
      },
    },
    { type: 'separator' },
    {
      label: 'Display',
      submenu: [
        {
          label: 'Overlay (transparent)',
          type: 'radio',
          checked: s.avatar.mode === 'overlay',
          click: () => {
            applyPatch({ avatar: { mode: 'overlay' } });
            rebuildMenu();
          },
        },
        {
          label: 'Windowed',
          type: 'radio',
          checked: s.avatar.mode === 'windowed',
          click: () => {
            applyPatch({ avatar: { mode: 'windowed' } });
            rebuildMenu();
          },
        },
        { type: 'separator' },
        {
          label: 'Always on top',
          type: 'checkbox',
          checked: s.avatar.always_on_top,
          click: () => {
            applyPatch({ avatar: { always_on_top: !s.avatar.always_on_top } });
            rebuildMenu();
          },
        },
        {
          label: 'Cycle monitor',
          accelerator: s.hotkeys.cycle_monitor,
          click: () => cycleMonitor(),
        },
      ],
    },
    { type: 'separator' },
    {
      label: 'Conversations…',
      accelerator: s.hotkeys.conversation_panel,
      click: () => toggleConversationPanelWindow(),
    },
    {
      label: 'Canvas…',
      accelerator: s.hotkeys.canvas,
      click: () => toggleCanvasWindow(),
    },
    process.platform === 'darwin'
      ? { label: 'Settings…', accelerator: 'Cmd+,', click: () => createSettingsWindow() }
      : { label: 'Settings…', click: () => createSettingsWindow() },
    { type: 'separator' },
    { label: 'Quit', accelerator: 'CommandOrControl+Q', click: () => quitAll() },
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}

export function hideDockOnMacOs(): void {
  if (process.platform === 'darwin' && app.dock) {
    // Hide the bouncing dock icon — Faceplate is a tray-only app.
    app.dock.hide();
  }
}
