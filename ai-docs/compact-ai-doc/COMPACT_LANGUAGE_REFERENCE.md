# Compact Language Reference

Compact is a strongly statically typed, bounded smart contract language for zero-knowledge circuits.

## Contract Structure

Each Compact contract can have:
- **Type declarations** — structs, enums
- **Ledger declarations** — public state stored on-chain
- **Witness declarations** — private functions implemented in TypeScript
- **Circuit definitions** — compiled to zero-knowledge proofs

```compact
import CompactStandardLibrary;

// Type declarations
struct MyStruct { field1: Field, field2: Boolean }
enum MyEnum { optionA, optionB }

// Ledger (public state)
ledger counter: Counter;
ledger data: Map<Field, MyStruct>;

// Witness (private computation)
witness getSecret(x: Field): Field;

// Circuit (exported entry point)
export circuit myCircuit(arg: Field): Field {
  return arg + 1;
}

// Constructor (optional, runs once at deploy)
constructor(initialValue: Field) {
  counter += initialValue as Uint<64>;
}
```

---

## Types

### Primitive Types

| Type | Description | Default Value |
|------|-------------|---------------|
| `Boolean` | `true` or `false` | `false` |
| `Field` | Scalar field element (bigint in TS) | `0` |
| `Uint<n>` | Unsigned int with `n` bits (0 to 2^n-1) | `0` |
| `Uint<0..n>` | Unsigned int bounded 0 to n | `0` |
| `Bytes<n>` | Fixed-length byte array | all zeros |
| `Opaque<"string">` | TS string, opaque to circuits | `""` |
| `Opaque<"Uint8Array">` | TS Uint8Array, opaque to circuits | `Uint8Array(0)` |

### Tuple and Vector Types

```compact
[Field, Boolean, Uint<8>]   // Tuple of 3 different types
Vector<5, Field>            // Same as [Field, Field, Field, Field, Field]
```

### User-Defined Types

**Struct:**
```compact
struct Point { x: Field, y: Field }
struct Container<T> { item: T, count: Uint<32> }

// Creation
const p = Point { x: 1, y: 2 };
const c = Container<Field> { item: 42, count: 1 };

// Spread syntax
const p2 = Point { ...p, x: 10 };  // p2 = {x: 10, y: 2}
```

**Enum:**
```compact
enum Color { red, green, blue }
const c = Color.red;
```

---

## Subtyping

- `Uint<0..n>` is subtype of `Uint<0..m>` if n < m
- `Uint<0..n>` is subtype of `Field` for all n
- Tuple `[T, ...]` is subtype of `[S, ...]` if each T is subtype of corresponding S

---

## Type Casts

| From → To | Notes |
|-----------|-------|
| `Uint<0..m>` → `Uint<0..n>` | Static if m ≤ n, checked if m > n |
| `Uint` → `Field` | Static (always succeeds) |
| `Field` → `Uint<0..n>` | Checked (runtime error if too large) |
| `Field` → `Boolean` | 0 → false, non-zero → true |
| `Boolean` → `Field` | false → 0, true → 1 |
| `Boolean` → `Uint<0..n>` | false → 0, true → 1 (n must be ≥ 1) |
| `Field` → `Bytes<n>` | Little-endian, runtime error if doesn't fit |
| `Bytes<n>` → `Field` | Little-endian, runtime error if too large |
| `enum` → `Field` | Convert enum to its index |

```compact
const f: Field = 42;
const u = f as Uint<64>;        // Checked cast
const b = f as Boolean;         // 0 → false, else true
const small = u as Uint<8>;     // Checked (fails if u > 255)
```

---

## Circuits

```compact
// Non-generic circuit
circuit add(a: Field, b: Field): Field {
  return a + b;
}

// Generic circuit (cannot be exported)
circuit identity<T>(x: T): T {
  return x;
}

// Exported circuit (entry point)
export circuit increment(amount: Uint<64>): Uint<64> {
  counter += amount;
  return counter;
}

// Pure circuit (no side effects)
export pure circuit double(x: Field): Field {
  return x * 2;
}
```

### Anonymous Circuits

```compact
const result = ((x, y) => x + y)(3, 4);  // result = 7

// With type annotations
const typed = ((x: Field, y: Field): Field => x * y)(2, 3);
```

---

## Witnesses

Witnesses are private functions implemented in TypeScript:

```compact
witness getPrivateKey(addr: Field): Field;
witness lookupBalance(account: Bytes<32>): Uint<64>;

export circuit transfer(to: Field, amount: Uint<64>): [] {
  const key = getPrivateKey(kernel.self() as Field);
  // ... use key privately
}
```

> ⚠️ **Warning:** Never trust witness results. Any DApp can provide any implementation. Validate witness outputs in your circuit.

---

## Ledger (Public State)

### Declaration

```compact
ledger value: Field;                           // Cell<Field>
ledger counter: Counter;                       // Counter ADT
ledger items: Set<Field>;                      // Set ADT
ledger mapping: Map<Field, Uint<64>>;          // Map ADT
ledger tree: MerkleTree<20, Field>;            // MerkleTree ADT
ledger history: HistoricMerkleTree<20, Field>; // HistoricMerkleTree ADT
ledger pending: List<Field>;                   // List ADT

export ledger publicVal: Field;                // Readable externally
sealed ledger config: Field;                   // Only writable in constructor
```

### Common Operations

```compact
// Cell (any Compact type becomes Cell<T>)
ledger x: Field;
x = 42;              // x.write(42)
const v = x;         // x.read()
x.reset_to_default();

// Counter
ledger cnt: Counter;
cnt += 10;           // cnt.increment(10)
cnt -= 5;            // cnt.decrement(5)
const c = cnt;       // cnt.read()

// Map
ledger m: Map<Field, Uint<64>>;
m.insert(key, value);
const val = m.lookup(key);
const exists = m.member(key);

// Set
ledger s: Set<Field>;
s.insert(item);
const has = s.member(item);

// MerkleTree
ledger tree: MerkleTree<20, Field>;
const root = tree.root();
const leaf = tree.lookup(index);
tree.update(index, newValue);

// List
ledger items: List<Field>;
items.push(42);
const first = items.at(0);
```

### Nested Maps

```compact
ledger nested: Map<Boolean, Map<Field, Counter>>;

export circuit init(key1: Boolean, key2: Field): [] {
  nested.insert(key1, default<Map<Field, Counter>>);
  nested.lookup(key1).insert(key2, default<Counter>);
  nested.lookup(key1).lookup(key2).increment(10);
}
```

---

## Modules

```compact
// Define a module
module Math {
  export circuit add(a: Field, b: Field): Field {
    return a + b;
  }
  
  circuit helper(x: Field): Field {  // Not exported, private to module
    return x * 2;
  }
}

// Import module
import Math;                    // add is now in scope
import Math prefix M_;          // M_add is now in scope

// Generic module
module Container<T> {
  export struct Box { value: T }
}
import Container<Field>;        // Box is now Box with Field value
```

### Standard Library Import

```compact
import CompactStandardLibrary;

// Now available: kernel, transientHash, persistentHash,
// Maybe, Either, CurvePoint, and all ledger ADTs
```

---

## Statements

### const Binding

```compact
const x = 42;
const y: Field = 100;
const a = 1, b = 2, c = 3;    // Multiple bindings

// Destructuring
const [first, second] = [1, 2];
const { x, y } = Point { x: 1, y: 2 };
const [a, , b] = [1, 2, 3];   // Skip middle element
```

### Control Flow

```compact
// if statement
if (condition) {
  // statements
}

if (condition) {
  // true branch
} else {
  // false branch
}

// for loop (fixed iterations only)
for (const i of 0..10) {
  // i goes from 0 to 9
}

for (const item of vector) {
  // iterate over vector elements
}

// return
return value;
return;  // For return type []
```

---

## Expressions

### Arithmetic

```compact
a + b    // Addition
a - b    // Subtraction (runtime error if negative for Uint)
a * b    // Multiplication
```

**Result Types:**
- If either operand is `Field`, result is `Field`
- `Uint<0..m> + Uint<0..n>` → `Uint<0..m+n>`
- `Uint<0..m> - Uint<0..n>` → `Uint<0..m>`
- `Uint<0..m> * Uint<0..n>` → `Uint<0..m*n>`

### Comparison

```compact
a == b   // Equals (works on all types)
a != b   // Not equals
a < b    // Less than (Uint only)
a > b    // Greater than (Uint only)
a <= b   // Less or equal (Uint only)
a >= b   // Greater or equal (Uint only)
```

### Logical

```compact
!a       // Boolean negation
a && b   // Short-circuit AND
a || b   // Short-circuit OR
```

### Conditional

```compact
condition ? trueValue : falseValue
```

### Assertions

```compact
assert(condition, "Error message");
```

### Default Values

```compact
default<Field>           // 0
default<Boolean>         // false
default<Point>           // Point with default fields
default<Counter>         // Empty counter
default<Map<K, V>>       // Empty map
```

---

## Map and Fold

```compact
// Map: apply function to each element
const doubled = map((x) => x * 2, [1, 2, 3]);  // [2, 4, 6]

// Fold: reduce vector to single value
const sum = fold((acc, x) => acc + x, 0, [1, 2, 3]);  // 6

// Multi-vector map
const products = map((a, b) => a * b, [1, 2], [3, 4]);  // [3, 8]
```

---

## Disclosure

When witness values affect public state, use `disclose`:

```compact
witness getAmount(): Field;

export circuit deposit(): [] {
  const amount = getAmount();
  ledger.balance += disclose(amount) as Uint<64>;  // Required!
}
```

> The `disclose` function makes the value verifiable in the ZK proof.

---

## Constructor

```compact
constructor(initialBalance: Uint<64>, adminKey: Field) {
  balance = initialBalance;
  admin = adminKey;
  initializeModule();  // Can call helper circuits
}
```

- At most one constructor per contract
- Return type is always `[]`
- Only place where `sealed` ledger fields can be modified

---

## TypeScript Representations

| Compact Type | TypeScript Type |
|--------------|-----------------|
| `Boolean` | `boolean` |
| `Field` | `bigint` |
| `Uint<n>` | `bigint` |
| `Bytes<n>` | `Uint8Array` |
| `Opaque<"string">` | `string` |
| `[T, ...]` | `[T, ...]` or `T[]` |
| `struct S { a: A, b: B }` | `{ a: A, b: B }` |
| `enum E { x, y, z }` | `number` (0, 1, 2) |

---

## Common Patterns

### Access Control

```compact
sealed ledger admin: Field;

export circuit adminOnly(proof: Field): [] {
  assert(proof == admin, "Not admin");
  // ...
}
```

### Commit-Reveal

```compact
ledger commitments: Set<Field>;

export circuit commit(hash: Field): [] {
  commitments.insert(hash);
}

export circuit reveal(preimage: Field, nonce: Field): [] {
  const hash = persistentHash([preimage, nonce]);
  assert(commitments.member(hash), "Invalid commitment");
  // ...
}
```

### Merkle Proof Verification

```compact
ledger members: MerkleTree<20, Field>;

witness getMembershipProof(id: Field): MembershipProof<20, Field>;

export circuit verifyMembership(id: Field): Boolean {
  const proof = getMembershipProof(id);
  return persistentMerkleTreeVerifyUpdate(members.root(), proof, id);
}
```

### Token Transfers

```compact
import CompactStandardLibrary;

export circuit mint(amount: Uint<64>): [] {
  kernel.mintShielded(amount);
}

export circuit send(to: ContractAddress, amount: Uint<64>): [] {
  kernel.sendUnshielded(to, amount);
}
```

---

## Key Gotchas

1. **No division operator** — Compact has no `/` or `%`. Use witnesses for division.

2. **Fixed-size loops only** — Loop bounds must be compile-time constants.

3. **No recursion** — Circuits cannot call themselves.

4. **Witnesses are untrusted** — Always validate witness outputs.

5. **Subtraction can fail** — `Uint` subtraction fails at runtime if result would be negative.

6. **Generic circuits can't be exported** — Specialize before exporting.

7. **Disclosure required** — Witness values affecting public state need `disclose()`.

8. **Field comparison limitations** — `<`, `>`, `<=`, `>=` only work on `Uint`, not `Field`.

9. **Sealed fields** — Only writable in constructor, immutable after deployment.

10. **Ledger ADTs are not first-class** — Must use full operation chains, can't store in variables (except `default<>`).

---

## Compiler Output

The Compact compiler produces:
- `contract/index.js` — JavaScript implementation
- `contract/index.d.ts` — TypeScript type declarations
- `keys/` — ZK prover/verifier key pairs
- `zkir/` — Proof generation instructions

Key exports:
- `Contract<T>` — Main contract class
- `Witnesses<T>` — Type for witness implementations
- `Circuits<T>` — All exported circuits
- `PureCircuits` — Pure (side-effect free) circuits
- `ImpureCircuits<T>` — Circuits with side effects
- `Ledger` — Type for reading ledger state
- `ledger(state)` — Function to create Ledger view
