import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { MerkleTreePath } from '@unicitylabs/commons/lib/smt/MerkleTreePath.js';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';

import logger from '../logger.js';

/**
 * Wrapper for SparseMerkleTree that provides concurrency control
 * using a locking mechanism to ensure sequential execution of
 * asynchronous operations.
 */
export class Smt {
  private smtUpdateLock: boolean = false;
  private waitingPromises: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  // Lock timeout in milliseconds (10 seconds)
  private readonly LOCK_TIMEOUT_MS = 10000;

  /**
   * Creates a new SMT wrapper
   * @param smt The SparseMerkleTree to wrap
   */
  public constructor(private readonly smt: SparseMerkleTree) {}

  /**
   * Gets the root hash of the tree
   */
  public async rootHash(): Promise<DataHash> {
    return await this.smt.root.hashPromise;
  }

  /**
   * Gets the underlying SparseMerkleTree
   */
  public get tree(): SparseMerkleTree {
    return this.smt;
  }

  /**
   * Adds a leaf to the SMT with locking to prevent concurrent updates
   */
  public async addLeaf(path: bigint, value: Uint8Array): Promise<void> {
    return this.withSmtLock(async () => {
      this.smt.addLeaf(path, value);
    });
  }

  /**
   * Gets a proof path for a leaf with locking to ensure consistent view
   */
  public async getPath(path: bigint): Promise<MerkleTreePath> {
    return this.withSmtLock(async () => {
      return this.smt.getPath(path);
    });
  }

  /**
   * Adds multiple leaves atomically with a single lock
   */
  public async addLeaves(leaves: Array<{ path: bigint; value: Uint8Array }>): Promise<void> {
    return this.withSmtLock(async () => {
      for (const leaf of leaves) {
        try {
          this.smt.addLeaf(leaf.path, leaf.value);
        } catch (error) {
          // Check if the error is "Cannot add leaf inside branch" which indicates
          // the leaf is already in the tree - this is not a fatal error
          if (error instanceof Error && error.message.includes('Cannot add leaf inside branch')) {
            logger.warn(`Leaf already exists in tree for path ${leaf.path} - skipping`);
          } else {
            throw error;
          }
        }
      }
    });
  }

  /**
   * Acquires a lock for SMT updates with a timeout
   * @returns A promise that resolves when the lock is acquired
   */
  private async acquireSmtLock(): Promise<void> {
    if (!this.smtUpdateLock) {
      this.smtUpdateLock = true;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      // Create a timeout that will reject the promise if the lock isn't acquired in time
      const timer = setTimeout(() => {
        // Remove this waiting promise from the queue
        const index = this.waitingPromises.findIndex((p) => p.timer === timer);
        if (index !== -1) {
          this.waitingPromises.splice(index, 1);
        }

        reject(new Error(`SMT lock acquisition timed out after ${this.LOCK_TIMEOUT_MS}ms`));
      }, this.LOCK_TIMEOUT_MS);

      this.waitingPromises.push({ resolve, reject, timer });
    });
  }

  /**
   * Releases the SMT update lock and resolves the next waiting promise
   */
  private releaseSmtLock(): void {
    if (this.waitingPromises.length > 0) {
      const next = this.waitingPromises.shift();
      // Clear the timeout since we're resolving this promise
      if (next) {
        clearTimeout(next.timer);
        next.resolve();
      }
    } else {
      this.smtUpdateLock = false;
    }
  }

  /**
   * Executes a function while holding the SMT lock
   * @param fn The function to execute with the lock held
   * @returns The result of the function
   */
  public async withSmtLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireSmtLock();
    try {
      return await fn();
    } finally {
      this.releaseSmtLock();
    }
  }
}
