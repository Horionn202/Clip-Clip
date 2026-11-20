// Componentes base del sistema de diseño (ver design.css). Sin dependencias externas.
import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

/* ---------- Iconos (trazo 1.8, 20×20, heredan el color) ---------- */
const PATHS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  jobs: 'M4 6h16M4 12h16M4 18h10',
  results: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  publish: 'M12 16V4m0 0-4 4m4-4 4 4M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5',
  live: 'M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  shield: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 6l12 12M18 6 6 18',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  broom: 'M14 4l6 6M4 20l7-7m-2-2 4 4-5 5H4v-4z',
  download: 'M12 4v12m0 0-4-4m4 4 4-4M5 20h14',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4',
  check: 'M5 12l5 5L20 7',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  cpu: 'M9 9h6v6H9zM5 5h14v14H5zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  disk: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM8 16h.01M4 13h16',
  palette: 'M12 3a9 9 0 0 0 0 18c1 0 1.5-.8 1.5-1.5 0-1.2-1-1.5-1-2.5 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4-4-7.5-9-7.5zM7.5 11h.01M10 7h.01M15 7h.01',
  stethoscope: 'M6 3v6a4 4 0 0 0 8 0V3M10 13v3a5 5 0 0 0 10 0v-2M20 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  export: 'M14 4h6v6M20 4 10 14M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  play: 'M7 4l13 8-13 8z',
  pause: 'M7 4h4v16H7zM13 4h4v16h-4z',
  stop: 'M6 6h12v12H6z',
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className = '' }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={`icon ${className}`.trim()} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}

/* ---------- Botones ---------- */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-solid' | 'link';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'big';
  icon?: IconName;
  loading?: boolean;
}

/** Botón con variantes y estado de carga (deshabilitado y con aria-busy mientras carga). */
export function Button({ variant = 'secondary', size = 'md', icon, loading = false, className = '', children, disabled, type = 'button', ...rest }: ButtonProps) {
  const cls = [variant === 'secondary' ? '' : variant, size === 'md' ? '' : size, className].filter(Boolean).join(' ');
  return (
    <button type={type} className={cls || undefined} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <span className="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
}

/** Botón de sólo icono: siempre con nombre accesible y tooltip. */
export function IconButton({ icon, label, className = '', ...rest }: Omit<ButtonProps, 'children' | 'icon'> & { icon: IconName; label: string }) {
  return (
    <button type="button" className={`icon-btn ${className}`.trim()} aria-label={label} data-tip={label} {...rest}>
      <Icon name={icon} />
    </button>
  );
}

/* ---------- Estructura ---------- */
export function PageHeader({ title, subtitle, actions, children }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="ph-text">
        <h1>{title}</h1>
        {subtitle && <p className="ph-sub">{subtitle}</p>}
      </div>
      {actions && <div className="ph-actions">{actions}</div>}
      {children}
    </header>
  );
}

export type Tone = 'neutral' | 'active' | 'ok' | 'warn' | 'err' | 'primary';
export function StatusPill({ tone = 'neutral', children, dot = false, title }: { tone?: Tone; children: ReactNode; dot?: boolean; title?: string }) {
  return (
    <span className={`pill ${tone}`} title={title}>
      {dot && <span className="dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function SectionCard({ title, description, icon, actions, children, id }: { title: ReactNode; description?: ReactNode; icon?: IconName; actions?: ReactNode; children: ReactNode; id?: string }) {
  const hid = id ? `${id}-h` : undefined;
  return (
    <section className="section-card" id={id} aria-labelledby={hid}>
      <header>
        {icon && (
          <span className="sc-icon" aria-hidden="true">
            <Icon name={icon} />
          </span>
        )}
        <div className="grow">
          <h2 id={hid}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function EmptyState({ icon = 'film', title, children, action }: { icon?: IconName; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state" role="status">
      <span className="es-icon" aria-hidden="true">
        <Icon name={icon} size={24} />
      </span>
      <b>{title}</b>
      {children && <span>{children}</span>}
      {action}
    </div>
  );
}

export function Skeleton({ height = 16, width = '100%', className = '' }: { height?: number | string; width?: number | string; className?: string }) {
  return <div className={`skeleton ${className}`.trim()} style={{ height, width }} aria-hidden="true" />;
}

/* ---------- Toasts ---------- */
export interface ToastData {
  id: number;
  text: ReactNode;
  kind?: 'info' | 'error';
  /** `run` devuelve false (o falla) si el aviso debe quedarse con su acción (p. ej. «Deshacer» incompleto). */
  action?: { label: string; run: () => void | boolean | Promise<void | boolean> };
  /** ms hasta cerrarse sola (0 = no se cierra sola). */
  ttl?: number;
  /** Hora absoluta (ms) a la que caduca: no se reinicia aunque la app se vuelva a pintar. */
  expiresAt?: number;
}

export function ToastHost({ toasts, onDismiss }: { toasts: ToastData[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toast-host" aria-live="polite" role="region" aria-label="Notificaciones">
      {toasts.map((t) => (
        <ToastItem key={t.id} t={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({ t, onDismiss }: { t: ToastData; onDismiss: (id: number) => void }) {
  const [busy, setBusy] = useState(false);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  // El plazo se fija una vez (por id): los repintados de la app no lo reinician.
  useEffect(() => {
    if (t.ttl === 0 && !t.expiresAt) return;
    const until = t.expiresAt ?? Date.now() + (t.ttl ?? 6000);
    const h = setTimeout(() => dismissRef.current(t.id), Math.max(0, until - Date.now()));
    return () => clearTimeout(h);
  }, [t.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`toast ${t.kind ?? 'info'}`} role={t.kind === 'error' ? 'alert' : 'status'}>
      <Icon name={t.kind === 'error' ? 'alert' : 'check'} />
      <span className="grow">{t.text}</span>
      {t.action && (
        <Button
          size="sm"
          icon="undo"
          loading={busy}
          onClick={() => {
            setBusy(true);
            void Promise.resolve()
              .then(() => t.action!.run())
              .then((r) => (r === false ? setBusy(false) : onDismiss(t.id)))
              .catch(() => setBusy(false));
          }}
        >
          {t.action.label}
        </Button>
      )}
      <IconButton icon="close" label="Cerrar notificación" className="ghost sm" onClick={() => onDismiss(t.id)} />
    </div>
  );
}

/** Estado de toasts para una página o la app. */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const seq = useRef(0);
  // Callbacks estables: no cambian en cada repintado (si no, los avisos reiniciarían su plazo).
  const push = useCallback((t: Omit<ToastData, 'id'>) => setToasts((p) => [...p, { ...t, id: ++seq.current, expiresAt: t.expiresAt ?? (t.ttl === 0 ? undefined : Date.now() + (t.ttl ?? 6000)) }]), []);
  const dismiss = useCallback((id: number) => setToasts((p) => p.filter((x) => x.id !== id)), []);
  return { toasts, push, dismiss };
}

/* ---------- Menú contextual (teclado: Escape cierra, foco vuelve al botón) ---------- */
export function Menu({ label, items, icon = 'more' }: { label: string; icon?: IconName; items: { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const out = (e: MouseEvent) => !box.current?.parentElement?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', out);
    return () => document.removeEventListener('mousedown', out);
  }, [open]);
  return (
    <div
      className="menu"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          btn.current?.focus();
        }
      }}
    >
      <button ref={btn} type="button" className="ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name={icon} size={16} />
        {label}
      </button>
      {open && (
        <div ref={box} className="menu-list" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={it.danger ? 'danger' : undefined}
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
