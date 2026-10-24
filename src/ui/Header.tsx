import { useUi } from '../state/ui';
import { SettingsIcon } from './icons';

export function Header() {
  const inspectorOpen = useUi((s) => s.inspectorOpen);
  const toggleInspector = useUi((s) => s.toggleInspector);
  const setBrowser = useUi((s) => s.setBrowser);
  const setExport = useUi((s) => s.setExport);
  const hideUi = useUi((s) => s.hideUi);
  return (
    <header className="header">
      <a className="logo" href="#top" aria-label="BEAT//FORM — top">
        BEAT<span className="logo-slash">//</span>FORM
      </a>
      <span className="header-meta">AUDIO-REACTIVE INSTRUMENT · V2.0</span>
      <nav className="nav" aria-label="Sections">
        <a href="#scenes">
          <span className="dim">02</span> SCENES
        </a>
        <a href="#signal">
          <span className="dim">03</span> SIGNAL
        </a>
        <a href="#keys">
          <span className="dim">04</span> KEYS
        </a>
      </nav>
      <div className="header-actions">
        <button type="button" className="btn" onClick={() => setBrowser(true)} title="Scene browser (B)">
          <span className="label">BROWSE</span>
          <span className="label-short">⊞</span>
        </button>
        <button type="button" className="btn" onClick={() => setExport(true)} title="Export studio (E)">
          <span className="label">EXPORT</span>
          <span className="label-short">REC</span>
        </button>
        <button type="button" className="btn btn-hide" onClick={hideUi} title="Hide UI (H)" aria-label="Hide UI">
          <span className="label">HIDE UI</span>
          <span className="label-short">HIDE</span>
        </button>
        <button
          type="button"
          className={`btn header-settings ${inspectorOpen ? 'is-on' : ''}`}
          onClick={toggleInspector}
          aria-expanded={inspectorOpen}
          aria-controls="inspector"
          title="Inspector (S)"
        >
          <SettingsIcon /> <span className="label">INSPECT</span>
        </button>
      </div>
    </header>
  );
}
