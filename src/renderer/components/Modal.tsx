import { useEffect, useId, useRef, type ReactNode } from 'react';
import { FOCUSABLE, canClose, nextFocusIndex } from '../modalLogic';

export interface ModalProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Acciones principales (pie fijo). */
  footer?: ReactNode;
  /** Contenido extra de la cabecera (miniatura, estado…). */
  headerExtra?: ReactNode;
  /** Si hay cambios sin guardar, cerrar (Escape, ×, fondo) pide confirmación. */
  dirty?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/**
 * Ventana modal accesible sobre <dialog> nativo (capa superior, fondo inerte): fondo oscurecido, cabecera y pie fijos,
 * scroll interno (la página de fondo no se alarga ni se desplaza), foco atrapado, Escape cierra sin guardar,
 * y en pantallas estrechas ocupa toda la ventana.
 */
export function Modal({ open, title, onClose, children, footer, headerExtra, dirty = false, size = 'md', className = '' }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const returnTo = useRef<Element | null>(null);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const requestClose = () => {
    if (canClose(dirtyRef.current, (m) => window.confirm(m))) onClose();
  };

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnTo.current = document.activeElement;
      d.showModal();
      document.body.classList.add('modal-open');
      // Primer campo o botón útil (el de cerrar va al final del orden de preferencia).
      const first = d.querySelector<HTMLElement>(`.modal-body ${FOCUSABLE.split(',').join(', .modal-body ')}`) ?? d.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus();
    }
    if (!open && d.open) d.close();
    return () => {
      if (!open) return;
      if (!document.querySelector('dialog[open].modal2')) document.body.classList.remove('modal-open');
      (returnTo.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDialogElement>) => {
    if (e.key !== 'Tab') return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((el) => el.offsetParent !== null || el === document.activeElement);
    const i = nextFocusIndex(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
    if (i >= 0) {
      e.preventDefault();
      items[i].focus();
    }
  };

  return (
    <dialog
      ref={ref}
      className={`modal2 modal-${size} ${className}`.trim()}
      aria-labelledby={titleId}
      aria-modal="true"
      onKeyDown={onKeyDown}
      // Escape: el navegador emite «cancel»; se intercepta para confirmar si hay cambios.
      onCancel={(e) => {
        e.preventDefault();
        requestClose();
      }}
      // Clic en el fondo (fuera de la caja) = cerrar.
      onMouseDown={(e) => {
        if (e.target === ref.current) requestClose();
      }}
    >
      {open && (
        <>
          <header className="modal-head">
            {headerExtra}
            <h2 id={titleId} className="grow">
              {title}
            </h2>
            <button type="button" className="ghost modal-close" aria-label="Cerrar" onClick={requestClose}>
              ×
            </button>
          </header>
          <div className="modal-body">{children}</div>
          {footer && <footer className="modal-foot">{footer}</footer>}
        </>
      )}
    </dialog>
  );
}

/** Confirmación simple en modal (en vez de window.confirm). */
export function ConfirmModal(props: { open: boolean; title: string; children: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      size="sm"
      title={props.title}
      footer={
        <>
          <button className="ghost" onClick={props.onClose}>
            Cancelar
          </button>
          <button className={props.danger ? 'danger' : 'primary'} disabled={props.busy} onClick={props.onConfirm}>
            {props.confirmLabel}
          </button>
        </>
      }
    >
      {props.children}
    </Modal>
  );
}
