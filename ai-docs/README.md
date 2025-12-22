# AI Documentation for Compact

Instructions for generating AI-friendly documentation for the Compact smart contract language.

## Purpose

The original Compact documentation (`compact/doc/lang-ref.mdx`) is ~2000 lines with verbose prose, HTML tables, and formal grammar. This is too large and noisy for AI context windows. We created condensed versions optimized for AI consumption.

## Source Files (in `compact/`)

| File | Purpose | Issues for AI |
|------|---------|---------------|
| `doc/lang-ref.mdx` | Full language reference | ~15k tokens, HTML tables, verbose |
| `doc/ledger-adt.mdx` | Ledger ADT operations | Usable, ~5k tokens |
| `doc/api/CompactStandardLibrary/exports.md` | Stdlib API docs | Good, ~4k tokens |
| `compiler/standard-library.compact` | Stdlib source code | Excellent reference |
| `examples/*.compact` | Example contracts | Essential for learning |

## What We Created

### `compact-ai-doc/COMPACT_LANGUAGE_REFERENCE.md`
- **Condensed language reference** (~538 lines, ~4k tokens)
- Pure markdown (no HTML)
- Code-first with tables for quick lookup
- Covers: types, casts, circuits, witnesses, ledger, modules, expressions, patterns
- Created by extracting essential content from `lang-ref.mdx` and removing:
  - Formal grammar productions
  - Repetitive "it is a static error if..." prose
  - HTML tables
  - Edge case explanations

### `compact-ai-doc/standard-library.compact`
- Copy of `compact/compiler/standard-library.compact` (license header removed)
- Shows actual implementation of stdlib types and circuits

### `compact-ai-doc/ledger-adt.mdx`
- Copy of `compact/doc/ledger-adt.mdx`
- Reference for Cell, Counter, Map, Set, List, MerkleTree operations

### `compact-ai-doc/exports.md`
- Copy of `compact/doc/api/CompactStandardLibrary/exports.md`
- Detailed API for stdlib functions

### `compact-ai-doc/examples/`
- Curated example contracts from `compact/examples/`
- License headers removed to save tokens
- Selected for variety: simple (counter), complex (election, zerocash), patterns

| File | Source Location | Description |
|------|-----------------|-------------|
| `counter.compact` | `examples/counter.compact` | Simplest example — Counter ADT usage |
| `election.compact` | `examples/election.compact` | Complex: enums, MerkleTree, commit-reveal, witnesses |
| `zerocash.compact` | `examples/zerocash.compact` | Privacy: nullifiers, HistoricMerkleTree, Opaque types |
| `constructor.compact` | `examples/adt/tests/constructor.compact` | Constructor pattern, List ADT, complex structs |
| `advanced_casts.compact` | `examples/casts/advanced_casts.compact` | Type casting patterns between all types |
| `pm_16723.compact` | `examples/wpp/pm_16723.compact` | Disclosure rules and ADT operations |
| `selective_examples.compact` | `examples/modules/selective_examples.compact` | Module imports, exports, prefixes, generic modules |
| `slice_part_one.compact` | `examples/vectors/slice_part_one.compact` | Slice operations, hex/binary literals, loops, map/fold |

## How to Recreate

### 1. Condense the language reference

```
Source: compact/doc/lang-ref.mdx
Output: compact-ai-doc/COMPACT_LANGUAGE_REFERENCE.md

Process:
- Extract type definitions, syntax examples, operator tables
- Convert HTML tables to markdown tables
- Remove formal grammar (EBNF productions)
- Remove "it is a static error" repetitions
- Keep one clear example per concept
- Add "Common Patterns" and "Key Gotchas" sections
```

### 2. Copy reference files

```bash
cp compact/compiler/standard-library.compact ai-docs/compact-ai-doc/
cp compact/doc/ledger-adt.mdx ai-docs/compact-ai-doc/
cp compact/doc/api/CompactStandardLibrary/exports.md ai-docs/compact-ai-doc/
```

### 3. Select and clean example contracts

```bash
mkdir -p ai-docs/compact-ai-doc/examples

# Copy examples from various locations
cp compact/examples/counter.compact ai-docs/compact-ai-doc/examples/
cp compact/examples/election.compact ai-docs/compact-ai-doc/examples/
cp compact/examples/zerocash.compact ai-docs/compact-ai-doc/examples/
cp compact/examples/adt/tests/constructor.compact ai-docs/compact-ai-doc/examples/
cp compact/examples/casts/advanced_casts.compact ai-docs/compact-ai-doc/examples/
cp compact/examples/wpp/pm_16723.compact ai-docs/compact-ai-doc/examples/
cp compact/examples/modules/selective_examples.compact ai-docs/compact-ai-doc/examples/
cp compact/examples/vectors/slice_part_one.compact ai-docs/compact-ai-doc/examples/
```

### 4. Remove license headers from examples

Remove the Apache 2.0 license header from each example file to save ~15 lines per file:

```bash
# The header to remove (15 lines):
# // This file is part of Compact.
# // Copyright (C) 2025 Midnight Foundation
# // SPDX-License-Identifier: Apache-2.0
# // Licensed under the Apache License, Version 2.0 (the "License");
# // ...
# // limitations under the License.

# Remove first 15 lines (license header) from each .compact file
cd ai-docs/compact-ai-doc
for f in examples/*.compact standard-library.compact; do
  tail -n +16 "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done
```

## Recommended AI Context Bundle

For AI-assisted Compact development, include in this order:

1. `COMPACT_LANGUAGE_REFERENCE.md` (~538 lines, ~4k tokens) — Core syntax and semantics
2. `standard-library.compact` (~340 lines, ~2.5k tokens) — Stdlib source
3. `exports.md` (~597 lines, ~4.5k tokens) — Stdlib API details
4. `ledger-adt.mdx` (~718 lines, ~5k tokens) — ADT operations
5. 2-3 relevant examples (~500-1500 lines) — Patterns for the task

**Total: ~3,985 lines across all files** — fits comfortably in most AI context windows.

## Maintenance

When Compact language changes:
1. Check `compact/doc/lang-ref.mdx` for updates
2. Update `COMPACT_LANGUAGE_REFERENCE.md` with new features
3. Re-copy `standard-library.compact` if stdlib changes
4. Add new example contracts if patterns change
5. Re-run the cleanup steps (remove license headers)

## Version History

| Date | Compact Version | Notes |
|------|-----------------|-------|
| 2025-01 | Based on `compact/` | Initial creation, 8 examples selected |

## Notes

- **Files NOT included** (too large/redundant for AI context):
  - `proposal.compact` — Uses outdated syntax (`type Ledger = {...}`)
  - Full `lang-ref.mdx` — Too verbose (~15k tokens)
  
- **Potential additions** for future versions:
  - Cross-contract call examples from `compact/examples/composable/`
  - Token minting examples from `compact/examples/std_lib/mint.compact`

