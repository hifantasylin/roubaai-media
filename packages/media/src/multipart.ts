/**
 * A minimal `multipart/form-data` reader.
 *
 * The canvas sends its video and image-edit requests as multipart bodies (the
 * OpenAI video shape posts `prompt`/`model`/`seconds`/`size` plus `image[]`
 * files), and this package carries no HTTP framework to parse them with. The
 * parser is deliberately small and strict: it understands one boundary, the
 * `name`/`filename`/`content-type` headers of a part, and refuses a body whose
 * framing does not match its declared boundary instead of guessing.
 *
 * @module @roubaai/media/multipart
 */

/** One decoded part of a multipart body. */
export interface MultipartPart {
  /** The form field name from `Content-Disposition`. */
  readonly name: string
  /** The uploaded file name, when the part carries one. */
  readonly filename?: string
  /** The part's own content type, when it declared one. */
  readonly contentType?: string
  /** The raw part bytes. */
  readonly data: Buffer
}

/**
 * The boundary declared by a `Content-Type` header.
 * @param contentType - the request's content-type header.
 * @returns the boundary, or undefined when the request is not multipart.
 */
export function boundaryOf(contentType: string | undefined): string | undefined {
  if (contentType === undefined) return undefined
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  if (match === null) return undefined
  const value = (match[1] ?? match[2] ?? '').trim()
  return value === '' ? undefined : value
}

function headerValue(header: string, key: string): string | undefined {
  const match = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'im').exec(header)
  return match === null ? undefined : match[1]?.trim()
}

/** The quoted or bare value of one parameter in a `Content-Disposition` value. */
function dispositionParam(disposition: string, key: string): string | undefined {
  const match = new RegExp(`${key}\\s*=\\s*(?:"([^"]*)"|([^;]*))`, 'i').exec(disposition)
  if (match === null) return undefined
  const value = (match[1] ?? match[2] ?? '').trim()
  return value === '' ? undefined : value
}

/**
 * Decode a multipart body.
 * @param contentType - the request's content-type header (its boundary is used).
 * @param body - the whole request body.
 * @returns the decoded parts, in body order; an empty list when the body is not
 *   multipart or carries no part.
 */
export function parseMultipart(contentType: string | undefined, body: Buffer): MultipartPart[] {
  const boundary = boundaryOf(contentType)
  if (boundary === undefined) return []
  const delimiter = Buffer.from(`--${boundary}`, 'utf8')
  const parts: MultipartPart[] = []

  let cursor = body.indexOf(delimiter)
  if (cursor < 0) return []
  cursor += delimiter.length

  while (cursor < body.length) {
    // `--` right after a delimiter closes the body.
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) break
    // Skip the CRLF (or bare LF) that follows the delimiter.
    if (body[cursor] === 0x0d && body[cursor + 1] === 0x0a) cursor += 2
    else if (body[cursor] === 0x0a) cursor += 1

    const headerEnd = body.indexOf('\r\n\r\n', cursor)
    if (headerEnd < 0) break
    const header = body.subarray(cursor, headerEnd).toString('utf8')

    const next = body.indexOf(delimiter, headerEnd)
    if (next < 0) break
    // The CRLF before the next delimiter belongs to the framing, not the body.
    let dataEnd = next
    if (body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) dataEnd -= 2

    const disposition = headerValue(header, 'content-disposition') ?? ''
    const name = dispositionParam(disposition, 'name')
    if (name !== undefined) {
      const filename = dispositionParam(disposition, 'filename')
      const partType = headerValue(header, 'content-type')
      parts.push({
        name,
        ...(filename === undefined ? {} : { filename }),
        ...(partType === undefined ? {} : { contentType: partType }),
        data: body.subarray(headerEnd + 4, dataEnd),
      })
    }
    cursor = next + delimiter.length
  }

  return parts
}

/**
 * The first part with the given field name, as text.
 * @param parts - decoded parts.
 * @param name - the field name to read.
 * @returns the trimmed value, or undefined when the field is absent or empty.
 */
export function textField(parts: readonly MultipartPart[], name: string): string | undefined {
  const part = parts.find((candidate) => candidate.name === name && candidate.filename === undefined)
  if (part === undefined) return undefined
  const value = part.data.toString('utf8').trim()
  return value === '' ? undefined : value
}

/**
 * Every part with the given field name that carries a file.
 * @param parts - decoded parts.
 * @param name - the field name to read (matched with or without a `[]` suffix).
 * @returns the file parts, in body order.
 */
export function fileFields(parts: readonly MultipartPart[], name: string): MultipartPart[] {
  return parts.filter((part) => part.filename !== undefined && (part.name === name || part.name === `${name}[]`))
}
