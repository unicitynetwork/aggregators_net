import { SmtNode } from './SmtNode.js';

export interface ISmtStorage {
  put(leaf: SmtNode): Promise<boolean>;
  putBatch(leaves: SmtNode[]): Promise<boolean>;
  getAll(): Promise<SmtNode[]>;
}
