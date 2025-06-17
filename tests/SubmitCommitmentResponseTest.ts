import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHasher } from '@unicitylabs/commons/lib/hash/DataHasher.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { Signature } from '@unicitylabs/commons/lib/signing/Signature.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import { SubmitCommitmentResponse, SubmitCommitmentStatus, IRequestJson } from '@unicitylabs/commons/lib/api/SubmitCommitmentResponse.js';

import { Commitment } from '../src/commitment/Commitment.js';

describe('SubmitCommitmentResponse Receipt Tests', () => {
  let signingService: SigningService;
  let commitment: Commitment;

  beforeEach(async () => {
    const privateKey = SigningService.generatePrivateKey();
    signingService = await SigningService.createFromSecret(privateKey);

    const stateHashBytes = new TextEncoder().encode('test-state-hash');
    const stateHash = await new DataHasher(HashAlgorithm.SHA256).update(stateHashBytes).digest();

    const txHashBytes = new TextEncoder().encode('test-transaction-hash');
    const transactionHash = await new DataHasher(HashAlgorithm.SHA256).update(txHashBytes).digest();

    const requestId = await RequestId.create(signingService.publicKey, stateHash);
    const authenticator = await Authenticator.create(signingService, transactionHash, stateHash);

    commitment = new Commitment(requestId, transactionHash, authenticator);
  });

  it('should add receipt with valid signature that can be verified', async () => {
    const response = new SubmitCommitmentResponse(SubmitCommitmentStatus.SUCCESS);

    // Add receipt (this should sign the request hash)
    await response.addSignedReceipt(commitment.requestId, commitment.authenticator.stateHash, commitment.transactionHash, signingService);

    // Verify the response has the expected fields
    expect(response.receipt!.algorithm).toBe(signingService.algorithm);
    expect(response.receipt!.publicKey).toBe(HexConverter.encode(signingService.publicKey));
    expect(response.receipt!.signature).toBeTruthy();
    expect(response.receipt!.request).toBeTruthy();

    // Get the signature object directly (no JSON parsing needed)
    const signatureFromResponse = response.receipt!.signature!;

    // Get the same request hash that was signed
    const requestHash = response.receipt!.request!.hash;

    // Verify the signature using the signing service (aggregator side)
    const isValidSignature = await signingService.verify(requestHash.data, signatureFromResponse);
    expect(isValidSignature).toBe(true);

    // Verify using only the public key (client side)
    const aggregatorPublicKey = HexConverter.decode(response.receipt!.publicKey);

    const isValidWithPublicKeyOnly = await SigningService.verifyWithPublicKey(
      requestHash.data,
      signatureFromResponse.bytes, // Just the signature bytes (64), not including recovery byte
      aggregatorPublicKey,
    );
    expect(isValidWithPublicKeyOnly).toBe(true);

    // Verify with different public key (should fail)
    const differentPrivateKey = SigningService.generatePrivateKey();
    const differentSigningService = await SigningService.createFromSecret(differentPrivateKey);
    const isValidWithDifferentSigningService = await SigningService.verifyWithPublicKey(
      requestHash.data,
      signatureFromResponse.bytes,
      differentSigningService.publicKey,
    );
    expect(isValidWithDifferentSigningService).toBe(false);
  });

  it('should fail verification with wrong data', async () => {
    const response = new SubmitCommitmentResponse(SubmitCommitmentStatus.SUCCESS);

    // Add receipt
    await response.addSignedReceipt(commitment.requestId, commitment.authenticator.stateHash, commitment.transactionHash, signingService);

    // Get the signature object directly (no JSON parsing needed)
    const signatureFromResponse = response.receipt!.signature!;

    // Try to verify with different data (should fail)
    const wrongData = new TextEncoder().encode('wrong-data');
    const isValidSignature = await signingService.verify(wrongData, signatureFromResponse);

    expect(isValidSignature).toBe(false);
  });

  it('should create valid JSON response with receipt', async () => {
    const response = new SubmitCommitmentResponse(SubmitCommitmentStatus.SUCCESS);
    await response.addSignedReceipt(commitment.requestId, commitment.authenticator.stateHash, commitment.transactionHash, signingService);

    const jsonResponse = response.toJSON();

    expect(jsonResponse.status).toBe(SubmitCommitmentStatus.SUCCESS);
    expect(jsonResponse.algorithm).toBe(signingService.algorithm);
    expect(jsonResponse.publicKey).toBe(HexConverter.encode(signingService.publicKey));
    expect(jsonResponse.signature).toBeTruthy();
    expect(jsonResponse.request).toBeTruthy();

    // Verify that signature is converted to JSON string for clients
    expect(typeof jsonResponse.signature).toBe('string');

    // Verify clients can reconstruct the signature from JSON
    const signatureFromJson = Signature.fromJSON(jsonResponse.signature!);
    expect(signatureFromJson.bytes).toEqual(response.receipt!.signature!.bytes);
    expect(signatureFromJson.algorithm).toBe(response.receipt!.signature!.algorithm);

    // Check the JSON structure of the request with proper typing
    const requestJson: IRequestJson = jsonResponse.request!;
    expect(requestJson.service).toBe('aggregator');
    expect(requestJson.method).toBe('submit_commitment');
    expect(requestJson.requestId).toBe(commitment.requestId.toJSON());
    expect(requestJson.transactionHash).toBe(commitment.transactionHash.toJSON());
    expect(requestJson.stateHash).toBe(commitment.authenticator.stateHash.toJSON());
  });
});
