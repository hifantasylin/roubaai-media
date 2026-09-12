/**
 * The error one Ark provider raises when it cannot find a key anywhere. Shared
 * by the image and video providers so a caller's `instanceof` check holds
 * whichever Ark backend it reached, and so both report the same reference.
 * @module @roubaai/media-ark/errors
 */

/** Raised when neither the Settings page nor the credential store holds a key. */
export class MissingCredentialError extends Error {
  readonly code = 'MISSING_CREDENTIAL'
  constructor(reference: string) {
    super(`media-ark: no API key configured — set one on the RoubaAI settings page or provide ${reference}`)
    this.name = 'MissingCredentialError'
  }
}
