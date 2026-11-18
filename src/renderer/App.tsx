import { useCallback, useEffect, useState } from 'react';
import type { Diagnostics, Job, Settings } from '../shared/types';
import { api } from './api';
import { HomePage } from './pages/Home';
import { JobsPage } from './pages/Jobs';
import { ResultsPage } from './pages/Results';
import { SettingsPage } from './pages/Settings';
import { PolicyPage } from './pages/Policy';

export type Page = 'home' | 'jobs' | 'results' | 'settings' | 'policy';

export function App() {
  const [page, setPage] = useState<Page>('home');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

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
    ['settings', 'Configuración'],
    ['policy', 'Uso responsable'],
  ];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          Clips<span>Virales</span>
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
      </aside>
      <main className="content">
        {page === 'home' && <HomePage ollamaModel={settings?.ollamaModel} jobs={jobs} diag={diag} onCreated={() => setPage('jobs')} goSettings={() => setPage('settings')} goPolicy={() => setPage('policy')} />}
        {page === 'jobs' && <JobsPage jobs={jobs} onOpen={openResults} onDeleted={(id) => setJobs((p) => p.filter((j) => j.id !== id))} />}
        {page === 'results' && <ResultsPage jobs={jobs} selected={selected} onSelect={setSelected} />}
        {page === 'settings' && settings && (
          <SettingsPage settings={settings} onChange={setSettings} diag={diag} refreshDiag={refreshDiag} jobs={jobs} />
        )}
        {page === 'policy' && <PolicyPage />}
      </main>
    </div>
  );
}
