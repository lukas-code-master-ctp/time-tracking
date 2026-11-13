/**
 * Daily report drafts with OpenRouter (https://openrouter.ai, decision of
 * Lukas 2026-11-13): one chat completion with the audio as `input_audio`
 * that answers the transcript and the draft as JSON. The model is
 * configurable (env `DAILY_REPORT_MODEL`); it must accept audio input.
 */
import {
  DAILY_REPORT_AI_PROMPT,
  DAILY_REPORT_AI_SCHEMA,
  DAILY_REPORT_AUDIO_FORMATS,
  parseDailyReportDraft,
} from '@timetracking/shared';
import type { DraftModel } from './dailyReportDraft.js';

export const OPENROUTER_SECRET_NAME = 'OPENROUTER_API_KEY';

export const DEFAULT_DAILY_REPORT_MODEL = 'google/gemini-2.5-flash';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/** Model id from the env (`DAILY_REPORT_MODEL`), or the default. */
export function dailyReportModel(env: Record<string, string | undefined>): string {
  return env.DAILY_REPORT_MODEL?.trim() || DEFAULT_DAILY_REPORT_MODEL;
}

/** Request body of the chat completion (exported for tests). */
export function openRouterBody(model: string, audio: { base64: string; mimeType: string }): unknown {
  return {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: DAILY_REPORT_AI_PROMPT },
          { type: 'input_audio', input_audio: { data: audio.base64, format: DAILY_REPORT_AUDIO_FORMATS[audio.mimeType] ?? 'wav' } },
        ],
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'minuta', strict: true, schema: DAILY_REPORT_AI_SCHEMA },
    },
    temperature: 0.2,
  };
}

export function openRouterModel(opts: {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  referer?: string;
}): DraftModel {
  const doFetch = opts.fetch ?? fetch;
  return async (audio) => {
    const res = await doFetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        // Optional attribution headers of OpenRouter.
        ...(opts.referer ? { 'HTTP-Referer': opts.referer } : {}),
        'X-Title': 'Mi Pega HR',
      },
      body: JSON.stringify(openRouterBody(opts.model, audio)),
      signal: AbortSignal.timeout(110_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`OpenRouter ${res.status}: ${detail}`);
    }
    const json = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = json.choices?.[0]?.message?.content;
    const draft = parseDailyReportDraft(typeof content === 'string' ? content : null);
    if (!draft) throw new Error('OpenRouter: respuesta sin JSON válido');
    return draft;
  };
}
