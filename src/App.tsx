import { useCallback, useEffect, useRef, useState } from 'react';
import { disposeAudio, loadFile, seekBy, setSystemReducedMotion, toggleLoop, toggleMute, togglePlay } from './audio/controller';
import { SUPPORTED_EXTENSIONS, validateAudioFile } from './audio/engine/fileValidation';
import { SHARE_HASH_KEY, decodePresetFromUrl } from './engine/presets/schema';
import { sceneRegistry } from './engine/scenes/registry';
import { useStudio } from './export/studio';
import { useNotice } from './state/notice';
import { useUi } from './state/ui';
import { selectScene, stepScene, useVisual } from './state/visual';
import { ExportStatusBar } from './ui/ExportPanel';
import { ExportStudio } from './ui/ExportStudio';
import { Header } from './ui/Header';
import { Hero } from './ui/Hero';
import { ImmersiveRestore } from './ui/Immersive';
import { Inspector } from './ui/inspector/Inspector';
import { PlayerBar } from './ui/PlayerBar';
import { SceneBrowser } from './ui/SceneBrowser';
import { Sections } from './ui/Sections';
import { useSystemReducedMotion } from './visual/useReducedMotion';

const ACCEPT = ['audio/*', ...SUPPORTED_EXTENSIONS.map((e) => `.${e}`)].join(',');

type FullscreenDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void>; webkitFullscreenEnabled?: boolean };
type FullscreenEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Load a shared preset from `#preset=…` (validated, size-limited), then clean the URL. */
function useSharedPresetLink(): void {
  useEffect(() => {
    const apply = () => {
      const hash = window.location.hash.slice(1);
      const params = new URLSearchParams(hash);
      const encoded = params.get(SHARE_HASH_KEY);
      if (!encoded) return;
      const res = decodePresetFromUrl(encoded);
      if (res.ok) {
        useVisual.getState().loadPreset(res.preset);
        useVisual.setState({ presetId: null, dirty: true });
        useNotice.getState().show(`LOADED SHARED PRESET "${res.preset.name}" — SAVE IT TO KEEP IT`);
      } else {
        useNotice.getState().show(`SHARED PRESET REJECTED — ${res.error}`);
      }
      history.replaceState(null, '', window.location.pathname + window.location.search);
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);
}

export default function App() {
  const appRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const hidden = useUi((s) => s.hidden);
  const inspectorOpen = useUi((s) => s.inspectorOpen);
  const accent = useVisual((s) => String(s.scenes[s.sceneId]?.params.primary ?? '#d4ff3a'));
  const background = useVisual((s) => String(s.scenes[s.sceneId]?.params.background ?? '#050505'));
  const systemReduced = useSystemReducedMotion();
  const doc = document as FullscreenDoc;
  const fullscreenSupported = !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);

  useSharedPresetLink();
  useEffect(() => setSystemReducedMotion(systemReduced), [systemReduced]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--bg', background);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background);
  }, [accent, background]);

  const browse = useCallback(() => inputRef.current?.click(), []);

  const toggleFullscreen = useCallback(() => {
    const el = appRef.current as FullscreenEl | null;
    if (!el) return;
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      void (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
    } else {
      window.scrollTo({ top: 0 });
      void (el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.())?.catch?.(() => useNotice.getState().show('FULLSCREEN NOT AVAILABLE'));
    }
  }, [doc]);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!(doc.fullscreenElement || doc.webkitFullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, [doc]);

  // ---- keyboard ---------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (useUi.getState().escape(useStudio.getState().status === 'running')) e.preventDefault();
        return;
      }
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
      const onButton = e.target instanceof HTMLElement && !!e.target.closest('button, a, [role="slider"]');
      const ui = useUi.getState();
      switch (e.code) {
        case 'Space':
          if (onButton) return;
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          if (onButton) return;
          e.preventDefault();
          seekBy(-5);
          break;
        case 'ArrowRight':
          if (onButton) return;
          e.preventDefault();
          seekBy(5);
          break;
        case 'BracketLeft':
          stepScene(-1);
          break;
        case 'BracketRight':
          stepScene(1);
          break;
        case 'KeyB':
          ui.setBrowser(!ui.browserOpen);
          break;
        case 'KeyE':
          ui.setExport(!ui.exportOpen);
          break;
        case 'KeyH':
          ui.toggleUi();
          break;
        case 'KeyF':
          if (fullscreenSupported) toggleFullscreen();
          break;
        case 'KeyL':
          toggleLoop();
          break;
        case 'KeyM':
          toggleMute();
          break;
        case 'KeyS':
          ui.toggleInspector();
          break;
        default:
          if (/^Digit[1-9]$/.test(e.code)) {
            const list = sceneRegistry.list();
            const i = Number(e.code.slice(-1)) - 1;
            if (list[i]) selectScene(list[i].id);
          }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreenSupported, toggleFullscreen]);

  // Mouse clicks should not leave focus on a control, so Space keeps meaning play/pause.
  useEffect(() => {
    const onUp = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const el = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('button, input[type="range"], [role="slider"]') : null;
      if (el && !el.closest('.inspector, .modal')) window.setTimeout(() => el.blur(), 0);
    };
    window.addEventListener('pointerup', onUp);
    return () => window.removeEventListener('pointerup', onUp);
  }, []);

  // ---- drag & drop anywhere -------------------------------------------------------------
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      const audio = files.find((f) => validateAudioFile(f).ok) ?? files[0];
      if (files.length > 1) useNotice.getState().show(`ONE FILE AT A TIME — LOADED ${audio.name.toUpperCase()}`);
      void loadFile(audio);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  useEffect(() => {
    const onHide = (e: PageTransitionEvent) => {
      if (!e.persisted) disposeAudio();
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  return (
    <div ref={appRef} className={`app ${isFullscreen ? 'is-fullscreen' : ''} ${inspectorOpen ? 'settings-open' : ''} ${hidden ? 'ui-hidden' : ''}`}>
      <a className="skip chrome" href="#player">
        Skip to player
      </a>
      <div className="chrome-wrap">
        <Header />
      </div>
      <main>
        <Hero onBrowse={browse} />
        <Sections />
      </main>
      <div id="player" className="player-dock chrome">
        <PlayerBar onBrowse={browse} onToggleFullscreen={toggleFullscreen} isFullscreen={isFullscreen} fullscreenSupported={fullscreenSupported} />
      </div>
      <div className="chrome-wrap">
        <Inspector />
        <SceneBrowser />
        <ExportStudio />
        <ExportStatusBar />
      </div>
      <ImmersiveRestore />
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void loadFile(file);
        }}
      />
      <div className={`drop-overlay chrome ${dragging ? 'is-on' : ''}`} aria-hidden={!dragging}>
        <div className="drop-box">
          <span className="drop-word">RELEASE TO LOAD</span>
          <span className="dim">ONE AUDIO FILE · STAYS ON THIS DEVICE</span>
        </div>
      </div>
    </div>
  );
}
