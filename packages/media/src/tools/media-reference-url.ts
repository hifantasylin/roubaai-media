/**
 * `media_reference_url` tool: turn a reference image that the media provider
 * cannot reach (a local file path, a host-local `/api/...` URL, or any value
 * that is not a public https URL) into a public https URL the provider can
 * fetch as a `refImages` / `imageUrls` entry.
 *
 * The model decides when to call this: when it wants to use a reference image
 * (an uploaded attachment, a local path, or an earlier generated image whose
 * URL is host-local) but the generation tool requires a reachable public URL,
 * it first calls this tool to obtain the public URL, then passes that URL into
 * `generate_image` / `generate_video`.
 *
 * @module @roubaai/media/tools/media-reference-url
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'

export const name = 'media_reference_url'

/** Extract the target URL from a Markdown image reference like `![alt](url)`. */
function extractMarkdownUrl(value: string): string | undefined {
  const match = /!\[[^\]]*\]\(([^)]+)\)/.exec(value)
  return match?.[1]
}

export function registerMediaReferenceUrl(ctx: Context): () => void {
  return ctx.tools.register(defineTool({
    name,
    description: 'Publish reference images as public https URLs for generate_image (refImages) / generate_video (imageUrls), which only accept public https. Call before using an attachment, host-local image, or local file as a reference. Pass each reference verbatim (Markdown image, bare /... URL, or local path); already-public https URLs pass through unchanged. Returns one URL per input, same order.',
    parameters: {
      references: {
        type: 'array',
        items: { type: 'string' },
        description: 'Reference images to publish (max 9). Each: verbatim Markdown image from context, bare host URL (/describe-image/raw/...), local path, or already-public https URL (returned unchanged).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          urls: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description: 'Public https URL for each input reference, in the same order.',
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: [
            `Published ${(value.urls ?? []).length} reference URL(s):`,
            ...(value.urls ?? []).map((url, i) => `${i + 1}. ${url}`),
            'Use these public URLs in `generate_image` (refImages) / `generate_video` (imageUrls).',
          ].join('\n'),
        },
      ],
    },
    // oxlint-disable-next-line typescript/require-await -- async matches the ToolDefinition.execute contract
    async execute(args, exec) {
      // The caller's workspace directory is used as the root for local file
      // references, so the tunnel serves from the current project (not a fixed
      // hard-coded path).
      const workspaceRoot = exec.agent?.session?.header?.cwd
      const urls = await Promise.all(
        (args.references ?? []).map(async (raw) => {
          // A reference is usually the full Markdown image the model has in
          // context (`![图片](/describe-image/raw/...)`); extract the URL and
          // normalize the underlying value.
          const ref = extractMarkdownUrl(raw) ?? raw
          return ctx.mediaUrl.normalize(ref, workspaceRoot)
        }),
      )
      return { urls }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: 'Publish reference image URL', kind: 'execute', rawInput: (args.references ?? []).join(', ') }
    },
  }))
}

export default registerMediaReferenceUrl
