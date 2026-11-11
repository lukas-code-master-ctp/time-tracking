/**
 * Front camera of the attendance kiosk (spec 2026-11-10-marcaciones, foto en
 * el tótem): a live preview so people see they are photographed, and a JPEG
 * snapshot sent with each mark. Without a camera (or permission) the kiosk
 * marks without a photo.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ATTENDANCE_PHOTO_MAX_BYTES } from '@timetracking/shared';

export type CameraState = 'starting' | 'on' | 'off';

/** Width of the photo sent (height keeps the camera's aspect ratio). */
const PHOTO_WIDTH = 480;

export function useKioskCamera(): {
  state: CameraState;
  videoRef: (el: HTMLVideoElement | null) => void;
  snapshot: () => string | null;
} {
  const [state, setState] = useState<CameraState>('starting');
  const stream = useRef<MediaStream | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!media?.getUserMedia) {
      setState('off');
      return;
    }
    media
      .getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 } }, audio: false })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream.current = s;
        if (video.current) video.current.srcObject = s;
        setState('on');
        // The camera may be unplugged or taken by another app.
        s.getVideoTracks()[0]?.addEventListener('ended', () => setState('off'));
      })
      .catch(() => {
        if (!cancelled) setState('off');
      });
    return () => {
      cancelled = true;
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
    };
  }, []);

  const videoRef = useCallback((el: HTMLVideoElement | null) => {
    video.current = el;
    if (el && stream.current) el.srcObject = stream.current;
  }, []);

  const snapshot = useCallback((): string | null => {
    const v = video.current;
    if (!v || !stream.current || v.videoWidth === 0 || v.videoHeight === 0) return null;
    const canvas = document.createElement('canvas');
    canvas.width = PHOTO_WIDTH;
    canvas.height = Math.round((v.videoHeight / v.videoWidth) * PHOTO_WIDTH);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.75, 0.55, 0.4]) {
      const url = canvas.toDataURL('image/jpeg', quality);
      // base64 length * 3/4 ≈ bytes.
      if (url.startsWith('data:image/jpeg') && (url.length - 23) * 0.75 <= ATTENDANCE_PHOTO_MAX_BYTES) return url;
    }
    return null;
  }, []);

  return { state, videoRef, snapshot };
}
