import { expose } from 'threads/worker';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { SubmitCommitmentStatus } from '@unicitylabs/commons/lib/api/SubmitCommitmentResponse.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { Signature } from '@unicitylabs/commons/lib/signing/Signature.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import { AggregatorRecordStorage } from '../records/AggregatorRecordStorage.js';
import mongoose from 'mongoose';
import logger from '../logger.js';

interface ValidationRequest {
  commitment: {
    requestId: string;
    transactionHash: string;
    authenticator: {
      algorithm: string;
      publicKey: string;
      signature: string;
      stateHash: string;
    };
  };
  mongoUri: string;
}

interface ValidationResult {
  status: SubmitCommitmentStatus;
  exists: boolean;
}

let isConnected = false;

const validationWorker = {
  async validateCommitment(request: ValidationRequest): Promise<ValidationResult> {
    try {
      if (!isConnected && mongoose.connection.readyState === 0) {
        await mongoose.connect(request.mongoUri);
        isConnected = true;
      }

      const requestId = RequestId.fromJSON(request.commitment.requestId);
      const transactionHash = DataHash.fromJSON(request.commitment.transactionHash);
      const publicKeyArray = HexConverter.decode(request.commitment.authenticator.publicKey);
      const signatureArray = HexConverter.decode(request.commitment.authenticator.signature);
      const signature = Signature.decode(signatureArray);
      const stateHash = DataHash.fromJSON(request.commitment.authenticator.stateHash);
      
      const authenticator = new Authenticator(
        request.commitment.authenticator.algorithm,
        publicKeyArray,
        signature,
        stateHash
      );
      
      const expectedRequestId = await RequestId.create(authenticator.publicKey, authenticator.stateHash);
      if (!expectedRequestId.hash.equals(requestId.hash)) {
        return { 
          status: SubmitCommitmentStatus.REQUEST_ID_MISMATCH, 
          exists: false,
        };
      }
      
      if (!(await authenticator.verify(transactionHash))) {
        return { 
          status: SubmitCommitmentStatus.AUTHENTICATOR_VERIFICATION_FAILED, 
          exists: false,
        };
      }
      
      const recordStorage = new AggregatorRecordStorage();
      const existingRecord = await recordStorage.get(requestId);
      
      if (existingRecord) {
        if (!existingRecord.transactionHash.equals(transactionHash)) {
          return { 
            status: SubmitCommitmentStatus.REQUEST_ID_EXISTS, 
            exists: true,
          };
        } else {
          return { 
            status: SubmitCommitmentStatus.SUCCESS, 
            exists: true,
          };
        }
      }

      return { 
        status: SubmitCommitmentStatus.SUCCESS, 
        exists: false,
      };
      
    } catch (error) {
      logger.error('Error in validation worker:', error);
      return { 
        status: SubmitCommitmentStatus.AUTHENTICATOR_VERIFICATION_FAILED, 
        exists: false,
      };
    }
  }
};

expose(validationWorker); 