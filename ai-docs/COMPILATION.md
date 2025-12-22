# Contract Compilation Guide

## Quick Reference

### Compile with ZK Keys (for deployment)

```bash
cd contract
PATH="$HOME/.compact/versions/0.26.0/aarch64-darwin:$PATH" ../compact/result/bin/compactc src/L2.compact src/managed/L2
PATH="$HOME/.compact/versions/0.26.0/aarch64-darwin:$PATH" ../compact/result/bin/compactc src/Bridge.compact src/managed/Bridge
```

Or use npm:
```bash
cd contract && npm run compact
```

### Compile without ZK Keys (faster, for unit tests only)

```bash
cd contract
../compact/result/bin/compactc --skip-zk src/L2.compact src/managed/L2
../compact/result/bin/compactc --skip-zk src/Bridge.compact src/managed/Bridge
```

## Key Points

1. **Two compilers available:**
   - Local: `./compact/result/bin/compactc` (v0.27.x, language 0.19.x)
   - System: `compact compile` (v0.26.0, language 0.18.0)

2. **zkir tool location:** `~/.compact/versions/0.26.0/aarch64-darwin/zkir`
   - The local compiler doesn't include zkir
   - Must add system zkir to PATH for key generation

3. **Output folders:**
   - `src/managed/L2/` and `src/managed/Bridge/`
   - `contract/` - TypeScript bindings
   - `zkir/` - Circuit definitions (.zkir)
   - `keys/` - Proving/verifying keys (only with zkir)

4. **Runtime version mismatch:**
   - Local compact-runtime (0.11.0) lacks `NetworkId` export
   - CLI integration tests skip due to this incompatibility
   - Contract unit tests work fine

## Run Tests

```bash
# Contract unit tests (117 tests, always work)
cd contract && npm test

# CLI integration tests (require Docker + compatible runtime)
cd cli && npm run test-api
```

## Troubleshooting

| Error | Solution |
|-------|----------|
| `unbound identifier sendShielded` | Using wrong compiler version; use local compiler |
| `no such file: keys/*.verifier` | Compile with zkir in PATH (see above) |
| `NetworkId undefined` | Runtime version mismatch; CLI tests will skip |

