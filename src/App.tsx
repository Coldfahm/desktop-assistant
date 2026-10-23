import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type WheelEvent,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Activity,
  AudioLines,
  Command,
  PanelsTopLeft,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import "./App.css";

const MODES = [
  { name: "Launcher", Icon: PanelsTopLeft },
  { name: "Media", Icon: AudioLines },
  { name: "System", Icon: SlidersHorizontal },
  { name: "AI", Icon: Sparkles },
  { name: "Telemetry", Icon: Activity },
  { name: "Command", Icon: Command },
];

type HitRegion =
  | { shape: "circle"; cx: number; cy: number; radius: number }
  | { shape: "rect"; x: number; y: number; width: number; height: number };

type RuntimeSettings = {
  currentMode: number;
  pauseAnimations: boolean;
};

function Character() {
  return (
    <svg
      className="character"
      viewBox="0 0 120 110"
      role="img"
      aria-label="Placeholder cat"
    >
      <path
        className="cat-fur"
        d="M22 44 19 12l25 16a54 54 0 0 1 32 0l25-16-3 34c8 9 12 19 12 30 0 23-22 33-50 33S10 97 10 74c0-11 4-21 12-30Z"
      />
      <path className="cat-ear" d="m29 26 14 9-12 4Zm62 0-14 9 12 4Z" />
      <path className="cat-eye" d="M39 64a4 5 0 1 0 0 .1Zm42 0a4 5 0 1 0 0 .1Z" />
      <path className="cat-face" d="M55 76q5-5 10 0l-5 5Zm5 5q-5 8-11 1m11-1q5 8 11 1" />
      <path className="cat-whisker" d="m31 76-16-3m17 9-16 2m69-8 16-3m-17 9 16 2" />
    </svg>
  );
}

function App() {
  const [mode, setMode] = useState(0);
  const [awake, setAwake] = useState(false);
  const [labelVisible, setLabelVisible] = useState(true);
  const [visible, setVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [pauseAnimations, setPauseAnimations] = useState(false);
  const [focusAssist, setFocusAssist] = useState(false);
  const [pulse, setPulse] = useState(0);
  const rootRef = useRef<HTMLElement | null>(null);
  const visibleRef = useRef(visible);
  const wheelLock = useRef(false);
  const labelTimer = useRef<number | undefined>(undefined);
  const awakeTimer = useRef<number | undefined>(undefined);
  const modeRef = useRef(mode);
  const focusAssistRef = useRef(focusAssist);
  const reducedMotion = useReducedMotion();
  visibleRef.current = visible;
  focusAssistRef.current = focusAssist;

  const refreshHitRegions = useCallback(async () => {
    const root = rootRef.current;
    if (!root) return;

    const rootBounds = root.getBoundingClientRect();
    const regions: HitRegion[] = Array.from(
      root.querySelectorAll<HTMLElement>("[data-hit-region]"),
    ).map((element) => {
      const bounds = element.getBoundingClientRect();
      const x = bounds.left - rootBounds.left;
      const y = bounds.top - rootBounds.top;

      if (element.dataset.hitRegion === "circle") {
        return {
          shape: "circle",
          cx: x + bounds.width / 2,
          cy: y + bounds.height / 2,
          radius: Math.min(bounds.width, bounds.height) / 2,
        };
      }

      return { shape: "rect", x, y, width: bounds.width, height: bounds.height };
    });

    try {
      await invoke("set_hit_regions", { regions });
    } catch (error) {
      console.error("Could not update native hit regions:", error);
    }
  }, []);

  const showModeLabel = useCallback(() => {
    if (!focusAssistRef.current) setLabelVisible(true);
  }, []);

  const commitMode = useCallback(
    (nextMode: number) => {
      const normalized = (nextMode + MODES.length) % MODES.length;
      modeRef.current = normalized;
      setMode(normalized);
      setPulse((current) => current + 1);
      showModeLabel();
      void invoke("save_current_mode", { mode: normalized }).catch(
        (error: unknown) => {
          console.error("Could not save Disk mode:", error);
        },
      );
    },
    [showModeLabel],
  );

  const changeMode = useCallback(
    (direction: number) => {
      if (!visibleRef.current) return;
      commitMode(modeRef.current + direction);
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
    void refreshHitRegions();
    return () => observer.disconnect();
  }, [awake, refreshHitRegions, visible]);

  useEffect(() => {
    let cancelled = false;
    void invoke<RuntimeSettings>("get_runtime_settings")
      .then((settings) => {
        if (cancelled) return;
        const initialMode = settings.currentMode % MODES.length;
        modeRef.current = initialMode;
        setMode(initialMode);
        setPauseAnimations(settings.pauseAnimations);
      })
      .catch((error: unknown) => {
        console.error("Could not load Disk settings:", error);
      });
    void invoke<boolean>("get_focus_assist_state")
      .then((active) => {
        if (!cancelled) {
          focusAssistRef.current = active;
          setFocusAssist(active);
          if (active) setLabelVisible(false);
        }
      })
      .catch((error: unknown) => {
        console.error("Could not read Windows notification state:", error);
      });
    void invoke<boolean>("get_fullscreen_state")
      .then((active) => {
        if (!cancelled) setFullscreen(active);
      })
      .catch((error: unknown) => {
        console.error("Could not read fullscreen state:", error);
      });

    const pingWatchdog = () => {
      void invoke("watchdog_ping").catch((error: unknown) => {
        console.error("Could not ping the UI watchdog:", error);
      });
    };
    pingWatchdog();
    const heartbeatTimer = window.setInterval(pingWatchdog, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(heartbeatTimer);
    };
  }, []);

  useEffect(() => {
    let unlistenVisibility: (() => void) | undefined;
    let unlistenFullscreen: (() => void) | undefined;
    let unlistenPointer: (() => void) | undefined;
    let unlistenCycle: (() => void) | undefined;
    let unlistenPause: (() => void) | undefined;
    let unlistenFocusAssist: (() => void) | undefined;
    let cancelled = false;

    void listen<boolean>("widget-visibility", (event) => {
      setVisible(event.payload);
      if (!event.payload) {
        setAwake(false);
        setLabelVisible(false);
        window.clearTimeout(labelTimer.current);
        window.clearTimeout(awakeTimer.current);
      } else {
        setLabelVisible(true);
      }
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else unlistenVisibility = unlisten;
    });
    void listen<boolean>("fullscreen-state", (event) => {
      setFullscreen(event.payload);
      if (event.payload) {
        setLabelVisible(false);
        window.clearTimeout(labelTimer.current);
      }
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else unlistenFullscreen = unlisten;
    });
    void listen<boolean>("pause-animations", (event) => {
      setPauseAnimations(event.payload);
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else unlistenPause = unlisten;
    });
    void listen<boolean>("focus-assist-state", (event) => {
      focusAssistRef.current = event.payload;
      setFocusAssist(event.payload);
      if (event.payload) {
        setLabelVisible(false);
        window.clearTimeout(labelTimer.current);
      }
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else unlistenFocusAssist = unlisten;
    });
    void listen<boolean>("pointer-target-state", (event) => {
      window.clearTimeout(awakeTimer.current);
      if (event.payload) {
        setAwake(true);
      } else {
        awakeTimer.current = window.setTimeout(() => setAwake(false), 180);
      }
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else unlistenPointer = unlisten;
    });
    void listen<number>("cycle-mode", (event) => changeMode(event.payload)).then(
      (unlisten) => {
        if (cancelled) unlisten();
        else unlistenCycle = unlisten;
      },
    );
    return () => {
      cancelled = true;
      unlistenVisibility?.();
      unlistenFullscreen?.();
      unlistenPointer?.();
      unlistenCycle?.();
      unlistenPause?.();
      unlistenFocusAssist?.();
    };
  }, [changeMode]);

  useEffect(() => {
    if (fullscreen || !visible) {
      window.clearTimeout(labelTimer.current);
      return;
    }
    if (labelVisible) {
      labelTimer.current = window.setTimeout(() => setLabelVisible(false), 800);
    }
    return () => window.clearTimeout(labelTimer.current);
  }, [fullscreen, labelVisible, mode, visible]);

  const onDiskPointerDown = () => {
    void invoke("begin_disk_drag").catch((error: unknown) => {
      console.error("Could not begin disk drag:", error);
    });
  };

  const onDiskWheel = (event: WheelEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (wheelLock.current || event.deltaY === 0) return;
    wheelLock.current = true;
    changeMode(event.deltaY > 0 ? 1 : -1);
    window.setTimeout(() => {
      wheelLock.current = false;
    }, 140);
  };

  const { Icon: CurrentModeIcon } = MODES[mode];
  const animationsFrozen = fullscreen || pauseAnimations;

  if (!visible) return null;

  return (
    <main
      className={`widget${animationsFrozen ? " is-frozen" : ""}${focusAssist ? " is-quiet" : ""}`}
      ref={rootRef}
      aria-label="Disk floating assistant"
    >
      <div className="orbit" aria-hidden="true" />
      <AnimatePresence>
        {awake &&
          MODES.map(({ name, Icon }, index) => {
            const angle = (index / MODES.length) * Math.PI * 2 - Math.PI / 2;
            const x = 280 + Math.cos(angle) * 190;
            const y = 280 + Math.sin(angle) * 190;
            const isCurrent = index === mode;

            return (
              <motion.div
                className="ring-anchor"
                data-hit-region="rect"
                key={name}
                style={{ left: x, top: y }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={
                  reducedMotion || animationsFrozen
                    ? { duration: 0 }
                    : { duration: 0.12 }
                }
              >
                <motion.button
                  className={`ring-item${isCurrent ? " is-current" : ""}`}
                  type="button"
                  aria-label={`${name} mode`}
                  title={name}
                  initial={{ scale: reducedMotion || animationsFrozen ? 1 : 0.78 }}
                  animate={{ scale: 1 }}
                  exit={{ scale: reducedMotion || animationsFrozen ? 1 : 0.78 }}
                  transition={
                    reducedMotion || animationsFrozen
                      ? { duration: 0 }
                      : { type: "spring", stiffness: 260, damping: 22, mass: 0.9 }
                  }
                  onClick={() => {
                    commitMode(index);
                  }}
                >
                  <Icon size={18} strokeWidth={1.6} />
                </motion.button>
              </motion.div>
            );
          })}
      </AnimatePresence>

      <motion.button
        className="disk"
        data-hit-region="circle"
        type="button"
        aria-label={`Disk assistant. Current mode: ${MODES[mode].name}`}
        onPointerDown={onDiskPointerDown}
        onWheel={onDiskWheel}
        animate={{
          scale: pulse > 0 && !animationsFrozen && !reducedMotion ? [1, 1.045, 1] : 1,
        }}
        transition={
          reducedMotion || animationsFrozen
            ? { duration: 0 }
            : { type: "spring", stiffness: 260, damping: 22, mass: 0.9, duration: 0.12 }
        }
      >
        <span className={`disk-light${awake ? " is-awake" : ""}`} />
        <span className={`character-wrap${awake ? " is-awake" : ""}`}>
          <Character />
        </span>
        <span className="disk-caption">
          <CurrentModeIcon size={13} strokeWidth={1.7} />
          <span>{MODES[mode].name}</span>
        </span>
      </motion.button>

      <div className="mode-dots" aria-label={`Mode ${mode + 1} of 6`}>
        {MODES.map(({ name }, index) => (
          <span
            className={`mode-dot${index === mode ? " is-current" : ""}`}
            key={name}
          />
        ))}
      </div>

      <AnimatePresence>
        {labelVisible && (
          <motion.div
            className="mode-label"
            key={mode}
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={
              reducedMotion || animationsFrozen
                ? { duration: 0 }
                : { duration: 0.14, ease: "easeOut" }
            }
          >
            {MODES[mode].name}
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}

export default App;
