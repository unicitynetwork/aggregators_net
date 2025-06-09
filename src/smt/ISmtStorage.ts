import { SmtNode } from './SmtNode.js';

export interface ISmtStorage {
  put(node: SmtNode): Promise<boolean>;

  /**
   * Stores multiple SMT nodes in a single atomic transaction.
   *
   * @param nodes The SMT nodes to store
   * @returns Promise resolving to true if operation succeeds
   */
  putBatch(nodes: SmtNode[]): Promise<boolean>;

  getAll(): Promise<SmtNode[]>;

  /**
   * Gets SMT nodes in chunks
   * 
   * @param chunkSize The maximum number of nodes to return per chunk
   * @param callback Function called for each chunk of nodes
   * @returns Promise that resolves when all chunks have been processed
   */
  getAllInChunks(chunkSize: number, callback: (chunk: SmtNode[]) => Promise<void>): Promise<void>;
}
