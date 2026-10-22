import { useCallback, useEffect, useRef, useState } from 'react';
import { disposeAudio, loadFile, seekBy, setSystemReducedMotion, toggleLoop, toggleMute, togglePlay } from './audio/controller';
import { SUPPORTED_EXTENSIONS, validateAudioFile } from './audio/engine/fileValidation';
import { useNotice } from './state/notice';
import { MODES, useSettings } from './state/settings';
import { ExportStatusBar } from './ui/ExportPanel';
import { Header } from './ui/Header';
import { Hero } from './ui/Hero';
import { PlayerBar } from './ui/PlayerBar';
import { Sections } from './ui/Sections';
import { SettingsPanel } from './ui/SettingsPanel';
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

export default function App() {
  const appRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const accent = useSettings((s) => s.accent);
  const background = useSettings((s) => s.background);
  const systemReduced = useSystemReducedMotion();
  const doc = document as FullscreenDoc;
  const fullscreenSupported = !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);

  useEffect(() => setSystemReducedMotion(systemReduced), [systemReduced]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--bg', background);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background);
  }, [accent, background]);

  const browse = useCallback(() => inputRef.current?.click(), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

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
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
      const onButton = e.target instanceof HTMLElement && !!e.target.closest('button, a, [role="slider"]');
      switch (e.code) {
        case 'Space':
          if (onButton) return; // let the focused control activate natively
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
        case 'Digit1':
        case 'Digit2':
        case 'Digit3':
          useSettings.getState().set('mode', MODES[Number(e.code.slice(-1)) - 1].id);
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
          setSettingsOpen((o) => !o);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreenSupported, toggleFullscreen]);

  // Mouse clicks should not leave focus on a control, so Space keeps meaning play/pause.
  // Keyboard users keep their focus (pointerType is not "mouse" for keyboard activation).
  useEffect(() => {
    const onUp = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const el = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('button, input[type="range"], [role="slider"]') : null;
      if (el) window.setTimeout(() => el.blur(), 0);
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
    <div ref={appRef} className={`app ${isFullscreen ? 'is-fullscreen' : ''} ${settingsOpen ? 'settings-open' : ''}`}>
      <a className="skip" href="#player">
        Skip to player
      </a>
      <Header settingsOpen={settingsOpen} onToggleSettings={() => setSettingsOpen((o) => !o)} />
      <main>
        <Hero onBrowse={browse} />
        <Sections />
      </main>
      <div id="player" className="player-dock">
        <PlayerBar onBrowse={browse} onToggleFullscreen={toggleFullscreen} isFullscreen={isFullscreen} fullscreenSupported={fullscreenSupported} />
      </div>
      <SettingsPanel open={settingsOpen} onClose={closeSettings} />
      <ExportStatusBar />
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
      <div className={`drop-overlay ${dragging ? 'is-on' : ''}`} aria-hidden={!dragging}>
        <div className="drop-box">
          <span className="drop-word">RELEASE TO LOAD</span>
          <span className="dim">ONE AUDIO FILE · STAYS ON THIS DEVICE</span>
        </div>
      </div>
    </div>
  );
}
