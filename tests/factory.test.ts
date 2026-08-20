import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveProviderMode, createProvider, catalogueFor } from '../src/higgsfield/factory.js';
import { resetEnvCache } from '../src/config/env.js';

const ORIGINAL = { ...process.env };

beforeEach(() => resetEnvCache());
afterEach(() => {
  process.env = { ...ORIGINAL };
  resetEnvCache();
});

describe('provider mode resolution', () => {
  it('defaults to rest - code spends, not Claude', () => {
    delete process.env['PROVIDER_MODE'];
    expect(resolveProviderMode()).toBe('rest');
  });

  it('reads the environment', () => {
    process.env['PROVIDER_MODE'] = 'fake';
    expect(resolveProviderMode()).toBe('fake');
  });

  it('accepts an explicit override', () => {
    process.env['PROVIDER_MODE'] = 'rest';
    expect(resolveProviderMode('fake')).toBe('fake');
  });

  it('is case insensitive', () => {
    expect(resolveProviderMode('REST')).toBe('rest');
  });

  it('rejects an unknown mode rather than silently defaulting', () => {
    // Falling back to a default here could route spending through the wrong
    // provider without anyone noticing.
    expect(() => resolveProviderMode('cheap')).toThrow(/Unknown PROVIDER_MODE/);
  });
});

describe('provider construction', () => {
  it('builds a fake provider that cannot spend', () => {
    const p = createProvider('fake');
    expect(p.isPaid).toBe(false);
  });

  it('builds a paid rest provider when credentials exist', () => {
    process.env['HIGGSFIELD_API_KEY'] = 'k';
    process.env['HIGGSFIELD_API_SECRET'] = 's';
    const p = createProvider('rest');
    expect(p.isPaid).toBe(true);
    expect(p.name).toBe('higgsfield');
  });

  it('refuses rest mode without credentials', () => {
    process.env['HIGGSFIELD_API_KEY'] = '';
    process.env['HIGGSFIELD_API_SECRET'] = '';
    expect(() => createProvider('rest')).toThrow(/requires HIGGSFIELD_API_KEY/);
  });

  it('refuses mcp mode with an explanation rather than failing obscurely', () => {
    expect(() => createProvider('mcp')).toThrow(/not implemented/);
    expect(() => createProvider('mcp')).toThrow(/§2/);
  });
});

describe('catalogue mapping', () => {
  it('maps each mode to the catalogue it can reach', () => {
    // The two catalogues barely overlap, so a generation plan written for
    // one mode will not run in the other.
    expect(catalogueFor('rest')).toBe('rest');
    expect(catalogueFor('mcp')).toBe('mcp');
    expect(catalogueFor('fake')).toBe('none');
  });
});
