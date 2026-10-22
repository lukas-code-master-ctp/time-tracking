/**
 * "Ausencias" page (spec 2026-10-22-solicitud-ausencias): the person requests
 * an absence (pending until an admin approves or rejects it in the portal)
 * and sees her absences with their status. Everything goes through the
 * service worker (`absences.*` messages); the form is static in absences.html.
 */
import '../ui/base.css';
import './absences.css';
import {
  ABSENCE_STATUS_LABELS,
  ABSENCE_TYPE_LABELS,
  DEFAULT_TIME_ZONE,
  absenceStatus,
  dateKey,
  describeAbsenceWhen,
  type Absence,
  type AbsenceType,
  type WithId,
} from '@timetracking/shared';
import type { AbsenceRequest, PopupResponse } from '../messages';
import { el, send } from '../ui/dom';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const form = $<HTMLFormElement>('form');
const type = $<HTMLSelectElement>('type');
const modeDays = $<HTMLButtonElement>('mode-days');
const modeHours = $<HTMLButtonElement>('mode-hours');
const from = $<HTMLInputElement>('from');
const to = $<HTMLInputElement>('to');
const day = $<HTMLInputElement>('day');
const start = $<HTMLInputElement>('start');
const end = $<HTMLInputElement>('end');
const note = $<HTMLTextAreaElement>('note');
const noteLabel = $<HTMLLabelElement>('note-label');
const submit = $<HTMLButtonElement>('submit');
const list = $<HTMLUListElement>('list');
const empty = $<HTMLElement>('empty');
const statusBox = $<HTMLElement>('status');

let hours = false;
const today = dateKey(Date.now(), DEFAULT_TIME_ZONE);
from.value = today;
to.value = today;
day.value = today;

function show(kind: 'warn' | 'error' | 'ok' | null, text = ''): void {
  statusBox.hidden = kind === null;
  statusBox.className = `banner ${kind ?? ''}`;
  statusBox.textContent = text;
}

function setMode(byHours: boolean): void {
  hours = byHours;
  modeDays.classList.toggle('active', !byHours);
  modeHours.classList.toggle('active', byHours);
  modeDays.setAttribute('aria-pressed', String(!byHours));
  modeHours.setAttribute('aria-pressed', String(byHours));
  $('days').hidden = byHours;
  $('hours').hidden = !byHours;
}
modeDays.addEventListener('click', () => setMode(false));
modeHours.addEventListener('click', () => setMode(true));
type.addEventListener('change', () => {
  noteLabel.textContent = type.value === 'other' ? 'Comentario' : 'Comentario (opcional)';
});
from.addEventListener('change', () => {
  if (to.value < from.value) to.value = from.value;
});

function request(): AbsenceRequest {
  return hours
    ? { type: type.value as AbsenceType, startDate: day.value, endDate: day.value, startTime: start.value, endTime: end.value, note: note.value }
    : { type: type.value as AbsenceType, startDate: from.value, endDate: to.value, startTime: null, endTime: null, note: note.value };
}

const STATUS_CLASS = { pending: 'warn', approved: 'ok', rejected: 'muted' } as const;

function renderList(absences: readonly WithId<Absence>[]): void {
  list.replaceChildren(
    ...absences.map((a) => {
      const status = absenceStatus(a);
      const cancel =
        status === 'pending'
          ? (() => {
              const b = el('button', { type: 'button', className: 'link', textContent: 'Retirar' });
              b.setAttribute('aria-label', `Retirar ${ABSENCE_TYPE_LABELS[a.type]} ${describeAbsenceWhen(a)}`);
              b.addEventListener('click', () => void apply(send({ type: 'absences.cancel', id: a.id }), 'Solicitud retirada.'));
              return b;
            })()
          : null;
      return el('li', {}, [
        el('div', { className: 'what' }, [
          el('strong', { textContent: `${ABSENCE_TYPE_LABELS[a.type] ?? 'Ausencia'} · ${describeAbsenceWhen(a)}` }),
          a.note ? el('span', { className: 'small muted', textContent: a.note }) : null,
        ]),
        el('span', { className: `pill ${STATUS_CLASS[status]}`, textContent: ABSENCE_STATUS_LABELS[status] }),
        cancel,
      ]);
    }),
  );
  empty.hidden = absences.length > 0;
}

/** Applies a worker answer: the list, or the error. */
async function apply(pending: Promise<PopupResponse>, okText?: string): Promise<boolean> {
  submit.disabled = true;
  const res = await pending;
  submit.disabled = false;
  if (!res.ok) {
    show(res.reason === 'signed-out' || res.reason === 'not-joined' || res.reason === 'consent-required' ? 'warn' : 'error', res.error);
    return false;
  }
  if (res.absences) renderList(res.absences);
  show(okText ? 'ok' : null, okText);
  return true;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  void apply(send({ type: 'absences.request', absence: request() }), 'Solicitud enviada. Te avisaremos aquí cuando tu administrador la revise.').then((ok) => {
    if (ok) note.value = '';
  });
});

void apply(send({ type: 'absences.list' }));
