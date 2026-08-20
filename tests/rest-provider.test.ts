import { describe, it, expect } from 'vitest';
import { RestProvider, normalizeStatus, firstUrl } from '../src/higgsfield/rest-provider.js';
import { ProviderError } from '../src/higgsfield/provider.js';

describe('status normalization', () => {
  it('maps terminal states from the documented vocabulary', () => {
    expect(normalizeStatus('completed')).toBe('completed');
    expect(normalizeStatus('failed')).toBe('failed');
    expect(normalizeStatus('nsfw')).toBe('nsfw');
  });

  it('accepts the API\'s US spelling of canceled', () => {
    // The docs use "canceled"; treating it as unknown would leave the job
    // polling forever against a request that will never settle.
    expect(normalizeStatus('canceled')).toBe('cancelled');
    expect(normalizeStatus('cancelled')).toBe('cancelled');
  });

  it('is case insensitive', () => {
    expect(normalizeStatus('COMPLETED')).toBe('completed');
  });

  it('treats an unknown status as non-terminal rather than complete', () => {
    // Guessing "completed" for an unrecognised value would settle spend for
    // work that never finished.
    expect(normalizeStatus('something_new')).toBe('queued');
    expect(normalizeStatus(undefined)).toBe('queued');
  });

  it('recognises in-progress variants', () => {
    for (const s of ['in_progress', 'processing', 'running']) {
      expect(normalizeStatus(s)).toBe('running');
    }
  });
});

describe('output URL extraction', () => {
  it('reads the documented images array', () => {
    expect(firstUrl({ images: [{ url: 'https://cdn/x.jpg' }] })).toBe('https://cdn/x.jpg');
  });

  it('reads a videos array', () => {
    expect(firstUrl({ videos: [{ url: 'https://cdn/x.mp4' }] })).toBe('https://cdn/x.mp4');
  });

  it('prefers videos when both are present', () => {
    const url = firstUrl({
      videos: [{ url: 'https://cdn/v.mp4' }],
      images: [{ url: 'https://cdn/i.jpg' }],
    });
    expect(url).toBe('https://cdn/v.mp4');
  });

  it('returns undefined rather than an empty string', () => {
    expect(firstUrl({})).toBeUndefined();
    expect(firstUrl({ images: [] })).toBeUndefined();
    expect(firstUrl({ images: [{ url: '' }] })).toBeUndefined();
  });
});

describe('pre-submission guards', () => {
  const provider = new RestProvider();

  it('refuses a video submission with no start image', async () => {
    // dop models are image2video. Submitting without one is a guaranteed
    // rejection, so failing locally avoids a pointless round trip.
    await expect(
      provider.submitVideo({
        modelSlug: 'higgsfield-ai/dop/turbo',
        prompt: 'x',
        durationSeconds: 5,
        aspectRatio: '16:9',
      }),
    ).rejects.toThrow(ProviderError);
  });

  it('refuses a first-last-frame submission with no end image', async () => {
    await expect(
      provider.submitVideo({
        modelSlug: 'higgsfield-ai/dop/standard/first-last-frame',
        prompt: 'x',
        durationSeconds: 5,
        aspectRatio: '16:9',
        startImage: 'https://x/start.png',
      }),
    ).rejects.toThrow(/end image/i);
  });
});

describe('provider identity', () => {
  it('declares itself paid', () => {
    // Cost learning is gated on this flag - a mislabelled provider would
    // poison the learned-price database with fake measurements.
    expect(new RestProvider().isPaid).toBe(true);
    expect(new RestProvider().name).toBe('higgsfield');
  });
});
