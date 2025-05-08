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
}
