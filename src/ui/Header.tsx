import { SettingsIcon } from './icons';

export function Header({ settingsOpen, onToggleSettings }: { settingsOpen: boolean; onToggleSettings: () => void }) {
  return (
    <header className="header">
      <a className="logo" href="#top" aria-label="BEAT//FORM — top">
        BEAT<span className="logo-slash">//</span>FORM
      </a>
      <span className="header-meta">AUDIO-REACTIVE INSTRUMENT · V1.0</span>
      <nav className="nav" aria-label="Sections">
        <a href="#modes">
          <span className="dim">02</span> MODES
        </a>
        <a href="#signal">
          <span className="dim">03</span> SIGNAL
        </a>
        <a href="#keys">
          <span className="dim">04</span> KEYS
        </a>
      </nav>
      <button
        type="button"
        className={`btn header-settings ${settingsOpen ? 'is-on' : ''}`}
        onClick={onToggleSettings}
        aria-expanded={settingsOpen}
        aria-controls="settings-panel"
      >
        <SettingsIcon /> <span className="label">SETTINGS</span>
      </button>
    </header>
  );
}
