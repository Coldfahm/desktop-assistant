import { useEffect, useState, type FormEvent } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "./settings.css";

type RuntimeSettings = {
  global_hotkey: string;
  widget_size: number;
};

function Settings() {
  const [hotkey, setHotkey] = useState("");
  const [widgetSize, setWidgetSize] = useState(320);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void invoke<RuntimeSettings>("get_runtime_settings")
      .then((settings) => {
        setHotkey(settings.global_hotkey);
        setWidgetSize(settings.widget_size);
        setLoaded(true);
      })
      .catch((loadError: unknown) => {
        console.error("Could not load RIATA settings:", loadError);
        setError("Could not load settings. See the application log for details.");
      });
  }, []);

  const saveHotkey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const canonical = await invoke<string>("set_global_hotkey", { hotkey });
      setHotkey(canonical);
    } catch (saveError) {
      console.error("Could not update the global shortcut:", saveError);
      setError(
        typeof saveError === "string"
          ? saveError
          : "Could not update the shortcut. See the application log for details.",
      );
    } finally {
      setSaving(false);
    }
  };

  const saveWidgetSize = async (size: number) => {
    setSaving(true);
    setError("");
    try {
      await invoke("set_widget_size", { size });
      setWidgetSize(size);
    } catch (saveError) {
      console.error("Could not update RIATA widget size:", saveError);
      setError(
        typeof saveError === "string"
          ? saveError
          : "Could not update widget size. See the application log for details.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="settings">
      <h1>RIATA settings</h1>
      <p>Keep the assistant compact and tune the essentials to suit your desktop.</p>
      <section className="settings-section" aria-labelledby="appearance-heading">
        <h2 id="appearance-heading">Appearance</h2>
        <label htmlFor="widget-size">Floating icon size</label>
        <select
          id="widget-size"
          value={widgetSize}
          onChange={(event) => void saveWidgetSize(Number(event.target.value))}
          disabled={!loaded || saving}
        >
          <option value={280}>Small</option>
          <option value={320}>Default</option>
          <option value={360}>Large</option>
          <option value={400}>Extra large</option>
        </select>
        <p className="settings-hint">
          Changes the icon and its interaction area without opening a full-size app window.
        </p>
      </section>
      <section className="settings-section" aria-labelledby="behavior-heading">
        <h2 id="behavior-heading">Behavior</h2>
        <p>Choose a shortcut to show or hide the floating assistant.</p>
        <form className="settings-form" onSubmit={saveHotkey}>
          <label htmlFor="global-hotkey">Global shortcut</label>
          <input
            id="global-hotkey"
            value={hotkey}
            onChange={(event) => setHotkey(event.target.value)}
            placeholder="Ctrl+Shift+Alt+A"
            autoComplete="off"
            spellCheck={false}
            required
            disabled={!loaded || saving}
          />
          <p className="settings-hint">
            Use a key and modifier names separated by +, for example
            Ctrl+Shift+Alt+A. Ctrl+Alt+Left and Ctrl+Alt+Right are reserved for
            changing modes.
          </p>
          <button type="submit" disabled={!loaded || saving}>
            {saving ? "Saving…" : "Save shortcut"}
          </button>
        </form>
      </section>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <Settings />,
);
