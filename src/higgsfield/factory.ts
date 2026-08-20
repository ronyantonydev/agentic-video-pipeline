/**
 * Provider selection.
 *
 * One switch decides who spends money, and it is deliberately explicit
 * rather than inferred:
 *
 *   rest  - Node calls the Higgsfield REST API directly. Budget enforcement
 *           is mechanical: authorizeSpend runs in code before the request is
 *           built, and cannot be bypassed. Reaches the dop/soul catalogue.
 *
 *   mcp   - Claude invokes the Higgsfield MCP tools. Reaches the premium
 *           catalogue (Kling, Veo, Seedance, Cinema Studio) which the REST
 *           key cannot see. Architecture section 2 is weakened: the budget
 *           check becomes an instruction to Claude rather than a code path.
 *
 *   fake  - Synthesised media, no network, no cost. For development and CI.
 *
 * The two catalogues barely overlap - they are different products, not one
 * product at two prices - so switching mode also changes which models the
 * generation plan may reference.
 */

import { loadEnv } from '../config/env.js';
import { FakeProvider } from './fake-provider.js';
import { RestProvider } from './rest-provider.js';
import type { GenerationProvider } from './provider.js';

export type ProviderMode = 'rest' | 'mcp' | 'fake';

export function resolveProviderMode(override?: string): ProviderMode {
  const raw = (override ?? process.env['PROVIDER_MODE'] ?? 'rest').toLowerCase();
  if (raw === 'rest' || raw === 'mcp' || raw === 'fake') return raw;
  throw new Error(
    `Unknown PROVIDER_MODE "${raw}". Expected one of: rest, mcp, fake.`,
  );
}

export function createProvider(mode: ProviderMode = resolveProviderMode()): GenerationProvider {
  switch (mode) {
    case 'fake':
      return new FakeProvider();

    case 'rest': {
      const env = loadEnv();
      if (!env.hasHiggsfieldCredentials) {
        throw new Error(
          'PROVIDER_MODE=rest requires HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET in .env.',
        );
      }
      return new RestProvider();
    }

    case 'mcp':
      // Deliberately unimplemented. MCP tools are invoked by Claude, not by
      // this process, so a provider object cannot call them. Wiring this up
      // means routing generation through the skill layer and accepting that
      // the budget check is no longer enforced by code.
      throw new Error(
        'PROVIDER_MODE=mcp is not implemented.\n' +
          '  MCP tools are invoked by Claude, not by Node, so this would move\n' +
          '  spending out of code and weaken the guarantee in architecture §2.\n' +
          '  Use PROVIDER_MODE=rest, or implement the skill-layer route first.',
      );

    default: {
      const exhaustive: never = mode;
      throw new Error(`Unhandled provider mode: ${String(exhaustive)}`);
    }
  }
}

/** Which model catalogue a mode can reach. Used to validate generation plans. */
export function catalogueFor(mode: ProviderMode): 'rest' | 'mcp' | 'none' {
  return mode === 'rest' ? 'rest' : mode === 'mcp' ? 'mcp' : 'none';
}
