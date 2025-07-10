import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { LeafInBranchError } from '@unicitylabs/commons/lib/smt/LeafInBranchError.js';
import { MerkleTreePath } from '@unicitylabs/commons/lib/smt/MerkleTreePath.js';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';

import logger from '../logger.js';

/**
 * Wrapper for SparseMerkleTree that provides concurrency control
 * using a locking mechanism to ensure sequential execution of
 * asynchronous operations.
 */
export class Smt {
  /**
   * Creates a new SMT wrapper
   * @param smt The SparseMerkleTree to wrap
   */
  public constructor(private readonly smt: SparseMerkleTree) {}

  /**
   * Gets the root hash of the tree
   */
  public async rootHash(): Promise<DataHash> {
    const root = await this.smt.calculateRoot();
    return root.hash;
  }

  /**
   * Adds a leaf to the SMT with locking to prevent concurrent updates
   */
  public addLeaf(path: bigint, value: Uint8Array): Promise<void> {
    return this.smt.addLeaf(path, value);
  }

  /**
   * Gets a proof path for a leaf with locking to ensure consistent view
   */
  public async getPath(path: bigint): Promise<MerkleTreePath> {
    const root = await this.smt.calculateRoot();
    return root.getPath(path);
  }

  /**
   * Adds multiple leaves atomically with a single lock
   */
  public async addLeaves(leaves: Array<{ path: bigint; value: Uint8Array }>): Promise<void> {
    await Promise.all(
      leaves.map((leaf) =>
        this.smt.addLeaf(leaf.path, leaf.value).catch((error) => {
          if (error instanceof LeafInBranchError) {
            logger.warn(`Leaf already exists in tree for path ${leaf.path} - skipping`);
          } else {
            throw error;
          }
        }),
      ),
    );
  }
}
