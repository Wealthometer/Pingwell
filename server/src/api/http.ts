import type { FastifyReply, FastifyRequest } from "fastify"
import { z, type ZodTypeAny } from "zod"

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
  ) {
    super(message)
  }
}

export const notFound = (what = "Resource") => new HttpError(404, `${what} not found`)

/** Validates input with zod and turns failures into a 400 with field-level messages. */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data ?? {})
  if (!result.success) {
    const fields: Record<string, string> = {}
    for (const issue of result.error.issues) fields[issue.path.join(".") || "_"] ??= issue.message
    throw new HttpError(400, "Some fields are invalid", { fields })
  }
  return result.data
}

export const uuidParam = z.object({ id: z.string().uuid("Invalid id") })

export function userId(req: FastifyRequest): string {
  return (req.user as { sub: string }).sub
}

export type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>
