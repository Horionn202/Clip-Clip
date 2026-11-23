import { useState } from 'react';
import { SOURCE_ERROR_ACTIONS, describeSourceError, technicalCommands, type SourceErrorAction, type SourceFailure } from '../../shared/sourceErrors';
import { Modal } from './Modal';

/**
 * Fallo al leer o descargar un vídeo: explicación sencilla y cuatro salidas. Los comandos técnicos sólo aparecen
 * dentro del diagnóstico avanzado, con botón de copiar.
 */
export function SourceErrorModal(props: { open: boolean; failure: SourceFailure; onClose: () => void; onAction: (a: Exclude<SourceErrorAction, 'diagnostics'>) => void }) {
  const [tech, setTech] = useState(false);
  const [copied, setCopied] = useState('');
  const f = props.failure;
  const d = describeSourceError(f);
  const copy = (text: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => setCopied(text))
      .catch(() => setCopied(''));
  };
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      size="md"
      title={d.title}
      footer={
        <div className="source-error-actions">
          {SOURCE_ERROR_ACTIONS.map((a) =>
            a.id === 'diagnostics' ? (
              <button key={a.id} className="ghost" aria-expanded={tech} onClick={() => setTech((x) => !x)}>
                {tech ? 'Ocultar diagnóstico técnico' : a.label}
              </button>
            ) : (
              <button key={a.id} className={a.id === 'import-file' ? 'primary' : ''} onClick={() => props.onAction(a.id as Exclude<SourceErrorAction, 'diagnostics'>)}>
                {a.label}
              </button>
            ),
          )}
        </div>
      }
    >
      <p>{d.message}</p>
      {d.suggestUpdate && <p className="small muted">Puedes comprobar si hay una versión nueva de yt-dlp en Configuración → Diagnóstico.</p>}
      {tech && (
        <section className="source-error-tech" aria-label="Diagnóstico técnico">
          <table className="table kv small">
            <tbody>
              <tr>
                <td>Causa detectada</td>
                <td>{f.kind}</td>
              </tr>
              <tr>
                <td>yt-dlp</td>
                <td>{f.ytDlpVersion ?? 'versión desconocida'}</td>
              </tr>
              <tr>
                <td>Intentos</td>
                <td>{f.attempts}</td>
              </tr>
              <tr>
                <td>Fecha</td>
                <td>{new Date(f.at).toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
          {f.technical && <pre className="log-box">{f.technical}</pre>}
          <h4 className="small">Comandos (para usuarios avanzados)</h4>
          <ul className="source-error-cmds">
            {technicalCommands(f).map((c) => (
              <li key={c.command}>
                <span className="small muted">{c.label}</span>
                <code>{c.command}</code>
                <button className="ghost small" onClick={() => copy(c.command)}>
                  {copied === c.command ? 'Copiado' : 'Copiar'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Modal>
  );
}
