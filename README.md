# RIATA

RIATA is a compact, transparent, always-on-top desktop widget centered on a clean orb. Its eyes follow the nearby global pointer and its mouth animates into a smile as the pointer approaches. Scrolling over the widget cycles seven modes; nearby mode buttons appear around it. AI, Terminal, and Clipboard modes use a pill-shaped layout. Timer presets run locally.

The Settings window provides a global shortcut and four persistent size presets. The tray menu also provides Do Not Disturb, pause animations, start with Windows, and reset position.

## Integration status

- Mode switching, focus timers, and their completion status work locally.
- The launcher can open File Explorer, Notepad, and Calculator. AutoCAD, Google Earth Pro, TikTok LIVE Studio, and Fortnite can be configured with executable paths in Settings.
- Media buttons send Windows media keys to the active player; track metadata and lyrics need a separate media-session/lyrics integration.
- AI mode offers browser speech dictation when the WebView supports it and the user grants microphone permission. It does not generate AI responses.
- System mode reports CPU and memory on demand. Network-interface telemetry is not implemented.
- Terminal mode offers only fixed `whoami` and `ipconfig` diagnostics; it does not execute arbitrary user-entered commands.
- Clipboard history captures text or images only after the user presses Capture, stays in memory for the session, can be browsed with the wheel, and can restore captured entries.
- Dropping a file onto the widget reports its filename and size; it does not read file contents or perform further processing.
- The Rust backend polls the Windows pointer with `GetCursorPos` and emits nearby screen coordinates to the React UI. The transparent window uses native hit regions so non-widget areas remain click-through.
- The app uses React/CSS and Framer Motion. Tailwind is not installed; equivalent styles are kept in the existing CSS to avoid a new runtime/build dependency.
- A sub-10 MB total RAM limit is not realistic to guarantee with a Tauri WebView2 application; WebView2 itself generally exceeds that budget.

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

- The native widget window is transparent, borderless, and always on top. Its default canvas is 440 × 320 logical pixels; the visible orb occupies only part of that canvas.
- Runtime settings and widget positions are saved in the Tauri application configuration directory.
