import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useTransform } from "framer-motion";
import {
  AppWindow,
  AudioLines,
  Check,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Command,
  Cpu,
  Mic,
  Pause,
  Play,
  SkipForward,
  Sparkles,
  Settings2,
  Timer,
} from "lucide-react";
import "./App.css";

const WIDGET_WIDTH = 440;
const WIDGET_HEIGHT = 320;
const MODES = [
  { id: "apps", name: "Apps", Icon: AppWindow },
  { id: "media", name: "Media", Icon: AudioLines },
  { id: "ai", name: "AI", Icon: Sparkles },
  { id: "system", name: "System", Icon: Cpu },
  { id: "terminal", name: "Terminal", Icon: Command },
  { id: "timers", name: "Timers", Icon: Timer },
  { id: "clipboard", name: "Clipboard", Icon: Clipboard },
] as const;

type HitRegion =
  | { shape: "circle"; cx: number; cy: number; radius: number }
  | { shape: "rect"; x: number; y: number; width: number; height: number };
type RuntimeSettings = {
  current_mode: number;
  pause_animations: boolean;
  widget_size: number;
  app_paths: Record<string, string>;
};
type MousePosition = {
  mouseX: number;
  mouseY: number;
  widgetX: number;
  widgetY: number;
};
type SystemTelemetry = {
  cpuPercent: number;
  memoryPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
};
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;
type ClipboardEntry = {
  text?: string;
  imageUrl?: string;
};
declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const SLOT_TRANSITION = {
  initial: { y: 20, opacity: 0 },
  animate: { y: 0, opacity: 1 },
  exit: { y: -20, opacity: 0 },
  transition: { duration: 0.16, ease: "easeOut" as const },
};

function App() {
  const [modeIndex, setModeIndex] = useState(0);
  const [awake, setAwake] = useState(false);
  const [hoveredMode, setHoveredMode] = useState<number | null>(null);
  const [visible, setVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [pauseAnimations, setPauseAnimations] = useState(false);
  const [focusAssist, setFocusAssist] = useState(false);
  const [widgetSize, setWidgetSize] = useState(320);
  const [mediaIdle, setMediaIdle] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(0);
  const [timerFinished, setTimerFinished] = useState(false);
  const [actionResult, setActionResult] = useState("");
  const [systemStats, setSystemStats] = useState<SystemTelemetry | null>(null);
  const [systemLoading, setSystemLoading] = useState(false);
  const [terminalOutput, setTerminalOutput] = useState("");
  const [clipboardHistory, setClipboardHistory] = useState<ClipboardEntry[]>([]);
  const [clipboardIndex, setClipboardIndex] = useState(-1);
  const [voiceText, setVoiceText] = useState("");
  const [voiceListening, setVoiceListening] = useState(false);
  const [draggingFile, setDraggingFile] = useState(false);
  const [droppedFile, setDroppedFile] = useState("");
  const [pulse, setPulse] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const visibleRef = useRef(visible);
  const modeRef = useRef(modeIndex);
  const wheelLock = useRef(false);
  const mediaMouse = useRef<{ x: number; y: number } | undefined>(undefined);
  const mediaIdleTimer = useRef<number | undefined>(undefined);
  const pulseTimer = useRef<number | undefined>(undefined);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const clipboardUrls = useRef<string[]>([]);
  const previousTimerSeconds = useRef(0);
  const reducedMotion = useReducedMotion();
  const distance = useMotionValue(500);
  const pupilX = useMotionValue(0);
  const pupilY = useMotionValue(0);
  const smilePath = useTransform(
    distance,
    [500, 55],
    ["M 18 31 Q 29 31 40 31", "M 14 27 Q 29 44 44 27"],
  );
  const eyeOffsetX = useTransform(pupilX, [-1, 1], [-4, 4]);
  const eyeOffsetY = useTransform(pupilY, [-1, 1], [-3, 3]);
  visibleRef.current = visible;
  modeRef.current = modeIndex;

  const mode = MODES[modeIndex] ?? MODES[0];
  const pillMode =
    panelOpen ||
    mode.id === "ai" ||
    mode.id === "terminal" ||
    mode.id === "clipboard" ||
    (mode.id === "media" && mediaIdle);
  const CurrentIcon = mode.Icon;

  const refreshHitRegions = useCallback(async () => {
    const root = rootRef.current;
    if (!root) return;

    const bounds = root.getBoundingClientRect();
    const regions: HitRegion[] = Array.from(
      root.querySelectorAll<HTMLElement>("[data-hit-region]"),
    ).map((element) => {
      const rect = element.getBoundingClientRect();
      const x = rect.left - bounds.left;
      const y = rect.top - bounds.top;
      if (element.dataset.hitRegion === "circle") {
        return {
          shape: "circle",
          cx: x + rect.width / 2,
          cy: y + rect.height / 2,
          radius: Math.min(rect.width, rect.height) / 2,
        };
      }
      return { shape: "rect", x, y, width: rect.width, height: rect.height };
    });
    try {
      await invoke("set_hit_regions", { regions });
    } catch (error) {
      console.error("Could not update native hit regions:", error);
    }
  }, []);

  const commitMode = useCallback((nextMode: number) => {
    const next = (nextMode + MODES.length) % MODES.length;
    modeRef.current = next;
    setModeIndex(next);
    setPanelOpen(true);
    setPulse(true);
    setActionResult("");
    window.clearTimeout(pulseTimer.current);
    pulseTimer.current = window.setTimeout(() => setPulse(false), 100);
    void invoke("save_current_mode", { mode: next }).catch((error: unknown) => {
      console.error("Could not save RIATA mode:", error);
    });
  }, []);

  const cycleMode = useCallback(
    (direction: number) => {
      if (visibleRef.current) commitMode(modeRef.current + direction);
    },
    [commitMode],
  );

  useLayoutEffect(() => {
    if (!visible) {
      void invoke("set_hit_regions", { regions: [] }).catch((error: unknown) => {
        console.error("Could not clear native hit regions:", error);
      });
      return;
    }
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() => void refreshHitRegions());
    observer.observe(root);
    root.querySelectorAll<HTMLElement>("[data-hit-region]").forEach((element) => {
      observer.observe(element);
    });
    void refreshHitRegions();
    return () => observer.disconnect();
  }, [awake, modeIndex, pillMode, refreshHitRegions, visible, widgetSize]);

  useEffect(() => {
    let cancelled = false;
    void invoke<RuntimeSettings>("get_runtime_settings")
      .then((settings) => {
        if (cancelled) return;
        const initialMode = settings.current_mode % MODES.length;
        modeRef.current = initialMode;
        setModeIndex(initialMode);
        setPauseAnimations(settings.pause_animations);
        setWidgetSize(settings.widget_size);
      })
      .catch((error: unknown) => console.error("Could not load RIATA settings:", error));
    void invoke<boolean>("get_focus_assist_state")
      .then((active) => {
        if (!cancelled) setFocusAssist(active);
      })
      .catch((error: unknown) => console.error("Could not read quiet state:", error));
    void invoke<boolean>("get_fullscreen_state")
      .then((active) => {
        if (!cancelled) setFullscreen(active);
      })
      .catch((error: unknown) => console.error("Could not read fullscreen state:", error));
    const pingWatchdog = () => {
      void invoke("watchdog_ping").catch((error: unknown) => {
        console.error("Could not ping the UI watchdog:", error);
      });
    };
    pingWatchdog();
    const heartbeat = window.setInterval(pingWatchdog, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(heartbeat);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const register = <T,>(event: string, handler: (payload: T) => void) => {
      void listen<T>(event, (message) => handler(message.payload)).then((unlisten) => {
        if (cancelled) unlisten();
        else unlisteners.push(unlisten);
      }).catch((error: unknown) => {
        console.error(`Could not listen for ${event}:`, error);
      });
    };
    register<boolean>("widget-visibility", (isVisible) => {
      setVisible(isVisible);
      if (!isVisible) {
        setAwake(false);
        setMediaIdle(false);
        distance.set(500);
        pupilX.set(0);
        pupilY.set(0);
      }
    });
    register<boolean>("fullscreen-state", setFullscreen);
    register<boolean>("pause-animations", setPauseAnimations);
    register<boolean>("focus-assist-state", setFocusAssist);
    register<number>("widget-size", (size) => setWidgetSize(size));
    register<boolean>("pointer-target-state", setAwake);
    register<number>("cycle-mode", cycleMode);
    register<MousePosition>("mouse-moved", (position) => {
      const dx = position.mouseX - position.widgetX;
      const dy = position.mouseY - position.widgetY;
      const proximity = Math.hypot(dx, dy);
      distance.set(proximity);
      pupilX.set(Math.max(-1, Math.min(1, dx / 110)));
      pupilY.set(Math.max(-1, Math.min(1, dy / 110)));
      if (proximity < 150) setAwake(true);
      else if (proximity > 190) setAwake(false);

      if (modeRef.current === 1) {
        const previous = mediaMouse.current;
        const moved = !previous || Math.hypot(position.mouseX - previous.x, position.mouseY - previous.y) > 2;
        mediaMouse.current = { x: position.mouseX, y: position.mouseY };
        if (proximity <= 95 && moved) {
          window.clearTimeout(mediaIdleTimer.current);
          setMediaIdle(false);
          mediaIdleTimer.current = window.setTimeout(() => setMediaIdle(true), 1_000);
        } else if (proximity > 95) {
          window.clearTimeout(mediaIdleTimer.current);
          setMediaIdle(false);
        }
      }
    });
    return () => {
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [cycleMode, distance, pupilX, pupilY]);

  useEffect(() => {
    if (mode.id !== "media") {
      setMediaIdle(false);
      window.clearTimeout(mediaIdleTimer.current);
      mediaMouse.current = undefined;
    }
  }, [mode.id]);

  useEffect(() => {
    if (mode.id !== "ai" && recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
      setVoiceListening(false);
    }
  }, [mode.id]);

  useEffect(() => {
    if (timerSeconds <= 0) return;
    setTimerFinished(false);
    const interval = window.setInterval(
      () => setTimerSeconds((seconds) => Math.max(0, seconds - 1)),
      1_000,
    );
    return () => window.clearInterval(interval);
  }, [timerSeconds > 0]);

  useEffect(() => {
    if (previousTimerSeconds.current > 0 && timerSeconds === 0) {
      setTimerFinished(true);
    }
    previousTimerSeconds.current = timerSeconds;
  }, [timerSeconds]);

  useEffect(() => {
    let cancelled = false;
    let webview: ReturnType<typeof getCurrentWebviewWindow>;
    try {
      webview = getCurrentWebviewWindow();
    } catch (error) {
      console.error("Native file-drop support is unavailable:", error);
      return;
    }
    let unlisten: (() => void) | undefined;
    void webview.onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") {
        setDraggingFile(true);
      } else if (event.payload.type === "leave") {
        setDraggingFile(false);
      } else if (event.payload.type === "drop") {
        setDraggingFile(false);
        const [path] = event.payload.paths;
        if (!path) return;
        void invoke<string>("inspect_dropped_file", { path })
          .then(setDroppedFile)
          .catch((error: unknown) => {
            console.error("Could not inspect dropped file:", error);
            setDroppedFile(
              typeof error === "string" ? error : "Could not inspect this file.",
            );
          });
      }
    }).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    }).catch((error: unknown) => {
      console.error("Could not register file drop handling:", error);
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    return () => {
      window.clearTimeout(mediaIdleTimer.current);
      window.clearTimeout(pulseTimer.current);
      recognitionRef.current?.stop();
      clipboardUrls.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const launchApp = async (appId: string, label: string) => {
    setActionResult(`Opening ${label}…`);
    try {
      setActionResult(await invoke<string>("launch_app", { appId }));
    } catch (error) {
      console.error(`Could not launch ${label}:`, error);
      setActionResult(typeof error === "string" ? error : `Could not launch ${label}.`);
    }
  };

  const sendMediaCommand = async (action: "toggle" | "next" | "previous") => {
    try {
      await invoke("send_media_command", { action });
      setActionResult(
        action === "toggle"
          ? "Sent play/pause to the active media app."
          : `Sent ${action} track to the active media app.`,
      );
    } catch (error) {
      console.error("Could not send media key:", error);
      setActionResult(typeof error === "string" ? error : "Media control failed.");
    }
  };

  const refreshSystemStats = useCallback(async () => {
    setSystemLoading(true);
    try {
      const stats = await invoke<SystemTelemetry>("get_system_telemetry");
      setSystemStats(stats);
      setActionResult("System telemetry updated.");
    } catch (error) {
      console.error("Could not read system telemetry:", error);
      setActionResult(typeof error === "string" ? error : "Could not read system telemetry.");
    } finally {
      setSystemLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mode.id !== "system") return;
    void refreshSystemStats();
    const interval = window.setInterval(() => void refreshSystemStats(), 2_000);
    return () => window.clearInterval(interval);
  }, [mode.id, refreshSystemStats]);

  const runCommand = async (command: "identity" | "network") => {
    setTerminalOutput("Running…");
    try {
      setTerminalOutput(await invoke<string>("run_safe_command", { command }));
    } catch (error) {
      console.error("Could not run the built-in diagnostic:", error);
      setTerminalOutput(typeof error === "string" ? error : "Command failed.");
    }
  };

  const captureClipboard = async () => {
    if (!navigator.clipboard) {
      setActionResult("Clipboard reading is unavailable in this WebView.");
      return;
    }
    let text = "";
    try {
      if (navigator.clipboard.readText) {
        text = (await navigator.clipboard.readText()).trim();
      }
    } catch (error) {
      console.warn("Could not read clipboard text; trying image data:", error);
    }
    if (text) {
      setClipboardHistory((history) => [{ text }, ...history.filter((item) => item.text !== text)].slice(0, 20));
      setClipboardIndex(0);
      setActionResult("Copied text captured in this session.");
      return;
    }
    if (!navigator.clipboard.read) {
      setActionResult("Clipboard is empty or does not contain text.");
      return;
    }
    try {
      const clipboardItems = await navigator.clipboard.read();
      for (const item of clipboardItems) {
        const imageType = item.types.find((type) => type.startsWith("image/"));
        if (!imageType) continue;
        const image = await item.getType(imageType);
        const imageUrl = URL.createObjectURL(image);
        clipboardUrls.current.push(imageUrl);
        setClipboardHistory((history) => [{ imageUrl }, ...history].slice(0, 20));
        setClipboardIndex(0);
        setActionResult("Copied image captured in this session.");
        return;
      }
      setActionResult("Clipboard is empty or contains an unsupported format.");
    } catch (error) {
      console.error("Could not read clipboard:", error);
      setActionResult("Clipboard access was denied. Check Windows app permissions.");
    }
  };

  const startVoiceInput = () => {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      setActionResult("Speech recognition is not available in this WebView.");
      return;
    }
    try {
      const recognition = new Recognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || "en-US";
      recognition.onresult = (event) => {
        const text = Array.from(event.results)
          .map((result) => result[0]?.transcript ?? "")
          .join(" ")
          .trim();
        setVoiceText(text);
      };
      recognition.onerror = (event) => {
        setActionResult(`Speech input error: ${event.error}`);
        setVoiceListening(false);
      };
      recognition.onend = () => {
        setVoiceListening(false);
        recognitionRef.current = null;
      };
      recognition.start();
      recognitionRef.current = recognition;
      setVoiceListening(true);
      setActionResult("Listening. Speech recognition may use the browser's configured speech service.");
    } catch (error) {
      console.error("Could not start speech recognition:", error);
      setActionResult("Could not start speech input. Check microphone permissions.");
    }
  };

  const stopVoiceInput = () => {
    recognitionRef.current?.stop();
    setVoiceListening(false);
  };

  const restoreClipboardEntry = async (entry: ClipboardEntry) => {
    try {
      if (entry.text !== undefined) {
        await navigator.clipboard.writeText(entry.text);
      } else if (entry.imageUrl) {
        const image = await fetch(entry.imageUrl).then((response) => response.blob());
        await navigator.clipboard.write([new ClipboardItem({ [image.type]: image })]);
      }
      setActionResult("Clipboard item restored.");
    } catch (error) {
      console.error("Could not restore clipboard item:", error);
      setActionResult("Could not restore clipboard item. Check clipboard permissions.");
    }
  };

  const onWheel = useCallback(
    (event: globalThis.WheelEvent) => {
      event.preventDefault();
      if (wheelLock.current || event.deltaY === 0) return;
      wheelLock.current = true;
      const direction = event.deltaY > 0 ? 1 : -1;
      if (modeRef.current === 6) {
        setClipboardIndex((index) =>
          Math.max(0, Math.min(clipboardHistory.length - 1, index + direction)),
        );
        if (clipboardHistory.length === 0) {
          setActionResult("Capture clipboard text or an image first.");
        }
      } else {
        cycleMode(direction);
      }
      window.setTimeout(() => {
        wheelLock.current = false;
      }, 100);
    },
    [clipboardHistory.length, cycleMode],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  const startTimer = (seconds: number) => {
    setTimerSeconds(seconds);
    previousTimerSeconds.current = 0;
    setTimerFinished(false);
    setAwake(false);
  };

  const stopTimer = () => {
    previousTimerSeconds.current = 0;
    setTimerSeconds(0);
    setTimerFinished(false);
  };
  const animationFrozen = fullscreen || pauseAnimations || reducedMotion;
  const currentClipboard = clipboardHistory[clipboardIndex];
  const scale = widgetSize / 320;
  const rootStyle = { "--widget-scale": scale } as CSSProperties;
  const formattedTimer = `${Math.floor(timerSeconds / 60)
    .toString()
    .padStart(2, "0")}:${(timerSeconds % 60).toString().padStart(2, "0")}`;

  if (!visible) return null;

  return (
    <main
      className={`widget${animationFrozen ? " is-frozen" : ""}${focusAssist ? " is-quiet" : ""}`}
      ref={rootRef}
      style={rootStyle}
      aria-label="RIATA desktop assistant"
    >
      <AnimatePresence>
        {awake && !pillMode &&
          MODES.map(({ id, name, Icon }, index) => {
            let angle = (index / MODES.length) * Math.PI * 2 - Math.PI / 2;
            if (hoveredMode !== null && index !== hoveredMode) {
              const clockwise = (index - hoveredMode + MODES.length) % MODES.length;
              if (clockwise === 1) angle += 0.08;
              if (clockwise === MODES.length - 1) angle -= 0.08;
            }
            const x = WIDGET_WIDTH / 2 + Math.cos(angle) * 110 * scale;
            const y = WIDGET_HEIGHT / 2 + Math.sin(angle) * 110 * scale;
            return (
              <motion.div
                className="mode-anchor"
                data-hit-region="rect"
                key={id}
                style={{ left: x, top: y }}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={animationFrozen ? { duration: 0 } : { duration: 0.14 }}
              >
                <motion.button
                  className={`mode-button${mode.id === id ? " is-current" : ""}`}
                  type="button"
                  title={name}
                  aria-label={`Switch to ${name}`}
                  whileHover={animationFrozen ? undefined : { scale: 1.35 }}
                  onHoverStart={() => setHoveredMode(index)}
                  onHoverEnd={() => setHoveredMode(null)}
                  onClick={() => commitMode(index)}
                >
                  <Icon size={16} strokeWidth={1.8} />
                </motion.button>
              </motion.div>
            );
          })}
      </AnimatePresence>

      <motion.div
        className={`assistant-shape${pillMode ? " is-pill" : ""}`}
        data-hit-region={pillMode ? "rect" : "circle"}
        initial={false}
        animate={{
          width: pillMode ? Math.min(400 * scale, WIDGET_WIDTH - 20) : 120 * scale,
          height: 120 * scale,
          borderRadius: 60 * scale,
          scale: pulse ? 1.05 : 1,
        }}
        transition={{
          width: { type: "spring", stiffness: 300, damping: 25 },
          height: { type: "spring", stiffness: 300, damping: 25 },
          borderRadius: { type: "spring", stiffness: 300, damping: 25 },
          scale: { duration: 0.1 },
        }}
        style={{
          left: WIDGET_WIDTH / 2,
          top: WIDGET_HEIGHT / 2,
          x: "-50%",
          y: "-50%",
        }}
        onPointerDown={(event) => {
          if (event.target instanceof Element && event.target.closest("button, input")) {
            return;
          }
          void invoke("begin_disk_drag").catch((error: unknown) => {
            console.error("Could not begin RIATA drag:", error);
          });
        }}
        onClick={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest(".face-anchor, .shape-icon")
          ) {
            setPanelOpen((open) => !open);
          }
        }}
      >
        <div className="face-anchor">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              className="shape-icon"
              key={mode.id}
              {...SLOT_TRANSITION}
              aria-hidden="true"
            >
              <CurrentIcon size={19} strokeWidth={1.8} />
            </motion.div>
          </AnimatePresence>
          <svg className="orb-face" viewBox="0 0 58 48" aria-hidden="true">
            <ellipse className="eye-white" cx="17" cy="12" rx="8" ry="10" />
            <ellipse className="eye-white" cx="41" cy="12" rx="8" ry="10" />
            <motion.circle className="eye-pupil" cx="17" cy="12" r="3.5" style={{ x: eyeOffsetX, y: eyeOffsetY }} />
            <motion.circle className="eye-pupil" cx="41" cy="12" r="3.5" style={{ x: eyeOffsetX, y: eyeOffsetY }} />
            <motion.path className="mouth" d={smilePath} />
          </svg>
        </div>
        <div className="orb-wordmark">RIATA</div>
        <div className="pill-content">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.section
              className="mode-panel"
              key={`${mode.id}-${mediaIdle}`}
              {...SLOT_TRANSITION}
              aria-live="polite"
            >
              <h2>{mediaIdle && mode.id === "media" ? "Media focus" : mode.name}</h2>
              {mode.id === "apps" && (
                        <>
                          <p>Open a built-in app or configure the others in Settings.</p>
                          <div className="action-list">
                            <button type="button" onClick={() => void launchApp("explorer", "File Explorer")}>Explorer</button>
                            <button type="button" onClick={() => void launchApp("notepad", "Notepad")}>Notepad</button>
                            <button type="button" onClick={() => void launchApp("calculator", "Calculator")}>Calculator</button>
                            <button type="button" onClick={() => void launchApp("autocad", "AutoCAD")}>AutoCAD</button>
                            <button type="button" onClick={() => void launchApp("google_earth", "Google Earth Pro")}>Earth Pro</button>
                            <button type="button" onClick={() => void launchApp("tiktok_live", "TikTok LIVE Studio")}>TikTok LIVE</button>
                            <button type="button" onClick={() => void launchApp("fortnite", "Fortnite")}>Fortnite</button>
                            <button type="button" aria-label="Open RIATA Settings" onClick={() => void invoke("show_settings").catch((error: unknown) => { console.error("Could not open RIATA Settings:", error); setActionResult("Could not open Settings."); })}><Settings2 size={14} /></button>
                          </div>
                        </>
                      )}
                      {mode.id === "media" && (
                        <>
                          <p>{mediaIdle ? "Stillness detected. Lyrics require a connected lyrics source." : "Controls send media keys to the active Windows player."}</p>
                          <div className="media-controls" aria-label="Media controls">
                            <button type="button" onClick={() => void sendMediaCommand("previous")} aria-label="Previous track"><ChevronLeft size={14} /></button>
                            <button type="button" onClick={() => void sendMediaCommand("toggle")} aria-label="Play or pause"><Play size={14} /><Pause size={14} /></button>
                            <button type="button" onClick={() => void sendMediaCommand("next")} aria-label="Next track"><SkipForward size={14} /></button>
                          </div>
                        </>
                      )}
                      {mode.id === "ai" && (
                        <>
                          <p>{voiceListening ? "Listening…" : "Voice dictation. Recognition requires microphone permission and may use an online speech service."}</p>
                          <div className="media-controls">
                            <button type="button" onClick={voiceListening ? stopVoiceInput : startVoiceInput} aria-label={voiceListening ? "Stop listening" : "Start listening"}>
                              <Mic size={14} />
                            </button>
                            {voiceText && <button type="button" onClick={() => void navigator.clipboard.writeText(voiceText).then(() => setActionResult("Transcript copied.")).catch((error: unknown) => { console.error("Could not copy transcript:", error); setActionResult("Could not copy transcript."); })} aria-label="Copy transcript"><Check size={14} /></button>}
                          </div>
                          {voiceText && <p className="result-text">{voiceText}</p>}
                        </>
                      )}
                      {mode.id === "system" && (
                        <>
                          <p>Live CPU and memory usage on this PC.</p>
                          <div className="media-controls">
                            <button type="button" onClick={() => void refreshSystemStats()} disabled={systemLoading}>
                              {systemLoading ? "…" : "Refresh"}
                            </button>
                          </div>
                          {systemStats && (
                            <div className="metric-list">
                              <span>CPU <b>{systemStats.cpuPercent}%</b></span>
                              <span>Memory <b>{systemStats.memoryPercent}%</b></span>
                              <small>{(systemStats.memoryUsedBytes / 1_073_741_824).toFixed(1)} / {(systemStats.memoryTotalBytes / 1_073_741_824).toFixed(1)} GB</small>
                            </div>
                          )}
                        </>
                      )}
                      {mode.id === "terminal" && (
                        <>
                          <p>Safe built-in diagnostics only; arbitrary shell commands are disabled.</p>
                          <div className="action-list">
                            <button type="button" onClick={() => void runCommand("identity")}>Current user</button>
                            <button type="button" onClick={() => void runCommand("network")}>Network details</button>
                          </div>
                          {terminalOutput && <pre className="result-text terminal-output">{terminalOutput}</pre>}
                        </>
                      )}
                      {mode.id === "timers" && (
                        <>
                          <p>{timerSeconds > 0 ? `Time remaining: ${formattedTimer}` : timerFinished ? "Timer complete." : "Choose a focus timer."}</p>
                          <div className="timer-presets">
                    {[5, 15, 25].map((minutes) => (
                      <button key={minutes} type="button" onClick={() => startTimer(minutes * 60)}>
                        {minutes}m
                      </button>
                    ))}
                    {timerSeconds > 0 && (
                      <button type="button" onClick={stopTimer}>Stop</button>
                    )}
                  </div>
                </>
              )}
              {mode.id === "clipboard" && (
                <>
                  <p>Capture copied text on demand. History stays in memory for this session only.</p>
                  <div className="media-controls">
                    <button type="button" onClick={() => void captureClipboard()}>Capture</button>
                    <button type="button" disabled={clipboardIndex >= clipboardHistory.length - 1} onClick={() => setClipboardIndex((index) => Math.min(clipboardHistory.length - 1, index + 1))} aria-label="Older clipboard item"><ChevronLeft size={14} /></button>
                    <button type="button" disabled={clipboardIndex <= 0} onClick={() => setClipboardIndex((index) => Math.max(0, index - 1))} aria-label="Newer clipboard item"><ChevronRight size={14} /></button>
                    {currentClipboard && <button type="button" onClick={() => void restoreClipboardEntry(currentClipboard)}>Restore</button>}
                  </div>
                  {currentClipboard?.text && <p className="result-text clipboard-text">{currentClipboard.text}</p>}
                  {currentClipboard?.imageUrl && <img className="clipboard-image" src={currentClipboard.imageUrl} alt="Captured clipboard image" />}
                </>
              )}
              {droppedFile && <p className="result-text">{droppedFile}</p>}
              {actionResult && <p className="action-result" role="status">{actionResult}</p>}
            </motion.section>
          </AnimatePresence>
        </div>
      </motion.div>

      {!pillMode && (
        <div className="orb-caption" aria-label={`Current mode: ${mode.name}`}>
          <CurrentIcon size={12} strokeWidth={1.8} />
          <span>{mode.name}</span>
        </div>
      )}
      <AnimatePresence>
        {draggingFile && (
          <motion.div className="drop-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            Drop a file here to inspect it
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}

export default App;
