import { describe, it, expect, beforeAll } from 'vitest';
import * as openpgp from 'openpgp';
import { signCleartext, signDetached, extractPublicKey, getKeyFingerprint } from '../src/signing/gpg';

// ============================================================================
// Test Key Generation
// ============================================================================

let testPrivateKey: string;
let testPublicKey: string;

beforeAll(async () => {
  // Generate a test key pair (this is slow, so do it once)
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'rsa',
    rsaBits: 2048, // Smaller for faster tests
    userIDs: [{ name: 'Test User', email: 'test@example.com' }],
    format: 'armored',
  });

  testPrivateKey = privateKey;
  testPublicKey = publicKey;
});

// ============================================================================
// signCleartext Tests
// ============================================================================

describe('signCleartext', () => {
  it('creates a cleartext signed message', async () => {
    const content = 'Origin: test\nLabel: test\n';

    const signed = await signCleartext(content, testPrivateKey);

    expect(signed).toContain('-----BEGIN PGP SIGNED MESSAGE-----');
    expect(signed).toContain('-----BEGIN PGP SIGNATURE-----');
    expect(signed).toContain('-----END PGP SIGNATURE-----');
  });

  it('includes the original content', async () => {
    const content = 'Package: test\nVersion: 1.0\n';

    const signed = await signCleartext(content, testPrivateKey);

    expect(signed).toContain('Package: test');
    expect(signed).toContain('Version: 1.0');
  });

  it('includes hash armor header', async () => {
    const signed = await signCleartext('test content', testPrivateKey);

    expect(signed).toContain('Hash:');
  });

  it('signature can be verified', async () => {
    const content = 'Test content for verification';
    const signed = await signCleartext(content, testPrivateKey);

    // Verify the signature
    const publicKeyObj = await openpgp.readKey({ armoredKey: testPublicKey });
    const message = await openpgp.readCleartextMessage({ cleartextMessage: signed });

    const verificationResult = await openpgp.verify({
      message,
      verificationKeys: publicKeyObj,
    });

    const verification = await verificationResult.signatures[0].verified;
    expect(verification).toBe(true);
  });

  it('handles multi-line content', async () => {
    const content = `Origin: test/repo
Label: test
Suite: stable
Codename: stable
Description: Test repository

SHA256:
 abc123 1234 main/binary-amd64/Packages`;

    const signed = await signCleartext(content, testPrivateKey);

    expect(signed).toContain('-----BEGIN PGP SIGNED MESSAGE-----');
    expect(signed).toContain('Origin: test/repo');
  });
});

// ============================================================================
// signDetached Tests
// ============================================================================

describe('signDetached', () => {
  it('creates a detached signature', async () => {
    const content = 'Release file content';

    const signature = await signDetached(content, testPrivateKey);

    expect(signature).toContain('-----BEGIN PGP SIGNATURE-----');
    expect(signature).toContain('-----END PGP SIGNATURE-----');
  });

  it('does not include original content', async () => {
    const content = 'This is the original content';

    const signature = await signDetached(content, testPrivateKey);

    // Detached signature should not contain the original content
    expect(signature).not.toContain('This is the original content');
  });

  it('signature can verify original content', async () => {
    const content = 'Content to sign and verify';

    const signatureArmored = await signDetached(content, testPrivateKey);

    // Verify the detached signature
    const publicKeyObj = await openpgp.readKey({ armoredKey: testPublicKey });
    const message = await openpgp.createMessage({ text: content });
    const signature = await openpgp.readSignature({ armoredSignature: signatureArmored });

    const verificationResult = await openpgp.verify({
      message,
      signature,
      verificationKeys: publicKeyObj,
    });

    const verification = await verificationResult.signatures[0].verified;
    expect(verification).toBe(true);
  });

  it('signature fails for modified content', async () => {
    const content = 'Original content';
    const modifiedContent = 'Modified content';

    const signatureArmored = await signDetached(content, testPrivateKey);

    // Try to verify with modified content
    const publicKeyObj = await openpgp.readKey({ armoredKey: testPublicKey });
    const message = await openpgp.createMessage({ text: modifiedContent });
    const signature = await openpgp.readSignature({ armoredSignature: signatureArmored });

    const verificationResult = await openpgp.verify({
      message,
      signature,
      verificationKeys: publicKeyObj,
    });

    // This should fail verification
    await expect(verificationResult.signatures[0].verified)
      .rejects.toThrow();
  });
});

// ============================================================================
// extractPublicKey Tests
// ============================================================================

describe('extractPublicKey', () => {
  it('extracts public key from private key', async () => {
    const publicKey = await extractPublicKey(testPrivateKey);

    expect(publicKey).toContain('-----BEGIN PGP PUBLIC KEY BLOCK-----');
    expect(publicKey).toContain('-----END PGP PUBLIC KEY BLOCK-----');
  });

  it('does not include private key material', async () => {
    const publicKey = await extractPublicKey(testPrivateKey);

    expect(publicKey).not.toContain('-----BEGIN PGP PRIVATE KEY BLOCK-----');
    expect(publicKey).not.toContain('PRIVATE');
  });

  it('extracted public key can verify signatures', async () => {
    const content = 'Test content';
    const signed = await signCleartext(content, testPrivateKey);
    const extractedPublicKey = await extractPublicKey(testPrivateKey);

    // Verify using extracted public key
    const publicKeyObj = await openpgp.readKey({ armoredKey: extractedPublicKey });
    const message = await openpgp.readCleartextMessage({ cleartextMessage: signed });

    const verificationResult = await openpgp.verify({
      message,
      verificationKeys: publicKeyObj,
    });

    const verification = await verificationResult.signatures[0].verified;
    expect(verification).toBe(true);
  });

  it('returns valid armored key format', async () => {
    const publicKey = await extractPublicKey(testPrivateKey);

    // Should be parseable as a valid key
    const keyObj = await openpgp.readKey({ armoredKey: publicKey });
    expect(keyObj).toBeDefined();
    expect(keyObj.isPrivate()).toBe(false);
  });
});

// ============================================================================
// getKeyFingerprint Tests
// ============================================================================

describe('getKeyFingerprint', () => {
  it('extracts fingerprint from private key', async () => {
    const fingerprint = await getKeyFingerprint(testPrivateKey);

    // Fingerprint should be 40 hex chars (160 bits) with spaces
    expect(fingerprint).toMatch(/^[A-F0-9]{4}( [A-F0-9]{4}){9}$/);
  });

  it('extracts fingerprint from public key', async () => {
    const fingerprint = await getKeyFingerprint(testPublicKey);

    expect(fingerprint).toMatch(/^[A-F0-9]{4}( [A-F0-9]{4}){9}$/);
  });

  it('returns same fingerprint for private and public key', async () => {
    const privateFingerprint = await getKeyFingerprint(testPrivateKey);
    const publicFingerprint = await getKeyFingerprint(testPublicKey);

    expect(privateFingerprint).toBe(publicFingerprint);
  });

  it('formats fingerprint with spaces every 4 characters', async () => {
    const fingerprint = await getKeyFingerprint(testPrivateKey);
    const groups = fingerprint.split(' ');

    expect(groups).toHaveLength(10);
    groups.forEach(group => {
      expect(group).toHaveLength(4);
    });
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

describe('error handling', () => {
  it('throws on invalid private key', async () => {
    const invalidKey = '-----BEGIN PGP PRIVATE KEY BLOCK-----\ninvalid\n-----END PGP PRIVATE KEY BLOCK-----';

    await expect(signCleartext('content', invalidKey))
      .rejects.toThrow();
  });

  it('throws on malformed armored key', async () => {
    const malformedKey = 'not a valid key at all';

    await expect(signCleartext('content', malformedKey))
      .rejects.toThrow();
  });
});
