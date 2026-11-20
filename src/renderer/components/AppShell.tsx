// Estructura de la app: sidebar (completa ≥ 1024 px, compacta con tooltips en 768–1023 px, cajón por debajo de 768 px).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import logoUrl from '../assets/logo-128.png';
import { Icon, IconButton, type IconName } from './ui';

export interface NavItem<P extends string> {
  page: P;
  label: string;
  icon: IconName;
  count?: number;
}

export function Sidebar<P extends string>(props: {
  items: NavItem<P>[];
  bottom: NavItem<P>[];
  page: P;
  onNavigate: (p: P) => void;
  diag: { ok: boolean } | null;
  onDiag: () => void;
  version?: string;
  open: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  // Cajón (ventana estrecha): Escape lo cierra y el foco entra en él al abrir.
  useEffect(() => {
    if (!props.open) return;
    ref.current?.querySelector<HTMLElement>('.nav-item')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.open]); // eslint-disable-line react-hooks/exhaustive-deps

  const item = (it: NavItem<P>) => (
    <button
      key={it.page}
      type="button"
      className={`nav-item ${props.page === it.page ? 'active' : ''}`}
      aria-current={props.page === it.page ? 'page' : undefined}
      data-tip={it.label}
      aria-label={it.count ? `${it.label} (${it.count} en curso)` : it.label}
      onClick={() => {
        props.onNavigate(it.page);
        props.onClose();
      }}
    >
      <Icon name={it.icon} size={20} />
      <span className="nav-label">{it.label}</span>
      {it.count ? (
        <span className="nav-count" aria-hidden="true">
          {it.count}
        </span>
      ) : null}
    </button>
  );

  const d = props.diag;
  return (
    <>
      {props.open && <div className="drawer-backdrop" onClick={props.onClose} aria-hidden="true" />}
      <aside ref={ref} className={`sidebar ${props.open ? 'open' : ''}`} aria-label="Navegación principal">
        <div className="brand">
          <img src={logoUrl} alt="" width={34} height={34} />
          <span>Clip Clip</span>
        </div>
        <nav className="nav">{props.items.map(item)}</nav>
        <div className="nav-bottom">
          <nav className="nav" aria-label="Información">
            {props.bottom.map(item)}
          </nav>
          <button type="button" className={`diag-pill ${d ? (d.ok ? 'ok' : 'bad') : ''}`} data-tip={d ? (d.ok ? 'Dependencias OK' : 'Faltan dependencias') : 'Comprobando…'} onClick={props.onDiag}>
            <span className="dot" aria-hidden="true" />
            <span className="diag-label">{d ? (d.ok ? 'Dependencias OK' : 'Faltan dependencias') : 'Comprobando…'}</span>
          </button>
          <p className="local-note">Todo se procesa en este equipo.</p>
          {props.version && <p className="local-note">Versión {props.version}</p>}
        </div>
      </aside>
    </>
  );
}

/** Contenedor: barra superior (sólo en ventanas estrechas), sidebar y contenido con scroll propio. */
export function AppShell({ sidebar, children, onMenu, menuOpen }: { sidebar: ReactNode; children: ReactNode; onMenu: () => void; menuOpen: boolean }) {
  return (
    <div className="app">
      <header className="topbar">
        <IconButton icon="menu" label="Abrir menú" aria-expanded={menuOpen} onClick={onMenu} className="ghost" />
        <div className="brand">
          <img src={logoUrl} alt="" width={28} height={28} />
          <span>Clip Clip</span>
        </div>
      </header>
      {sidebar}
      <main className="content" id="main">
        {children}
      </main>
    </div>
  );
}

/** Estado del cajón: se cierra solo al ensanchar la ventana. */
export function useDrawer(): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const f = () => mq.matches && setOpen(false);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, []);
  return [open, setOpen];
}
