import { describe, expect, it } from 'vitest';
import { DEFAULT_DAILY_REPORT_MODEL, dailyReportModel, openRouterBody, openRouterModel } from '../../src/core/openrouter.js';

const audio = { base64: 'UklGRg==', mimeType: 'audio/wav' };

describe('openrouter', () => {
  it('uses the model from the env, or the default', () => {
    expect(dailyReportModel({})).toBe(DEFAULT_DAILY_REPORT_MODEL);
    expect(dailyReportModel({ DAILY_REPORT_MODEL: ' openai/gpt-4o-audio-preview ' })).toBe('openai/gpt-4o-audio-preview');
  });

  it('sends the audio as input_audio with a JSON schema', () => {
    const body = openRouterBody('m', audio) as {
      model: string;
      messages: { content: { type: string; input_audio?: { data: string; format: string } }[] }[];
      response_format: { type: string };
    };
    expect(body.model).toBe('m');
    expect(body.messages[0]!.content[1]).toEqual({ type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } });
    expect(body.response_format.type).toBe('json_schema');
  });

  it('parses the answer (also inside a ```json fence) and reports errors', async () => {
    let seen: RequestInit | undefined;
    const ok = openRouterModel({
      apiKey: 'k',
      model: 'm',
      fetch: (async (_url: string, init: RequestInit) => {
        seen = init;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '```json\n{"transcript":" Hola ","minuta":"- Visité Maipú."}\n```' } }] }),
        );
      }) as unknown as typeof fetch,
    });
    expect(await ok(audio)).toEqual({ transcript: 'Hola', text: '- Visité Maipú.' });
    expect((seen!.headers as Record<string, string>).Authorization).toBe('Bearer k');

    const bad = openRouterModel({
      apiKey: 'k',
      model: 'm',
      fetch: (async () => new Response('sin saldo', { status: 402 })) as unknown as typeof fetch,
    });
    await expect(bad(audio)).rejects.toThrow('OpenRouter 402');
  });
});
