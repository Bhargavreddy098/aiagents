import { z } from 'zod';
import { PASSWORD_MIN_LENGTH } from '../types/auth.js';

/**
 * Emails are normalised (trim + lowercase) before storage and lookup, so
 * "Ada@Example.com" and "ada@example.com" are the same account.
 */
const email = z.string().trim().toLowerCase().email();

const password = z.string().min(PASSWORD_MIN_LENGTH, {
  message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
});

export const signupSchema = z.object({
  email,
  password,
  name: z.string().trim().min(1).max(120),
  tenantName: z.string().trim().min(1).max(120).optional(),
});

export const loginSchema = z.object({
  email,
  // no min length on login: an existing short password must still be attemptable,
  // and a length error here would leak whether a password meets policy.
  password: z.string().min(1),
});

export const passwordResetRequestSchema = z.object({
  email,
});

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(1),
  newPassword: password,
});

export const updateMeSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type PasswordResetRequestInput = z.infer<typeof passwordResetRequestSchema>;
export type PasswordResetConfirmInput = z.infer<typeof passwordResetConfirmSchema>;
export type UpdateMeInput = z.infer<typeof updateMeSchema>;
