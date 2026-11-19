import { useCallback, useEffect, useState } from 'react';
import logoUrl from './assets/logo-128.png';
import type { Diagnostics, Job, Settings } from '../shared/types';
import { api } from './api';
import { HomePage } from './pages/Home';
import { JobsPage } from './pages/Jobs';
import { ResultsPage } from './pages/Results';
import { SettingsPage } from './pages/Settings';
import { PolicyPage } from './pages/Policy';
import { ConnectionsPage } from './pages/Publish';
import { LegacyModal, useLegacyPrompt } from './pages/Legacy';

export type Page = 'home' | 'jobs' | 'results' | 'connections' | 'settings' | 'policy';

export function App() {
  const [page, setPage] = useState<Page>('home');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  const [legacyOpen, setLegacyOpen] = useLegacyPrompt();
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
  const nav: [Page, string][] = [
    ['home', 'Inicio'],
    ['jobs', active ? `Trabajos (${active})` : 'Trabajos'],
    ['results', 'Resultados'],
    ['connections', 'Conexiones'],
    ['settings', 'Configuración'],
    ['policy', 'Uso responsable'],
  ];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img src={logoUrl} alt="" width={32} height={32} />
          <span>Clip Clip</span>
        </div>
        <nav>
          {nav.map(([p, label]) => (
            <button key={p} className={page === p ? 'active' : ''} onClick={() => setPage(p)}>
              {label}
            </button>
          ))}
        </nav>
        <div className={`diag-pill ${diag?.ok ? 'ok' : 'bad'}`} onClick={() => setPage('settings')} role="button">
          {diag ? (diag.ok ? '● Dependencias OK' : '● Faltan dependencias') : '○ Comprobando…'}
        </div>
        <p className="local-note">Todo se procesa en este equipo.</p>
        {version && <p className="local-note small">Versión {version}</p>}
      </aside>
      <main className="content">
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
        {page === 'home' && <HomePage ollamaModel={settings?.ollamaModel} jobs={jobs} diag={diag} onCreated={() => setPage('jobs')} goSettings={() => setPage('settings')} goPolicy={() => setPage('policy')} />}
        {page === 'jobs' && <JobsPage jobs={jobs} onOpen={openResults} onDeleted={(id) => setJobs((p) => p.filter((j) => j.id !== id))} goDiagnostics={() => setPage('settings')} />}
        {page === 'results' && <ResultsPage jobs={jobs} selected={selected} onSelect={setSelected} />}
        {page === 'settings' && settings && (
          <SettingsPage settings={settings} onChange={setSettings} diag={diag} refreshDiag={refreshDiag} jobs={jobs} />
        )}
        {page === 'policy' && <PolicyPage />}
        {page === 'connections' && <ConnectionsPage />}
      </main>
      <LegacyModal
        open={legacyOpen}
        onClose={() => setLegacyOpen(false)}
        onDone={() => {
          // Tras migrar, se recargan historial y ajustes.
          void api().listJobs().then(setJobs);
          void api().getSettings().then(setSettings);
        }}
      />
    </div>
  );
}
