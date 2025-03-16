import { ISmtStorage } from '../../smt/ISmtStorage.js';
import { SmtNode } from '../../smt/SmtNode.js';
import { LeafModel } from './models.js';

export class SmtStorage implements ISmtStorage {
    async put(leaf: SmtNode): Promise<boolean> {
        try {
            await new LeafModel({
                path: leaf.path,
                value: leaf.value
            }).save();
            return true;
        } catch (error) {
            console.error('Failed to store SMT node:', error);
            return false;
        }
    }

    async getAll(): Promise<SmtNode[]> {
        try {
            const stored = await LeafModel.find({});
            return stored.map(doc => new SmtNode(
                BigInt(doc.path.toString()),
                new Uint8Array(doc.value)
            ));
        } catch (error) {
            console.error('Failed to retrieve SMT nodes:', error);
            return [];
        }
    }
}