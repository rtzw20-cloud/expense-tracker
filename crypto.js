// Passcode-derived AES-GCM encryption. The key is non-extractable and only ever held in memory.

export const ITERATIONS = 600_000; // Above the required 310,000; matches current OWASP guidance.
const VERIFIER_ID = 'verifier';
const VERIFIER_TEXT = 'expense-tracker-verifier-v1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function deriveKey(passcode, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw', encoder.encode(passcode.normalize('NFKC')), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypts a JSON value with a fresh IV. The id is authenticated, so ciphertexts can't be swapped. */
export async function encrypt(key, id, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(id) },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return { id, iv, ct };
}

/** Decrypts a record from encrypt(). Rejects if the key is wrong or the record was altered. */
export async function decrypt(key, { id, iv, ct }) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(id) }, key, ct,
  );
  return JSON.parse(decoder.decode(plain));
}

/** First run: returns the key and the non-secret auth record to store. */
export async function createVault(passcode) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passcode, salt, ITERATIONS);
  const verifier = await encrypt(key, VERIFIER_ID, VERIFIER_TEXT);
  return { key, auth: { salt, iterations: ITERATIONS, verifier } };
}

/** Returns the key, or null if the passcode is wrong. */
export async function unlockVault(passcode, { salt, iterations, verifier }) {
  const key = await deriveKey(passcode, salt, iterations);
  try {
    return (await decrypt(key, verifier)) === VERIFIER_TEXT ? key : null;
  } catch {
    return null;
  }
}
