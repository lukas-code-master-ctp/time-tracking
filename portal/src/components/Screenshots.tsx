import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ScreenshotMeta, WithId } from '@timetracking/shared';
import { formatTime } from '../lib/dates';
import { useData } from '../data/context';
import { Modal } from './Modal';

type Shot = WithId<ScreenshotMeta>;

/** Download URLs are fetched once per path and shared by thumbnails and the lightbox. */
const urlCache = new Map<string, Promise<string>>();

function useScreenshotUrl(path: string, enabled: boolean): { url: string | null; failed: boolean } {
  const data = useData();
  // Tagged with its path: in the lightbox the path changes (previous/next) and
  // the previous image must not be shown under the new time.
  const [state, setState] = useState<{ path: string; url: string | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let p = urlCache.get(path);
    if (!p) {
      p = data.screenshotUrl(path);
      urlCache.set(path, p);
      p.catch(() => urlCache.delete(path));
    }
    p.then(
      (url) => alive && setState({ path, url, failed: false }),
      () => alive && setState({ path, url: null, failed: true }),
    );
    return () => {
      alive = false;
    };
  }, [data, path, enabled]);
  return state && state.path === path ? { url: state.url, failed: state.failed } : { url: null, failed: false };
}

/** True once the element is (about to be) visible. */
function useVisible<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);
  return [ref, visible];
}

function Thumb({ shot, onOpen }: { shot: Shot; onOpen(): void }) {
  const [ref, visible] = useVisible<HTMLButtonElement>();
  const { url, failed } = useScreenshotUrl(shot.storagePath, visible);
  const time = formatTime(shot.takenAt);
  return (
    <button
      ref={ref}
      type="button"
      className="thumb"
      onClick={onOpen}
      aria-label={`Captura de las ${time}${shot.blurred ? ' (difuminada)' : ''}. Ampliar`}
    >
      <span className="thumb-img" style={{ aspectRatio: `${shot.width} / ${shot.height}` }}>
        {url ? (
          <img src={url} alt="" loading="lazy" decoding="async" data-testid="screenshot-thumb" />
        ) : (
          <span className="thumb-placeholder">{failed ? 'No disponible' : ''}</span>
        )}
      </span>
      <span className="thumb-meta">
        <span>{time}</span>
        {shot.blurred ? <span className="chip small-chip">Difuminada</span> : null}
      </span>
    </button>
  );
}

export function ScreenshotGallery({
  shots,
  openId,
  onOpen,
  onClose,
}: {
  shots: readonly Shot[];
  openId: string | null;
  onOpen(id: string): void;
  onClose(): void;
}) {
  const index = openId ? shots.findIndex((s) => s.id === openId) : -1;
  return (
    <>
      <div className="gallery">
        {shots.map((s) => (
          <Thumb key={s.id} shot={s} onOpen={() => onOpen(s.id)} />
        ))}
      </div>
      {index >= 0 ? (
        <Lightbox
          shot={shots[index]!}
          position={`${index + 1} de ${shots.length}`}
          onPrev={index > 0 ? () => onOpen(shots[index - 1]!.id) : undefined}
          onNext={index < shots.length - 1 ? () => onOpen(shots[index + 1]!.id) : undefined}
          onClose={onClose}
        />
      ) : null}
    </>
  );
}

function Lightbox({
  shot,
  position,
  onPrev,
  onNext,
  onClose,
}: {
  shot: Shot;
  position: string;
  onPrev: (() => void) | undefined;
  onNext: (() => void) | undefined;
  onClose(): void;
}) {
  const { url, failed } = useScreenshotUrl(shot.storagePath, true);
  const time = formatTime(shot.takenAt);
  return (
    <Modal
      title={`Captura de las ${time}`}
      onClose={onClose}
      className="lightbox"
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') onPrev?.();
        if (e.key === 'ArrowRight') onNext?.();
      }}
    >
      <div className="lightbox-meta">
        <span>{position}</span>
        {shot.blurred ? <span className="chip">Difuminada</span> : <span className="chip muted-chip">Sin difuminar</span>}
        <span className="muted small">
          {shot.width}×{shot.height}
        </span>
      </div>
      <div className="lightbox-img">
        {url ? (
          <img src={url} alt={`Captura de pantalla de las ${time}`} data-testid="lightbox-img" />
        ) : (
          <p className="muted">{failed ? 'No se pudo cargar la captura.' : 'Cargando…'}</p>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onPrev} disabled={!onPrev}>
          ← Anterior
        </button>
        <button type="button" className="btn" onClick={onNext} disabled={!onNext}>
          Siguiente →
        </button>
        <button type="button" className="btn primary" onClick={onClose} data-autofocus>
          Cerrar
        </button>
      </div>
    </Modal>
  );
}
