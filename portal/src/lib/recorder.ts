/**
 * Microphone recording of the phone page (spec 2026-11-13-minuta-terreno):
 * MediaRecorder (WebM/Opus on Android, MP4/AAC on iPhone) plus a level meter.
 * The recording is converted to WAV with `recordingToWav` (shared) before it
 * goes to `draftDailyReport`.
 */

export interface Recording {
  /** Stops and resolves with the audio. */
  stop(): Promise<Blob>;
  /** Stops and drops the audio. */
  cancel(): void;
}

export class MicrophoneError extends Error {
  constructor(readonly reason: 'unsupported' | 'denied') {
    super(
      reason === 'unsupported'
        ? 'Este navegador no puede grabar audio. Abre la página en Chrome (Android) o Safari (iPhone), o escribe la minuta.'
        : 'No se pudo usar el micrófono. Permite el acceso al micrófono para esta página y vuelve a intentarlo.',
    );
    this.name = 'MicrophoneError';
  }
}

/** Starts recording; `onLevel` gets 0..1 about 60 times per second. */
export async function startRecording(onLevel: (level: number) => void): Promise<Recording> {
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) throw new MicrophoneError('unsupported');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    throw new MicrophoneError('denied');
  }
  const chunks: Blob[] = [];
  const rec = new MediaRecorder(stream, { audioBitsPerSecond: 32_000 });
  rec.addEventListener('dataavailable', (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  });

  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);
  let raf = 0;
  const tick = (): void => {
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    onLevel(Math.min(1, peak / 64));
    raf = requestAnimationFrame(tick);
  };
  tick();

  const release = (): void => {
    cancelAnimationFrame(raf);
    void ctx.close();
    for (const t of stream.getTracks()) t.stop();
  };
  rec.start(1000);
  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        rec.addEventListener(
          'stop',
          () => {
            release();
            resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
          },
          { once: true },
        );
        if (rec.state === 'inactive') {
          release();
          resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
        } else rec.stop();
      }),
    cancel: () => {
      if (rec.state !== 'inactive') rec.stop();
      release();
    },
  };
}

/** "1:05" */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
