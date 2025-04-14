import mongoose, { model } from 'mongoose';

import { ISmtStorage } from './ISmtStorage.js';
import { SmtNode } from './SmtNode.js';
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

  public async putBatch(leaves: SmtNode[]): Promise<boolean> {
    if (leaves.length === 0) {
      return true;
    }

    try {
      // Use bulkWrite with updateOne operations that upsert
      const operations = leaves.map((leaf) => ({
        updateOne: {
          filter: { path: leaf.path },
          update: { $set: { path: leaf.path, value: leaf.value } },
          upsert: true
        }
      }));

      await LeafModel.bulkWrite(operations);
      return true;
    } catch (error) {
      // Log and rethrow the error
      console.error('Error in SmtStorage putBatch:', error);
      throw error;
    }
  }
}
