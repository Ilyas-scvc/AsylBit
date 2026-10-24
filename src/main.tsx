import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@fontsource-variable/archivo/wdth.css';
import './styles/global.css';
import './styles/v2.css';
import App from './App';

if (import.meta.env.DEV) {
  // Debug handle for manual / scripted testing in development builds only.
  void Promise.all([
    import('./audio/controller'),
    import('./audio/analysis/AnalysisHub'),
    import('./state/player'),
    import('./state/settings'),
    import('./visual/runtime'),
    import('./export/exporter'),
    import('./state/exportState'),
    import('./state/visual'),
    import('./state/ui'),
    import('./export/studio'),
    import('./export/capabilities'),
    import('./export/plan'),
    import('./visual/liveEngine'),
  ]).then(([controller, hub, player, settings, runtime, exporter, exportState, visual, ui, studio, capabilities, plan, live]) => {
    (window as unknown as Record<string, unknown>).__beatform = {
      controller,
      hub: hub.analysisHub,
      player: player.usePlayer,
      settings: settings.useSettings,
      runtime: runtime.useRuntime,
      exporter,
      exportState: exportState.useExport,
      visual,
      ui: ui.useUi,
      studio,
      capabilities,
      plan,
      liveEngine: live.getLiveEngine,
    };
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
