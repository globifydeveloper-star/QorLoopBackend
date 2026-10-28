import { applyDecorators, BadRequestException, type PipeTransform } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { z, type ZodTypeAny } from 'zod';

export class ZodPipe implements PipeTransform {
  constructor(private readonly schema: ZodTypeAny) {}
  transform(value: unknown) {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) throw new BadRequestException({ message: 'Validation failed', details: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) });
    return parsed.data;
  }
}
// Export the input contract, before normalization transforms.
function jsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: 'input' });
}
export const errorSchema = {
  type: 'object' as const, required: ['error', 'requestId'],
  properties: {
    requestId: { type: 'string' as const, format: 'uuid' },
    error: { type: 'object' as const, required: ['code', 'message'], properties: { code: { type: 'string' as const }, message: { type: 'string' as const }, details: { type: 'array' as const, items: { type: 'object' as const } } } },
  },
};
export function Contract(summary: string, body?: ZodTypeAny, response: Record<string, unknown> = { type: 'object', additionalProperties: true }) {
  return applyDecorators(
    ApiOperation({ summary }),
    ...(body ? [ApiBody({ schema: jsonSchema(body) })] : []),
    ApiResponse({ status: 200, schema: { type: 'object', required: ['data'], properties: { data: response } } }),
    ...[400, 401, 403, 404, 409, 429, 500, 503].map(status => ApiResponse({ status, schema: errorSchema })),
  );
}

