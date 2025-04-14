import { Commitment } from './Commitment.js';

export interface ICommitmentStorage {
  put(commitment: Commitment): Promise<boolean>;
  
  /**
   * Gets commitments to process for the current block.
   * If cursor status is COMPLETE, gets new commitments after last processed ID.
   * If cursor status is IN_PROGRESS, retries the previous batch.
   * 
   * @returns Array of commitments that need to be processed
   */
  getCommitmentsForBlock(): Promise<Commitment[]>;
  
  /**
   * Confirms that the current batch of commitments has been successfully processed.
   * Uses the currentBatchEndId already stored in the cursor document
   */
  confirmBlockProcessed(): Promise<boolean>;
}
