import { useEffect, useState, type FormEvent } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "./settings.css";

type RuntimeSettings = {
  globalHotkey: string;
};

function Settings() {
  const [hotkey, setHotkey] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void invoke<RuntimeSettings>("get_runtime_settings")
      .then((settings) => {
        setHotkey(settings.globalHotkey);
        setLoaded(true);
      })
      .catch((loadError: unknown) => {
        console.error("Could not load Disk settings:", loadError);
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

  return (
    <main className="settings">
      <h1>Disk settings</h1>
      <p>Choose the keyboard shortcut that shows or hides the assistant.</p>
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
        {error && (
          <p className="settings-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={!loaded || saving}>
          {saving ? "Saving…" : "Save shortcut"}
        </button>
      </form>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <Settings />,
);
