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

  /**
   * Gets SMT nodes in chunks
   *
   * @param chunkSize The maximum number of nodes to return per chunk
   * @param callback Function called for each chunk of nodes
   * @returns Promise that resolves when all chunks have been processed
   */
  public async getAllInChunks(chunkSize: number, callback: (chunk: SmtNode[]) => Promise<void>): Promise<void> {
    let processedCount = 0;
    let chunk: SmtNode[] = [];

    const cursor = LeafModel.find({}).cursor();

    for await (const doc of cursor) {
      const node = new SmtNode(BigInt(doc.path.toString()), new Uint8Array(doc.value));
      chunk.push(node);

      if (chunk.length >= chunkSize) {
        await callback(chunk);
        processedCount += chunk.length;
        logger.debug(`Processed ${processedCount} SMT nodes in chunks`);
        chunk = [];
      }
    }

    if (chunk.length > 0) {
      await callback(chunk);
      processedCount += chunk.length;
    }
  }
}
