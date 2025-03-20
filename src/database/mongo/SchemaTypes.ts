import mongoose, { SchemaType, SchemaTypeOptions } from "mongoose";
import { Binary } from "mongodb";
import { BigintConverter } from "@unicitylabs/commons/lib/util/BigintConverter";

export const SCHEMA_TYPES = {
    BIGINT_BINARY: "BigIntBinary",
    UINT8_ARRAY: "Uint8Array"
} as const;

class BigIntBinarySchemaType extends SchemaType {
    static schemaName = SCHEMA_TYPES.BIGINT_BINARY;

    constructor(key: string, options?: SchemaTypeOptions<any>) {
        super(key, options, SCHEMA_TYPES.BIGINT_BINARY);
    }

    cast(val: any) {
        if (typeof val === "bigint") {
            const uint8Array = BigintConverter.encode(val);
            return new Binary(Buffer.from(uint8Array));
        }
        if (val instanceof Binary) {
            const uint8Array = new Uint8Array(val.buffer);
            return BigintConverter.decode(uint8Array);
        }
        throw new Error(`BigIntBinarySchemaType: Cannot cast ${val}`);
    }
}

class Uint8ArraySchemaType extends SchemaType {
    static schemaName = SCHEMA_TYPES.UINT8_ARRAY;

    constructor(key: string, options?: SchemaTypeOptions<any>) {
      super(key, options, SCHEMA_TYPES.UINT8_ARRAY);
    }

    cast(val: any) {
      if (val instanceof Uint8Array) return new Binary(Buffer.from(val));
      if (val instanceof Binary) return new Uint8Array(val.buffer);
      throw new Error(`Uint8ArraySchemaType: Cannot cast ${val}`);
    }
}

(mongoose.Schema.Types as any)[SCHEMA_TYPES.BIGINT_BINARY] = BigIntBinarySchemaType;
(mongoose.Schema.Types as any)[SCHEMA_TYPES.UINT8_ARRAY] = Uint8ArraySchemaType;