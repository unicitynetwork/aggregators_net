import { Commitment } from './Commitment.js';

export interface ICommitmentStorage {
  put(commitment: Commitment): Promise<boolean>;
  getAll(): Promise<Commitment[]>;
}
