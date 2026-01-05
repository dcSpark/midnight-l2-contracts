/**
 * Incremental Merkle Tree Tests
 *
 * Verifies the IncrementalMerkleTree class matches the expected behavior
 * of L2MessageQueue.compact's appendMessage circuit.
 *
 * Key properties tested:
 * 1. Empty tree has correct zero hash root
 * 2. Single leaf produces correct root
 * 3. Multiple leaves produce same root as batch computation
 * 4. Power-of-two boundary handling (2, 4, 8 leaves)
 * 5. Non-power-of-two leaf counts
 */

import { describe, it, expect } from "vitest";
import {
  IncrementalMerkleTree,
  computeMerkleRoot,
  computeMerkleNodeHash,
  precomputeZeroHashes,
  padBytes32,
  zeroBytes32,
  bytesToHex
} from "../protocol-types";

describe("IncrementalMerkleTree", () => {
  describe("Initialization", () => {
    it("should create empty tree with zero hash root", () => {
      const tree = new IncrementalMerkleTree(4);
      const zeroHashes = precomputeZeroHashes(4);

      // Empty tree root should be zeroHash[depth-1]
      // (a complete tree of depth D with all zero leaves has root = zeroHashes[D-1])
      expect(bytesToHex(tree.getRoot())).toBe(bytesToHex(zeroHashes[3]));
      expect(tree.getLeafCount()).toBe(0);

      // Also verify it matches batch computation
      const batchRoot = computeMerkleRoot([], 4);
      expect(bytesToHex(tree.getRoot())).toBe(bytesToHex(batchRoot));
    });

    it("should reject invalid depths", () => {
      expect(() => new IncrementalMerkleTree(0)).toThrow();
      expect(() => new IncrementalMerkleTree(41)).toThrow();
    });
  });

  describe("Single Leaf", () => {
    it("should produce correct root for single leaf", () => {
      const tree = new IncrementalMerkleTree(3); // depth 3 = 8 leaves max
      const leaf = padBytes32("leaf0");

      const index = tree.append(leaf);
      expect(index).toBe(0);
      expect(tree.getLeafCount()).toBe(1);

      // Verify against batch computation
      const expectedRoot = computeMerkleRoot([leaf], 3);
      expect(bytesToHex(tree.getRoot())).toBe(bytesToHex(expectedRoot));
    });

    it("should produce same root as manual computation", () => {
      const tree = new IncrementalMerkleTree(2); // depth 2 = 4 leaves max
      const leaf = padBytes32("test");

      tree.append(leaf);

      // Manual computation matching the batch algorithm:
      // Level 0: empty sibling is 0x00...00 (empty leaf)
      // Level 1: empty sibling is H(0, 0) = zeroHashes[0]
      const zeroHashes = precomputeZeroHashes(2);
      const level1 = computeMerkleNodeHash(leaf, zeroBytes32()); // level 0 uses empty leaf
      const root = computeMerkleNodeHash(level1, zeroHashes[0]); // level 1 uses zeroHashes[0]

      expect(bytesToHex(tree.getRoot())).toBe(bytesToHex(root));
    });
  });

  describe("Multiple Leaves", () => {
    it("should match batch computation for 2 leaves", () => {
      const tree = new IncrementalMerkleTree(3);
      const leaves = [padBytes32("leaf0"), padBytes32("leaf1")];

      tree.append(leaves[0]);
      tree.append(leaves[1]);

      const expectedRoot = computeMerkleRoot(leaves, 3);
      expect(bytesToHex(tree.getRoot())).toBe(bytesToHex(expectedRoot));
    });

    it("should match batch computation for 3 leaves", () => {
      const tree = new IncrementalMerkleTree(3);
      const leaves = [
        padBytes32("leaf0"),
        padBytes32("leaf1"),
        padBytes32("leaf2")
      ];

      for (const leaf of leaves) {
        tree.append(leaf);
      }

      const expectedRoot = computeMerkleRoot(leaves, 3);
      expect(bytesToHex(tree.getRoot())).toBe(bytesToHex(expectedRoot));
    });

    it("should match batch computation for 4 leaves (power of 2)", () => {
      const tree = new IncrementalMerkleTree(3);
      const leaves = [
        padBytes32("leaf0"),
        padBytes32("leaf1"),
        padBytes32("leaf2"),
        padBytes32("leaf3")
      ];

      for (const leaf of leaves) {
        tree.append(leaf);
      }

      const expectedRoot = computeMerkleRoot(leaves, 3);
      expect(bytesToHex(tree.getRoot())).toBe(bytesToHex(expectedRoot));
    });

    it("should match batch computation for 7 leaves", () => {
      const tree = new IncrementalMerkleTree(3);
      const leaves = Array.from({ length: 7 }, (_, i) =>
        padBytes32(`leaf${i}`)
      );

      for (const leaf of leaves) {
        tree.append(leaf);
      }

      const expectedRoot = computeMerkleRoot(leaves, 3);
      expect(bytesToHex(tree.getRoot())).toBe(bytesToHex(expectedRoot));
    });

    it("should match batch computation for 8 leaves (full tree)", () => {
      const tree = new IncrementalMerkleTree(3);
      const leaves = Array.from({ length: 8 }, (_, i) =>
        padBytes32(`leaf${i}`)
      );

      for (const leaf of leaves) {
        tree.append(leaf);
      }

      const expectedRoot = computeMerkleRoot(leaves, 3);
      expect(bytesToHex(tree.getRoot())).toBe(bytesToHex(expectedRoot));
    });
  });

  describe("Larger Trees", () => {
    it("should handle depth 8 tree with 100 leaves", () => {
      const tree = new IncrementalMerkleTree(8); // 256 leaves max
      const leaves = Array.from({ length: 100 }, (_, i) =>
        padBytes32(`leaf${i}`)
      );

      for (const leaf of leaves) {
        tree.append(leaf);
      }

      const expectedRoot = computeMerkleRoot(leaves, 8);
      expect(bytesToHex(tree.getRoot())).toBe(bytesToHex(expectedRoot));
    });

    it("should handle depth 16 tree with 1000 leaves", () => {
      const tree = new IncrementalMerkleTree(16); // 65536 leaves max
      const leaves = Array.from({ length: 1000 }, (_, i) =>
        padBytes32(`l${i}`)
      );

      for (const leaf of leaves) {
        tree.append(leaf);
      }

      const expectedRoot = computeMerkleRoot(leaves, 16);
      expect(bytesToHex(tree.getRoot())).toBe(bytesToHex(expectedRoot));
    });
  });

  describe("Edge Cases", () => {
    it("should reject non-32-byte leaves", () => {
      const tree = new IncrementalMerkleTree(3);
      const badLeaf = new Uint8Array(16);

      expect(() => tree.append(badLeaf)).toThrow("32 bytes");
    });

    it("should reject when tree is full", () => {
      const tree = new IncrementalMerkleTree(2); // 4 leaves max
      const leaf = padBytes32("test");

      tree.append(leaf);
      tree.append(leaf);
      tree.append(leaf);
      tree.append(leaf);

      expect(() => tree.append(leaf)).toThrow("full");
    });

    it("should return correct indices", () => {
      const tree = new IncrementalMerkleTree(3);

      expect(tree.append(padBytes32("a"))).toBe(0);
      expect(tree.append(padBytes32("b"))).toBe(1);
      expect(tree.append(padBytes32("c"))).toBe(2);
      expect(tree.append(padBytes32("d"))).toBe(3);
    });
  });

  describe("Static Factory", () => {
    it("should create tree from leaves array", () => {
      const leaves = [
        padBytes32("leaf0"),
        padBytes32("leaf1"),
        padBytes32("leaf2")
      ];

      const tree = IncrementalMerkleTree.fromLeaves(leaves, 3);
      const expectedRoot = computeMerkleRoot(leaves, 3);

      expect(tree.getLeafCount()).toBe(3);
      expect(bytesToHex(tree.getRoot())).toBe(bytesToHex(expectedRoot));
    });
  });

  describe("Golden Vectors", () => {
    // These values are computed once and hardcoded for regression testing
    // Empty tree root = zeroHashes[depth-1]
    const GOLDEN = {
      // Empty tree depth 4: zeroHashes[3]
      emptyDepth4: "536d98837f2dd165a55d5eeae91485954472d56f246df256bf3cae19352a123c"
    };

    it("should produce correct empty tree root for depth 4", () => {
      const tree = new IncrementalMerkleTree(4);
      const zeroHashes = precomputeZeroHashes(4);

      // zeroHashes[3] is the empty tree root for depth 4
      expect(bytesToHex(tree.getRoot())).toBe(bytesToHex(zeroHashes[3]));
      expect(bytesToHex(zeroHashes[3])).toBe(GOLDEN.emptyDepth4);
    });
  });

  describe("Branch Caching", () => {
    it("should maintain correct branch state", () => {
      const tree = new IncrementalMerkleTree(3);

      // After first leaf, branch[0] should contain the leaf
      const leaf0 = padBytes32("leaf0");
      tree.append(leaf0);

      const branches = tree.getBranches();
      expect(bytesToHex(branches[0])).toBe(bytesToHex(leaf0));
    });

    it("should update branches correctly as tree grows", () => {
      const tree = new IncrementalMerkleTree(3);
      const zeroHashes = precomputeZeroHashes(3);

      // Leaf 0: branch[0] = leaf0
      const leaf0 = padBytes32("leaf0");
      tree.append(leaf0);
      let branches = tree.getBranches();
      expect(bytesToHex(branches[0])).toBe(bytesToHex(leaf0));

      // Leaf 1: branch[1] = H(leaf0, leaf1)
      const leaf1 = padBytes32("leaf1");
      tree.append(leaf1);
      branches = tree.getBranches();
      const h01 = computeMerkleNodeHash(leaf0, leaf1);
      expect(bytesToHex(branches[1])).toBe(bytesToHex(h01));

      // Leaf 2: branch[0] = leaf2
      const leaf2 = padBytes32("leaf2");
      tree.append(leaf2);
      branches = tree.getBranches();
      expect(bytesToHex(branches[0])).toBe(bytesToHex(leaf2));

      // Leaf 3: branch[2] = H(H(leaf0,leaf1), H(leaf2,leaf3))
      const leaf3 = padBytes32("leaf3");
      tree.append(leaf3);
      branches = tree.getBranches();
      const h23 = computeMerkleNodeHash(leaf2, leaf3);
      const h0123 = computeMerkleNodeHash(h01, h23);
      expect(bytesToHex(branches[2])).toBe(bytesToHex(h0123));
    });
  });
});

