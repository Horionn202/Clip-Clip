import { useState } from 'react';
import type { Clip, Job } from '../../shared/types';
import { formatTime } from '../../shared/validation';
import { api, errMsg } from '../api';

function ClipCard({ job, clip, onError, onInfo }: { job: Job; clip: Clip; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const [title, setTitle] = useState(clip.title);
  const save = async () => {
    if (title.trim() && title !== clip.title) {
      try {
        await api().renameClip(job.id, clip.id, title.trim());
      } catch (e) {
        onError(errMsg(e));
      }
    }
  };
  return (
    <div className="clip">
      {clip.file ? (
        <video src={`clip://job/${job.id}/${encodeURIComponent(clip.file)}`} controls preload="metadata" />
      ) : (
        <div className="video-ph">Sin renderizar</div>
      )}
      <input className="clip-title" value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} onBlur={save} aria-label="Título del clip" />
      {clip.hook && <p className="hook">«{clip.hook}»</p>}
      <div className="muted small">
        {formatTime(clip.start)} → {formatTime(clip.end)} · {(clip.end - clip.start).toFixed(1)} s · puntuación {Math.round(clip.score)}
      </div>
      {clip.reason && <p className="small muted">{clip.reason}</p>}
      <div className="row">
        <button
          disabled={!clip.file}
          onClick={async () => {
            try {
              const p = await api().exportClip(job.id, clip.id);
              onInfo(`Exportado a ${p}`);
            } catch (e) {
              onError(errMsg(e));
            }
          }}
        >
          Exportar
        </button>
        {clip.exportedPath && <span className="small ok">✓ exportado</span>}
      </div>
    </div>
  );
}

export function ResultsPage(props: { jobs: Job[]; selected: string | null; onSelect: (id: string) => void }) {
  const done = props.jobs.filter((j) => j.status === 'completed');
  const job = done.find((j) => j.id === props.selected) ?? done[0];
  const [msg, setMsg] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);

  if (!job) return <section className="page"><h1>Resultados</h1><div className="empty">Todavía no hay clips. Cuando un trabajo termine, aparecerán aquí.</div></section>;

  return (
    <section className="page">
      <div className="row">
        <h1 className="grow">Resultados</h1>
        <select value={job.id} onChange={(e) => props.onSelect(e.target.value)}>
          {done.map((j) => (
            <option key={j.id} value={j.id}>
              {(j.sourceTitle || j.url).slice(0, 60)}
            </option>
          ))}
        </select>
      </div>
      <div className="row toolbar">
        <button onClick={() => api().openJobFolder(job.id).catch((e) => setMsg({ kind: 'error', text: errMsg(e) }))}>Abrir carpeta de resultados</button>
        <button
          onClick={async () => {
            try {
              const n = await api().exportAll(job.id);
              setMsg({ kind: 'info', text: `${n} clips exportados.` });
            } catch (e) {
              setMsg({ kind: 'error', text: errMsg(e) });
            }
          }}
        >
          Exportar todos
        </button>
        <button className="ghost" onClick={() => api().openExportFolder()}>Abrir carpeta de exportación</button>
      </div>
      {msg && <div className={`banner ${msg.kind === 'error' ? 'error' : 'info'}`}>{msg.text}</div>}
      <div className="gallery">
        {job.clips.map((c) => (
          <ClipCard key={c.id} job={job} clip={c} onError={(t) => setMsg({ kind: 'error', text: t })} onInfo={(t) => setMsg({ kind: 'info', text: t })} />
        ))}
      </div>
    </section>
  );
}
