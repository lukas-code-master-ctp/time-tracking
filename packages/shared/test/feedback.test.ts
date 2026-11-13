import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_MAX_LENGTH,
  feedbackVoteDocId,
  isFeedback,
  isFeedbackTone,
  normalizeFeedbackText,
  readFeedbackEnabled,
} from '../src/index.js';

describe('anonymous feedback', () => {
  it('normalizes the text and rejects empty or too long comments', () => {
    expect(normalizeFeedbackText('  Hola  ')).toBe('Hola');
    expect(normalizeFeedbackText('a\r\n\r\n\r\n\r\nb')).toBe('a\n\nb');
    expect(normalizeFeedbackText('   \n ')).toBeNull();
    expect(normalizeFeedbackText(42)).toBeNull();
    expect(normalizeFeedbackText('x'.repeat(FEEDBACK_MAX_LENGTH))).toHaveLength(FEEDBACK_MAX_LENGTH);
    expect(normalizeFeedbackText('x'.repeat(FEEDBACK_MAX_LENGTH + 1))).toBeNull();
  });

  it('validates tones and documents', () => {
    expect(isFeedbackTone('positive')).toBe(true);
    expect(isFeedbackTone('neutral')).toBe(false);
    expect(isFeedback({ week: '2026-W46', tone: 'negative', text: 'Se cayó el sistema' })).toBe(true);
    expect(isFeedback({ week: '2026-46', tone: 'negative', text: 'x' })).toBe(false);
    expect(isFeedback({ week: '2026-W46', tone: 'negative', text: '' })).toBe(false);
    expect(isFeedback(null)).toBe(false);
  });

  it('builds the vote id and reads the setting', () => {
    expect(feedbackVoteDocId('u1', '2026-W46')).toBe('u1_2026-W46');
    expect(() => feedbackVoteDocId('', '2026-W46')).toThrow();
    expect(() => feedbackVoteDocId('u1', 'x')).toThrow();
    expect(readFeedbackEnabled({ feedbackEnabled: true })).toBe(true);
    expect(readFeedbackEnabled({ feedbackEnabled: 'yes' })).toBe(false);
    expect(readFeedbackEnabled(null)).toBe(false);
  });
});
