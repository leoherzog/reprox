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
