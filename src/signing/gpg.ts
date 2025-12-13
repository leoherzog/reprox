import * as openpgp from 'openpgp';

/**
 * GPG Signing Module
 *
 * Uses openpgp.js to sign Release files for APT repository authentication.
 * APT requires either:
 * - InRelease: Cleartext signed Release file (inline signature)
 * - Release + Release.gpg: Detached signature
 */

/**
 * Sign content as cleartext (for InRelease file)
 * This creates an inline signature that can be verified without stripping
 */
export async function signCleartext(
  content: string,
  privateKeyArmored: string,
  passphrase?: string
): Promise<string> {
  // Read the private key
  let privateKey = await openpgp.readPrivateKey({
    armoredKey: privateKeyArmored,
  });

  // Decrypt if passphrase provided
  if (passphrase) {
    privateKey = await openpgp.decryptKey({
      privateKey,
      passphrase,
    });
  }

  // Create cleartext message
  const message = await openpgp.createCleartextMessage({
    text: content,
  });

  // Sign the message
  const signed = await openpgp.sign({
    message,
    signingKeys: privateKey,
  });

  return signed;
}

/**
 * Create a detached signature (for Release.gpg)
 */
export async function signDetached(
  content: string,
  privateKeyArmored: string,
  passphrase?: string
): Promise<string> {
  // Read the private key
  let privateKey = await openpgp.readPrivateKey({
    armoredKey: privateKeyArmored,
  });

  // Decrypt if passphrase provided
  if (passphrase) {
    privateKey = await openpgp.decryptKey({
      privateKey,
      passphrase,
    });
  }

  // Create message from text
  const message = await openpgp.createMessage({
    text: content,
  });

  // Create detached signature
  const signature = await openpgp.sign({
    message,
    signingKeys: privateKey,
    detached: true,
    format: 'armored',
  });

  return signature as string;
}

/**
 * Extract public key from private key
 */
export async function extractPublicKey(privateKeyArmored: string): Promise<string> {
  const privateKey = await openpgp.readPrivateKey({
    armoredKey: privateKeyArmored,
  });

  const publicKey = privateKey.toPublic();
  return publicKey.armor();
}

/**
 * Get key information from an armored key
 */
export async function getKeyInfo(armoredKey: string): Promise<{
  keyId: string;
  fingerprint: string;
  userIds: string[];
  creationTime: Date;
  expirationTime?: Date;
}> {
  let key: openpgp.Key;

  try {
    key = await openpgp.readPrivateKey({ armoredKey });
  } catch {
    key = await openpgp.readKey({ armoredKey });
  }

  const keyId = key.getKeyID().toHex().toUpperCase();
  const fingerprint = key.getFingerprint().toUpperCase();
  const userIds = key.getUserIDs();
  const creationTime = key.getCreationTime();

  // Get expiration time if set
  let expirationTime: Date | undefined;
  try {
    const expiration = await key.getExpirationTime();
    if (expiration && expiration !== Infinity) {
      expirationTime = expiration as Date;
    }
  } catch {
    // No expiration
  }

  return {
    keyId,
    fingerprint,
    userIds,
    creationTime,
    expirationTime,
  };
}

/**
 * Verify a cleartext signature
 */
export async function verifyCleartext(
  signedContent: string,
  publicKeyArmored: string
): Promise<{ verified: boolean; content: string }> {
  const publicKey = await openpgp.readKey({
    armoredKey: publicKeyArmored,
  });

  const message = await openpgp.readCleartextMessage({
    cleartextMessage: signedContent,
  });

  const verificationResult = await openpgp.verify({
    message,
    verificationKeys: publicKey,
  });

  const { verified } = verificationResult.signatures[0];

  try {
    await verified;
    return {
      verified: true,
      content: message.getText(),
    };
  } catch {
    return {
      verified: false,
      content: message.getText(),
    };
  }
}

/**
 * Generate a new GPG key pair for signing
 * This is useful for initial setup
 */
export async function generateKeyPair(
  name: string,
  email: string,
  passphrase?: string
): Promise<{ privateKey: string; publicKey: string }> {
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'rsa',
    rsaBits: 4096,
    userIDs: [{ name, email }],
    passphrase,
    format: 'armored',
  });

  return {
    privateKey: privateKey as string,
    publicKey: publicKey as string,
  };
}
