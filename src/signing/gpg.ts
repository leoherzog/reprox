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
 * Read (and optionally decrypt) an armored private key.
 */
async function loadPrivateKey(
  privateKeyArmored: string,
  passphrase?: string
): Promise<openpgp.PrivateKey> {
  const privateKey = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });
  if (passphrase) {
    return openpgp.decryptKey({ privateKey, passphrase });
  }
  return privateKey;
}

/**
 * Sign content as cleartext (for InRelease file)
 * This creates an inline signature that can be verified without stripping
 */
export async function signCleartext(
  content: string,
  privateKeyArmored: string,
  passphrase?: string
): Promise<string> {
  const privateKey = await loadPrivateKey(privateKeyArmored, passphrase);

  const message = await openpgp.createCleartextMessage({ text: content });

  return openpgp.sign({
    message,
    signingKeys: privateKey,
  });
}

/**
 * Create a detached text signature (for Release.gpg - APT)
 * Uses sigclass 0x01 (canonical text) for text file signing
 */
export async function signDetached(
  content: string,
  privateKeyArmored: string,
  passphrase?: string
): Promise<string> {
  const privateKey = await loadPrivateKey(privateKeyArmored, passphrase);

  const message = await openpgp.createMessage({ text: content });

  const signature = await openpgp.sign({
    message,
    signingKeys: privateKey,
    detached: true,
    format: 'armored',
  });

  return signature as string;
}

/**
 * Create a detached binary signature (for repomd.xml.asc - RPM/DNF)
 * Uses sigclass 0x00 (binary) which is required by rpm/dnf
 */
export async function signDetachedBinary(
  content: string,
  privateKeyArmored: string,
  passphrase?: string
): Promise<string> {
  const privateKey = await loadPrivateKey(privateKeyArmored, passphrase);

  // Create message as binary data (produces sigclass 0x00)
  const message = await openpgp.createMessage({
    binary: new TextEncoder().encode(content),
  });

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
 * Get key fingerprint from a private or public key
 * Returns fingerprint in human-readable format (uppercase, space-separated groups of 4)
 */
export async function getKeyFingerprint(armoredKey: string): Promise<string> {
  let key;
  if (armoredKey.includes('PRIVATE KEY')) {
    key = await openpgp.readPrivateKey({ armoredKey });
  } else {
    key = await openpgp.readKey({ armoredKey });
  }

  const fingerprint = key.getFingerprint().toUpperCase();
  // Format as groups of 4 characters separated by spaces
  return fingerprint.match(/.{1,4}/g)?.join(' ') ?? fingerprint;
}
