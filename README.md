# RIATA

RIATA is a compact, floating desktop assistant. Its central white orb is surrounded by a colorful particle halo; its eyes follow the nearby pointer and it smiles as the pointer approaches. Hovering over the orb reveals six mode shortcuts. The orb can be dragged, and the global shortcut can show or hide it.

The Settings window currently provides a global shortcut and four persistent widget-size presets. The tray menu also provides Do Not Disturb, pause animations, start with Windows, and reset position.

Mode actions and AI integrations are not implemented yet; the current modes are navigation placeholders.

## Development

```powershell
npm install
npm run tauri dev
```

To build the app:

```powershell
npm run tauri build
```

## Notes

- The native widget is transparent, borderless, and always on top. Its default size is 320 × 320 logical pixels; the visible orb and halo occupy only part of that window.
- Runtime settings and widget positions are saved in the Tauri application configuration directory.
