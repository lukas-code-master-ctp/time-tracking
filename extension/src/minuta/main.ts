/**
 * "Minuta del día" page (spec 2026-11-13-minuta-diaria): the person writes
 * the report of her day, or records an audio that `draftDailyReport`
 * transcribes into a draft she reviews before sending. Everything goes
 * through the service worker (`dailyReport.*` messages).
 */
import '../ui/base.css';
import '../ui/theme';
import '../absences/absences.css';
import './minuta.css';
import { DAILY_REPORT_AUDIO_SAMPLE_RATE, DAILY_REPORT_MAX_AUDIO_SECONDS, DAILY_REPORT_MAX_CHARS, type DailyReport } from '@timetracking/shared';
import type { PopupResponse } from '../messages';
import { send } from '../ui/dom';
import { recordingToWav, toBase64 } from '@timetracking/shared';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const statusBox = $<HTMLElement>('status');
const record = $<HTMLButtonElement>('record');
const timer = $<HTMLElement>('timer');
const level = $<HTMLElement>('level');
const form = $<HTMLFormElement>('form');
const text = $<HTMLTextAreaElement>('text');
const count = $<HTMLElement>('count');
const transcriptBox = $<HTMLDetailsElement>('transcript-box');
const transcriptText = $<HTMLElement>('transcript');
const submit = $<HTMLButtonElement>('submit');

/** Transcript of the audio the current text came from (null = written by hand). */
let transcript: string | null = null;
let sent: DailyReport | null = null;

function show(kind: 'warn' | 'error' | 'ok' | null, message = ''): void {
  statusBox.hidden = kind === null;
  statusBox.className = `banner ${kind ?? ''}`;
  statusBox.textContent = message;
}

function updateCount(): void {
  count.textContent = `${text.value.length} / ${DAILY_REPORT_MAX_CHARS}`;
  submit.textContent = sent ? 'Guardar cambios' : 'Enviar minuta';
}
text.addEventListener('input', updateCount);

function setTranscript(t: string | null): void {
  transcript = t;
  transcriptBox.hidden = !t;
  transcriptText.textContent = t ?? '';
}

function fail(res: Extract<PopupResponse, { ok: false }>): void {
  const warn = res.reason === 'signed-out' || res.reason === 'not-joined' || res.reason === 'consent-required' || res.reason === 'daily-report-off';
  show(warn ? 'warn' : 'error', res.error);
}

// ---------- recording ----------

let recorder: MediaRecorder | null = null;
let stopTimer: (() => void) | null = null;

function mmss(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

async function startRecording(): Promise<void> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    show('error', 'No se pudo usar el micrófono. Permite el acceso en el ícono de la barra de direcciones y vuelve a intentarlo.');
    return;
  }
  show(null);
  const chunks: Blob[] = [];
  const rec = new MediaRecorder(stream, { audioBitsPerSecond: 32_000 });
  recorder = rec;
  rec.addEventListener('dataavailable', (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  });
  rec.addEventListener('stop', () => {
    for (const t of stream.getTracks()) t.stop();
    stopTimer?.();
    recorder = null;
    void transcribe(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
  });

  // Level meter and timer (stops by itself at the limit).
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);
  const bar = level.firstElementChild as HTMLElement;
  const started = Date.now();
  let raf = 0;
  const tick = (): void => {
    const elapsed = (Date.now() - started) / 1000;
    timer.textContent = `${mmss(elapsed)} / ${mmss(DAILY_REPORT_MAX_AUDIO_SECONDS)}`;
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    bar.style.transform = `scaleX(${Math.min(1, peak / 64).toFixed(2)})`;
    if (elapsed >= DAILY_REPORT_MAX_AUDIO_SECONDS && rec.state === 'recording') rec.stop();
    raf = requestAnimationFrame(tick);
  };
  stopTimer = () => {
    cancelAnimationFrame(raf);
    void ctx.close();
    timer.hidden = true;
    level.hidden = true;
  };
  timer.hidden = false;
  level.hidden = false;
  tick();
  rec.start(1000);
  record.textContent = 'Detener y transcribir';
  record.classList.add('recording');
  record.setAttribute('aria-pressed', 'true');
}

async function transcribe(blob: Blob): Promise<void> {
  record.textContent = 'Transcribiendo…';
  record.classList.remove('recording');
  record.removeAttribute('aria-pressed');
  record.disabled = true;
  submit.disabled = true;
  show('warn', 'Transcribiendo tu audio y armando la minuta. Puede tardar hasta un minuto…');
  try {
    let wav: Uint8Array;
    try {
      wav = await recordingToWav(blob, DAILY_REPORT_AUDIO_SAMPLE_RATE);
    } catch {
      show('error', 'No se pudo leer la grabación. Intenta grabar de nuevo.');
      return;
    }
    const res = await send({ type: 'dailyReport.draft', audio: toBase64(wav), mimeType: 'audio/wav' });
    if (!res.ok) {
      fail(res);
      return;
    }
    const draft = res.draft;
    if (!draft || draft.text === '') {
      show('warn', 'No se entendió el audio. Graba de nuevo más cerca del micrófono o escribe la minuta.');
      return;
    }
    // Recording again replaces the draft; a text written before is kept below it.
    const before = text.value.trim();
    text.value = before && !transcript ? `${draft.text}\n\n${before}` : draft.text;
    setTranscript(draft.transcript || null);
    updateCount();
    show('ok', 'Listo. Revisa la minuta, corrige lo que haga falta y envíala.');
    text.focus();
  } finally {
    record.disabled = false;
    record.textContent = 'Grabar otro audio';
    submit.disabled = false;
  }
}

record.addEventListener('click', () => {
  if (recorder && recorder.state === 'recording') recorder.stop();
  else void startRecording();
});

// ---------- send ----------

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (text.value.trim() === '') {
    show('error', 'Escribe tu minuta o graba un audio antes de enviarla.');
    text.focus();
    return;
  }
  submit.disabled = true;
  void send({ type: 'dailyReport.send', text: text.value, source: transcript ? 'audio' : 'text', transcript })
    .then((res) => {
      if (!res.ok) {
        fail(res);
        return;
      }
      const first = !sent;
      sent = res.dailyReport ?? null;
      updateCount();
      show('ok', first ? '¡Gracias! Tu minuta se envió.' : 'Cambios guardados.');
    })
    .finally(() => {
      submit.disabled = false;
    });
});

// ---------- start ----------

void send({ type: 'dailyReport.get' }).then((res) => {
  if (!res.ok) {
    fail(res);
    return;
  }
  sent = res.dailyReport ?? null;
  if (sent) {
    text.value = sent.text;
    setTranscript(sent.source === 'audio' ? sent.transcript : null);
    show('ok', 'Ya enviaste la minuta de hoy. Puedes corregirla y guardar los cambios.');
  }
  updateCount();
});
