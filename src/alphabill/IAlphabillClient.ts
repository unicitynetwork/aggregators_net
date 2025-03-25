import { SubmitHashResponse } from './SubmitHashResponse.js';

export interface IAlphabillClient {
  submitHash(rootHash: Uint8Array): Promise<SubmitHashResponse>;
  initialSetup(): Promise<void>;
} 