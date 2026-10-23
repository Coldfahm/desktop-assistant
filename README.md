# Disk

Disk is a Windows-first floating desktop assistant built with Tauri 2, Rust, React, and TypeScript.

## Desktop integration

Implemented:

- A 560 × 560 transparent, borderless, always-on-top widget with an original SVG cat placeholder. The native window starts hidden; normal launches show it after initialization, while an OS startup launch stays hidden in the tray.
- Native cursor-region hit testing. The widget captures pointer events only over its disk or visible ring buttons; transparent areas pass through to windows below.
- A four-pixel drag threshold, monitor-aware saved positions, and clamping to the current display.
- A system-tray menu for Show / Hide Assistant, Reset Position to Center, Settings, Do Not Disturb, Pause Animations, Start with Windows, and Quit.
- Configurable global show/hide shortcut in Settings. `Ctrl+Alt+Left` and `Ctrl+Alt+Right` change modes while the widget is visible.
- Single-instance launch behavior and native fullscreen detection. While fullscreen is detected, the native hit-test loop drops to a one-second cadence and UI animations are frozen.
- Windows notification-state monitoring and manual Do Not Disturb. The mode label is suppressed while quiet mode is active.
- A native heartbeat monitor that reloads the widget WebView if it stops responding for 20 seconds.
- Six scrollable modes, animated mode indicators, and reduced-motion support.

Mode actions, telemetry, edge snapping, and character animation clips are not implemented yet.

## Development

Install the Windows prerequisites for Tauri 2, including Rust, the Microsoft C++ Build Tools, and WebView2. Then:

```powershell
npm install
npm run tauri dev
```

The installer bundle can be built with:

```powershell
npm run tauri build
```

GitHub Actions builds a Windows NSIS installer on pushes to `main` or `master`,
pull requests targeting those branches, version tags beginning with `v`, or a
manual run from the Actions tab. Download `Disk-Windows-Installer` from the
completed workflow run's artifacts.

The React/Vite production build and native Windows release executable have been
verified locally. The NSIS installer is configured to be built by GitHub
Actions. This workspace is not currently a Git checkout, so the workflow has
not yet been pushed to or run on GitHub.

## Data and network use

The app stores per-monitor window positions in `positions.json` and runtime settings in `settings.json` under Tauri's application config directory. It makes no network requests. Fonts use the local Windows system font stack.

## Known limits

- Exclusive-fullscreen games may hide desktop overlays; borderless-windowed mode is the supported fallback.
- Start with Windows is user-enabled from the tray; startup runs hidden and does not display the widget.
- Windows notification monitoring uses `SHQueryUserNotificationState` (quiet-time and presentation states); it does not reliably expose every Windows Focus Assist / Do Not Disturb configuration. Alarm/reminder features are not implemented yet; quiet mode currently suppresses the mode label.
- The watchdog is a native thread in the app, not a separate OS process. It reloads the WebView but cannot recover a crashed native process.
- WebView2's baseline memory use is generally above 10 MB, so this architecture cannot guarantee the requested under-10-MB total. Fullscreen throttling and idle resource use should still be measured on a running Windows build.
- Brightness, media, radios, telemetry, local AI, and command execution belong to later phases.
