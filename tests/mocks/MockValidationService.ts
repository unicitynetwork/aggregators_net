import { SubmitCommitmentStatus } from '@unicitylabs/commons/lib/api/SubmitCommitmentResponse.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { Commitment } from '../../src/commitment/Commitment.js';
import { IValidationService, ValidationResult } from '../../src/ValidationService.js';
import { AggregatorRecordStorage } from '../../src/records/AggregatorRecordStorage.js';

export class MockValidationService implements IValidationService {
  private initialized: boolean = false;
  private recordStorage: AggregatorRecordStorage;

  constructor(private readonly threads: number = 4) {
    this.recordStorage = new AggregatorRecordStorage();
  }

  public async initialize(mongoUri: string): Promise<void> {
    this.initialized = true;
  }

  public async validateCommitment(commitment: Commitment): Promise<ValidationResult> {
    if (!this.initialized) {
      throw new Error('MockValidationService not initialized. Call initialize() first.');
    }

    const expectedRequestId = await RequestId.create(commitment.authenticator.publicKey, commitment.authenticator.stateHash);
    if (!expectedRequestId.hash.equals(commitment.requestId.hash)) {
      return {
        status: SubmitCommitmentStatus.REQUEST_ID_MISMATCH,
        exists: false,
      };
    }

    const existingRecord = await this.recordStorage.get(commitment.requestId);
    
    if (existingRecord) {
      if (existingRecord.transactionHash.equals(commitment.transactionHash)) {
        return {
          status: SubmitCommitmentStatus.SUCCESS,
          exists: true,
        };
      } else {
        return {
          status: SubmitCommitmentStatus.REQUEST_ID_EXISTS,
          exists: true,
        };
      }
    }

    return {
      status: SubmitCommitmentStatus.SUCCESS,
      exists: false,
    };
  }

  public async terminate(): Promise<void> {
    if (this.initialized) {
      this.initialized = false;
    }
  }
} 