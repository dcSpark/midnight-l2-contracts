/**
 * Tests that the refactored CLI modules load and config resolution works.
 */
import { describe, expect, it } from 'vitest';
import { resolveCliConfig } from '../cli-config.js';

const validContractAddress = 'a'.repeat(64);

describe('bridge-cli', () => {
  it('resolveCliConfig returns config and contract address when contract provided', () => {
    const cliConfig = resolveCliConfig({ contract: validContractAddress });
    expect(cliConfig.contractAddress).toBe(validContractAddress);
    expect(cliConfig.config).toBeDefined();
    expect(cliConfig.config.indexer).toBeDefined();
    expect(cliConfig.networkLabel).toBeDefined();
  });

  it('resolveCliConfig throws when contract address is invalid', () => {
    expect(() => resolveCliConfig({ contract: 'short' })).toThrow();
    expect(() => resolveCliConfig({ contract: 'g'.repeat(64) })).toThrow();
  });
});
