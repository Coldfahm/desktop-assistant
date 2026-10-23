import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type WheelEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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

const WIDGET_SIZE = 320;
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
  current_mode: number;
  pause_animations: boolean;
  widget_size: number;
};

type PointerPosition = {
  gazeX: number;
  gazeY: number;
  near: boolean;
};

const PARTICLES = Array.from({ length: 260 }, (_, index) => {
  const angle = index * 137.508;
  const radians = (angle * Math.PI) / 180;
  const normalized = ((index * 0.61803398875) % 1);
  const radius = 86 + normalized * 61;
  const spread = ((index * 17) % 7) - 3;
  return {
    left: WIDGET_SIZE / 2 + Math.cos(radians) * (radius + spread),
    top: WIDGET_SIZE / 2 + Math.sin(radians) * (radius + spread),
    hue: (angle + 30) % 360,
    size: 2 + ((index * 13) % 5),
    opacity: 0.45 + ((index * 7) % 50) / 100,
  };
});

function App() {
  const [mode, setMode] = useState(0);
  const [awake, setAwake] = useState(false);
  const [labelVisible, setLabelVisible] = useState(false);
  const [visible, setVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [pauseAnimations, setPauseAnimations] = useState(false);
  const [focusAssist, setFocusAssist] = useState(false);
  const [widgetSize, setWidgetSize] = useState(WIDGET_SIZE);
  const [gaze, setGaze] = useState<PointerPosition>({
    gazeX: 0,
    gazeY: 0,
    near: false,
  });
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
          console.error("Could not save RIATA mode:", error);
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
  }, [awake, refreshHitRegions, visible, widgetSize]);

  useEffect(() => {
    let cancelled = false;
    void invoke<RuntimeSettings>("get_runtime_settings")
      .then((settings) => {
        if (cancelled) return;
        const initialMode = settings.current_mode % MODES.length;
        modeRef.current = initialMode;
        setMode(initialMode);
        setPauseAnimations(settings.pause_animations);
        setWidgetSize(settings.widget_size);
      })
      .catch((error: unknown) => {
        console.error("Could not load RIATA settings:", error);
      });
    void invoke<boolean>("get_focus_assist_state")
      .then((active) => {
        if (cancelled) return;
        focusAssistRef.current = active;
        setFocusAssist(active);
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
    let unlistenPointerPosition: (() => void) | undefined;
    let unlistenCycle: (() => void) | undefined;
    let unlistenPause: (() => void) | undefined;
    let unlistenFocusAssist: (() => void) | undefined;
    let cancelled = false;

    void listen<boolean>("widget-visibility", (event) => {
      setVisible(event.payload);
      if (!event.payload) {
        setAwake(false);
        setLabelVisible(false);
        setGaze({ gazeX: 0, gazeY: 0, near: false });
        window.clearTimeout(labelTimer.current);
        window.clearTimeout(awakeTimer.current);
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
    void listen<PointerPosition>("pointer-position", (event) => {
      setGaze(event.payload);
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else unlistenPointerPosition = unlisten;
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
      unlistenPointerPosition?.();
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
      labelTimer.current = window.setTimeout(() => setLabelVisible(false), 1000);
    }
    return () => window.clearTimeout(labelTimer.current);
  }, [fullscreen, labelVisible, mode, visible]);

  const onOrbPointerDown = () => {
    void invoke("begin_disk_drag").catch((error: unknown) => {
      console.error("Could not begin RIATA drag:", error);
    });
  };

  const onOrbWheel = (event: WheelEvent<HTMLButtonElement>) => {
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
  const scale = widgetSize / WIDGET_SIZE;
  const rootStyle = { "--widget-scale": scale } as CSSProperties;

  if (!visible) return null;

  return (
    <main
      className={`widget${animationsFrozen ? " is-frozen" : ""}${focusAssist ? " is-quiet" : ""}`}
      ref={rootRef}
      style={rootStyle}
      aria-label="RIATA floating assistant"
    >
      <div className="particle-halo" aria-hidden="true">
        {PARTICLES.map((particle, index) => (
          <span
            className="particle"
            key={index}
            style={
              {
                left: particle.left,
                top: particle.top,
                "--particle-hue": particle.hue,
                "--particle-size": particle.size,
                "--particle-opacity": particle.opacity,
              } as CSSProperties
            }
          />
        ))}
      </div>

      <AnimatePresence>
        {awake &&
          MODES.map(({ name, Icon }, index) => {
            const angle = (index / MODES.length) * Math.PI * 2 - Math.PI / 2;
            const x = WIDGET_SIZE / 2 + Math.cos(angle) * 128;
            const y = WIDGET_SIZE / 2 + Math.sin(angle) * 128;
            const isCurrent = index === mode;

            return (
              <motion.div
                className="mode-anchor"
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
                  className={`mode-button${isCurrent ? " is-current" : ""}`}
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
                  onClick={() => commitMode(index)}
                >
                  <Icon size={16} strokeWidth={1.8} />
                </motion.button>
              </motion.div>
            );
          })}
      </AnimatePresence>

      <motion.button
        className="orb"
        data-hit-region="circle"
        type="button"
        aria-label={`RIATA assistant. Current mode: ${MODES[mode].name}`}
        onPointerDown={onOrbPointerDown}
        onWheel={onOrbWheel}
        animate={{
          scale: pulse > 0 && !animationsFrozen && !reducedMotion ? [1, 1.045, 1] : 1,
        }}
        transition={
          reducedMotion || animationsFrozen
            ? { duration: 0 }
            : { type: "spring", stiffness: 260, damping: 22, mass: 0.9, duration: 0.12 }
        }
      >
        <span className={`orb-core${awake ? " is-awake" : ""}`}>
          <svg
            className={`orb-face${gaze.near ? " is-smiling" : ""}`}
            viewBox="0 0 58 42"
            aria-hidden="true"
          >
            <ellipse className="eye-white" cx="17" cy="12" rx="8" ry="10" />
            <ellipse className="eye-white" cx="41" cy="12" rx="8" ry="10" />
            <circle
              className="eye-pupil"
              cx="17"
              cy="12"
              r="3.5"
              style={{
                transform: `translate(${gaze.gazeX * 3}px, ${gaze.gazeY * 3}px)`,
              }}
            />
            <circle
              className="eye-pupil"
              cx="41"
              cy="12"
              r="3.5"
              style={{
                transform: `translate(${gaze.gazeX * 3}px, ${gaze.gazeY * 3}px)`,
              }}
            />
            <path
              className="mouth"
              d={gaze.near ? "M16 28 Q29 42 42 28" : "M20 31 Q29 29 38 31"}
            />
          </svg>
        </span>
      </motion.button>

      <div className="orb-wordmark" aria-hidden="true">RIATA</div>
      <div className="orb-caption" aria-label={`Current mode: ${MODES[mode].name}`}>
        <CurrentModeIcon size={12} strokeWidth={1.8} />
        <span>{MODES[mode].name}</span>
      </div>

      <AnimatePresence>
        {labelVisible && !focusAssist && (
          <motion.div
            className="mode-label"
            key={mode}
            initial={{ opacity: 0, y: 4 }}
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
