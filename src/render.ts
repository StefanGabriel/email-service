import Handlebars from 'handlebars';
import mjml2html from 'mjml';
import { ApiError } from './errors.js';

export type VariableSpec = { name: string; required?: boolean; sample?: unknown };

export type RenderInput = { subject: string; bodyMjml: string; bodyText?: string | null };
export type Rendered = { subject: string; html: string; text?: string };

// Plain-text parts (subject, text body) must not be HTML-escaped.
const plain = Handlebars.create();

export function missingVariables(specs: VariableSpec[], variables: Record<string, unknown>): string[] {
  return specs
    .filter((v) => v.required && (variables[v.name] === undefined || variables[v.name] === null || variables[v.name] === ''))
    .map((v) => v.name);
}

export function sampleVariables(specs: VariableSpec[]): Record<string, unknown> {
  return Object.fromEntries(specs.map((v) => [v.name, v.sample ?? `{{${v.name}}}`]));
}

export async function render(input: RenderInput, variables: Record<string, unknown>): Promise<Rendered> {
  let mjmlSource: string;
  try {
    mjmlSource = Handlebars.compile(input.bodyMjml, { strict: false })(variables);
  } catch (err) {
    throw new ApiError(422, 'template_error', `Template body failed to render: ${(err as Error).message}`);
  }
  const result = await mjml2html(mjmlSource, { validationLevel: 'soft' });
  if (!result.html) {
    throw new ApiError(422, 'template_error', 'Template body is not valid MJML', result.errors);
  }
  return {
    subject: plain.compile(input.subject, { noEscape: true })(variables).trim(),
    html: result.html,
    text: input.bodyText ? plain.compile(input.bodyText, { noEscape: true })(variables) : undefined,
  };
}

// Throws at save time so broken templates never reach the send path.
export function assertCompiles(input: RenderInput): void {
  for (const [part, source] of Object.entries(input)) {
    if (!source) continue;
    try {
      Handlebars.precompile(source);
    } catch (err) {
      throw new ApiError(422, 'template_error', `${part} has a syntax error: ${(err as Error).message}`);
    }
  }
}
