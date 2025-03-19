import { ISmtStorage } from '../../smt/ISmtStorage.js';
import { SmtNode } from '../../smt/SmtNode.js';
import { LeafModel } from './models.js';

export class SmtStorage implements ISmtStorage {
    async getAll(): Promise<SmtNode[]> {
        const stored = await LeafModel.find({});
        return stored.map(doc => new SmtNode(
            BigInt(doc.path.toString()),
            new Uint8Array(doc.value)
        ));
    }

    async put(leaf: SmtNode): Promise<boolean> {
        await new LeafModel({
            path: leaf.path,
            value: leaf.value
        }).save();
        return true;
    }
}