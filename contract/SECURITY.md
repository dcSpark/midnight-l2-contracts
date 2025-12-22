# Security Architecture & Guidelines

This document outlines the cryptographic primitives, security assumptions, and implementation guidelines for the Schnorr signature scheme used in the Midnight L2 Contract.

## 1. Cryptographic Primitives

The system operates using a dual-curve architecture standard for ZK-SNARKs on Midnight:

### Host System: BLS12-381
- **Role**: The Zero-Knowledge Proof "Engine".
- **Scalar Field Size**: `52435875175126190479447740508185965837690552500527637822603658699938581184513` (Base Field for the embedded curve).
- **Usage**: Verifies the circuit execution and proofs. All native field elements (including `transientHash` outputs) live in this field.

### Embedded Curve: Jubjub
- **Role**: Application-level cryptography (keys, signatures).
- **Type**: Twisted Edwards Curve.
- **Scalar Field Size**: `6554484396890773809930967563523245729705921265872317281365359162392183254199` (Order `q`).
- **Usage**: Performs efficient elliptic curve operations inside the ZK circuit. Signature scalars ($s, k$) and private keys ($sk$) live in this field.

### Field Mismatch Note
The **BLS12-381 scalar field** (where hash outputs live) is significantly **larger** (approx. $8 \times$) than the **Jubjub scalar field** (where signature scalars live). This mismatch creates the requirement for the "Grinding" strategy described below.

---

## 2. Signature Scheme: Schnorr on Jubjub

We utilize a standard Schnorr signature scheme:
- **Private Key ($sk$)**: Scalar $\in \mathbb{F}_q$.
- **Public Key ($P$)**: $P = sk \cdot G$.
- **Signature**: $(R, s)$ where $R = k \cdot G$ and $s = k + e \cdot sk$.
- **Verification**: $s \cdot G = R + e \cdot P$.

### Security Properties
- **Security Level**: ~128-bit security against classical attacks.
- **Completeness**: Uses Twisted Edwards formulas, avoiding edge cases (like point-at-infinity) common in Weierstrass curves.

---

## 3. Critical Security Constraints

Implementers and auditors must strictly adhere to the following constraints to maintain security:

### A. Nonce ($k$) Uniqueness
**Requirement**: The nonce $k$ used during signing MUST be unique for every message signed with the same private key.
**Risk**: Reusing a nonce allows an attacker to trivially compute the private key ($sk$).
**Recommendation**: Use **Deterministic Nonce Derivation** (RFC 6979 style):
$$k = Hash(sk || message)$$
This eliminates reliance on potentially biased or failing Random Number Generators (RNGs).

### B. Field Mismatch & Grinding
**Requirement**: The challenge hash $e$ MUST fit uniformly within the Jubjub Scalar Field ($q$).
**Issue**: The native hash output (`transientHash`) returns a value in the larger BLS12-381 Base Field. Taking `hash % q` introduces bias.
**Solution**: Use a **Grinding Strategy**:
1. Compute $e = Hash(R, P, message, \text{counter})$.
2. If $e \ge q$, increment counter and retry.
3. Use only $e < q$.

### C. Domain Separation
**Requirement**: Hash inputs MUST include a unique domain separator.
**Risk**: Replay attacks where a signature intended for one context is valid in another.
**Implementation**:
$$e = Hash(\text{"Midnight-L2-Sig-v1"}, R, P, message)$$

### D. Subgroup Checks (Cofactor)
**Requirement**: Validate that Public Keys and Commitments ($R$) are valid points on the prime-order subgroup.
**Risk**: Small subgroup attacks can leak information about the private key.
**Implementation**: Ensure libraries or circuits verify points are on the curve and cleared of the cofactor (8).

---

## 4. Implementation Notes

- **Generator ($G$)**: The Midnight Compact runtime uses a specific generator point `ecMulGenerator(1)` which differs from standard Jubjub generators found in libraries like `@noble/curves`. External tooling must be configured with the correct generator coordinates.
- **Verification Circuit**: The `verifySignature` circuit in `L2Simulation.compact` performs the check $s \cdot G = R + e \cdot P$. It relies on the inputs being properly bounded and formatted by the client/simulator.

