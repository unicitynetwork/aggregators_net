import mongoose, { model } from 'mongoose';

import { ISmtStorage } from './ISmtStorage.js';
import { SmtNode } from './SmtNode.js';
import logger from '../logger.js';
import { SCHEMA_TYPES } from '../StorageSchemaTypes.js';

interface ISmtNode {
  path: bigint;
  value: Uint8Array;
}

const LeafSchema = new mongoose.Schema({
  path: { required: true, type: SCHEMA_TYPES.BIGINT_BINARY, unique: true },
  value: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
});

export const LeafModel = model<ISmtNode>('Leaf', LeafSchema);

export class SmtStorage implements ISmtStorage {
  public async getAll(): Promise<SmtNode[]> {
    const stored = await LeafModel.find({});
    return stored.map((doc) => new SmtNode(BigInt(doc.path.toString()), new Uint8Array(doc.value)));
  }

  public async put(leaf: SmtNode): Promise<boolean> {
    await new LeafModel({
      path: leaf.path,
      value: leaf.value,
    }).save();
    return true;
  }

  /**
   * Stores multiple SMT nodes in a single atomic transaction.
   *
   * @param leaves The SMT nodes to store
   * @returns Promise resolving to true if operation succeeds
   */
  public async putBatch(leaves: SmtNode[]): Promise<boolean> {
    if (leaves.length === 0) {
      return true;
    }

    const session = await mongoose.startSession();

    try {
      session.startTransaction();

      // Use bulkWrite with updateOne operations that only insert new nodes
      const operations = leaves.map((node) => ({
        updateOne: {
          filter: { path: node.path },
          update: { $setOnInsert: { path: node.path, value: node.value } },
          upsert: true,
        },
      }));

      await LeafModel.bulkWrite(operations, { session });

      await session.commitTransaction();
      logger.debug(`Successfully committed transaction for ${leaves.length} SMT nodes`);
      return true;
    } catch (error) {
      logger.error('Error in SmtStorage putBatch:', error);
      await session.abortTransaction();
      throw error;
    } finally {
      await session.endSession();
    }
  }
}
