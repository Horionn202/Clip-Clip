import { useCallback, useEffect, useState } from 'react';
import type { Diagnostics, Job, Settings } from '../shared/types';
import { api } from './api';
import { HomePage } from './pages/Home';
import type { HomePrefill } from '../shared/homePrefill';
import { JobsPage } from './pages/Jobs';
import { ResultsPage } from './pages/Results';
import { SettingsPage } from './pages/Settings';
import { PolicyPage } from './pages/Policy';
import { ConnectionsPage } from './pages/Publish';
import { LegacyModal, useLegacyPrompt } from './pages/Legacy';
import { LivePage } from './pages/Live';
import { AppShell, Sidebar, useDrawer, type NavItem } from './components/AppShell';
import { ToastHost, useToasts } from './components/ui';

export type Page = 'home' | 'jobs' | 'live' | 'results' | 'connections' | 'settings' | 'policy';

export function App() {
  const [page, setPage] = useState<Page>('home');
  // Lo que Inicio debe recuperar tras un fallo de descarga (URL, duración y máximo de clips).
  const [prefill, setPrefill] = useState<HomePrefill | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  const [legacyOpen, setLegacyOpen] = useLegacyPrompt();
  const [drawer, setDrawer] = useDrawer();
  const toasts = useToasts();
  const [version, setVersion] = useState('');
  const refreshDiag = useCallback(async () => setDiag(await api().checkDeps()), []);

  useEffect(() => {
    void api().listJobs().then(setJobs);
    void api()
      .getSettings()
      .then((s) => {
        setSettings(s);
        if (!s.onboardingDone) setPage('settings');
      });
    void refreshDiag();
    void api().appVersion().then((v) => setVersion(v.version)).catch(() => undefined);
    // Aviso de una sola vez (p. ej. datos trasladados desde ClipsVirales).
    void api()
      .startupNotice()
      // El aviso se entrega una sola vez: una segunda petición (p. ej. StrictMode en desarrollo) devuelve null y no debe borrarlo.
      .then((n) => {
        if (n) setNotice(n);
      })
      .catch(() => undefined);
    return api().onJobUpdate((job) =>
      setJobs((prev) => {
        const i = prev.findIndex((j) => j.id === job.id);
        if (i < 0) return [job, ...prev];
        const next = [...prev];
        next[i] = job;
        return next;
      }),
    );
  }, [refreshDiag]);

  const openResults = (id: string) => {
    setSelected(id);
    setPage('results');
  };
  const active = jobs.filter((j) => !['completed', 'cancelled', 'failed'].includes(j.status)).length;
  const nav: NavItem<Page>[] = [
    { page: 'home', label: 'Inicio', icon: 'home' },
    { page: 'jobs', label: 'Trabajos', icon: 'jobs', count: active },
    { page: 'results', label: 'Resultados', icon: 'results' },
    { page: 'connections', label: 'Publicar', icon: 'publish' },
    { page: 'live', label: 'Directos', icon: 'live' },
    { page: 'settings', label: 'Configuración', icon: 'settings' },
  ];
  const bottom: NavItem<Page>[] = [{ page: 'policy', label: 'Uso responsable', icon: 'shield' }];

  return (
    <AppShell
      menuOpen={drawer}
      onMenu={() => setDrawer(true)}
      sidebar={<Sidebar items={nav} bottom={bottom} page={page} onNavigate={setPage} diag={diag} onDiag={() => setPage('settings')} version={version} open={drawer} onClose={() => setDrawer(false)} />}
    >
      {notice && (
        <div className={`banner ${notice.kind === 'error' ? 'error' : 'info'} notice`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          <span className="grow">{notice.text}</span>
          {notice.kind === 'error' && (
            <button className="link" onClick={() => setPage('settings')}>
              Ver diagnóstico
            </button>
          )}
          <button className="ghost" aria-label="Cerrar aviso" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}
      {page === 'home' && <HomePage prefill={prefill} ollamaModel={settings?.ollamaModel} jobs={jobs} diag={diag} onCreated={() => setPage('jobs')} goSettings={() => setPage('settings')} goPolicy={() => setPage('policy')} />}
      {page === 'jobs' && <JobsPage jobs={jobs} onOpen={openResults} onDeleted={(ids) => setJobs((p) => p.filter((j) => !ids.includes(j.id)))} onRestored={() => void api().listJobs().then(setJobs)} toast={toasts.push} goDiagnostics={() => setPage('settings')} goHome={() => setPage('home')} onPrefill={(p) => (setPrefill(p), setPage('home'))} />}
      {page === 'results' && <ResultsPage jobs={jobs} selected={selected} onSelect={setSelected} toast={toasts.push} onJobsChanged={() => void api().listJobs().then(setJobs)} />}
      {page === 'settings' && settings && (
        <SettingsPage settings={settings} onChange={setSettings} diag={diag} refreshDiag={refreshDiag} jobs={jobs} />
      )}
      {page === 'live' && <LivePage onOpenResults={() => setPage('results')} />}
      {page === 'policy' && <PolicyPage />}
      {page === 'connections' && <ConnectionsPage />}
      <ToastHost toasts={toasts.toasts} onDismiss={toasts.dismiss} />
      <LegacyModal
        open={legacyOpen}
        onClose={() => setLegacyOpen(false)}
        onDone={() => {
          // Tras migrar, se recargan historial y ajustes.
          void api().listJobs().then(setJobs);
          void api().getSettings().then(setSettings);
          void refreshDiag();
        }}
      />
    </AppShell>
  );
}
