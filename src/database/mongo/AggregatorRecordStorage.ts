import { AggregatorRecord } from '../../records/AggregatorRecord.js';
import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator';
import { RequestId } from '@unicitylabs/commons/src/api/RequestId';
import { TransactionRecordWithProof } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionRecordWithProof';
import { IAggregatorRecordStorage } from '../../records/IAggregatorRecordStorage.js';
import { AggregatorRecordModel } from './models.js';
import { UpdateNonFungibleTokenAttributes } from '@alphabill/alphabill-js-sdk/lib/tokens/attributes/UpdateNonFungibleTokenAttributes.js';
import { TypeDataUpdateProofsAuthProof } from '@alphabill/alphabill-js-sdk/lib/transaction/proofs/TypeDataUpdateProofsAuthProof.js';

export class AggregatorRecordStorage implements IAggregatorRecordStorage {
    async put(requestId: RequestId, record: AggregatorRecord): Promise<boolean> {
        await new AggregatorRecordModel({
            requestId: requestId.encode(),
            rootHash: record.rootHash,
            previousBlockData: record.previousBlockData || new Uint8Array(),
            authenticator: {
                hashAlgorithm: record.authenticator.hashAlgorithm,
                publicKey: record.authenticator.publicKey,
                algorithm: record.authenticator.algorithm,
                signature: record.authenticator.signature,
                state: record.authenticator.state
            },
            txProof: record.txProof.encode()
        }).save();
        return true;
    }

    async get(requestId: RequestId): Promise<AggregatorRecord | null> {
        const stored = await AggregatorRecordModel.findOne({ requestId: requestId.encode() });

            if (!stored) {
                return null;
            }

            const decodedProof = TransactionRecordWithProof.fromCbor(
                stored.txProof,
                {
                    fromCbor: (bytes: Uint8Array) => UpdateNonFungibleTokenAttributes.fromCbor(bytes)
                },
                {
                    fromCbor: (bytes: Uint8Array) => TypeDataUpdateProofsAuthProof.fromCbor(bytes)
                }
            );

            const authenticator = new Authenticator(
                stored.authenticator.hashAlgorithm,
                stored.authenticator.publicKey,
                stored.authenticator.algorithm,
                stored.authenticator.signature,
                stored.authenticator.state
            );

            return new AggregatorRecord(
                stored.rootHash,
                stored.previousBlockData || null,
                authenticator,
                decodedProof
            );
    }
}
